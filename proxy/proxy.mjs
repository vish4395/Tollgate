// Forwards /v1/* to the backend after checking the project key and every limit, falls back to
// another Claude account when one is rate limited or signed out, and logs usage.
import { randomUUID } from "node:crypto";
import { originAllowed, originList } from "./cors.mjs";
import { hashKey } from "./db.mjs";
import { send, apiError, readBody, clientIp, HttpError } from "./http-util.mjs";
import { zoneStart } from "./time.mjs";

const USAGE_ZERO = () => ({
  in_tok: 0,
  out_tok: 0,
  cache_read: 0,
  cache_write: 0,
});

export function usageFromJson(o) {
  const u = o?.usage ?? {};
  // OpenAI-style prompt_tokens include cached tokens; Anthropic-style input_tokens don't.
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    in_tok: u.input_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - cached),
    out_tok: u.output_tokens ?? u.completion_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? cached,
    cache_write:
      u.cache_creation_input_tokens ??
      u.prompt_tokens_details?.cache_write_tokens ??
      0,
  };
}

/** Errors that mean "this account can't serve right now": try the next one. */
export function classify(status, type) {
  if (type === "rate_limit_error" || (status === 429 && !type))
    return "limited";
  if (status === 402 || type === "billing_error") return "limited";
  if (status === 401 || type === "authentication_error") return "signed_out";
  if (
    status >= 500 ||
    ["overloaded_error", "api_error", "timeout_error"].includes(type)
  )
    return "server";
  return null;
}

// Streams: keep only usage numbers, the stop reason and errors while the bytes pass through.
export function sseTracker() {
  const usage = USAGE_ZERO();
  let buf = "";
  const t = { usage, error: null, errorType: null, stopReason: null };
  t.push = (chunk) => {
    buf += Buffer.from(chunk).toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      if (!/usage|error|stop_reason|finish_reason/.test(data)) continue;
      try {
        const o = JSON.parse(data);
        if (o.type === "error" || o.error) {
          t.error =
            o.error?.message ?? JSON.stringify(o.error ?? o).slice(0, 500);
          t.errorType = o.error?.type ?? null;
        }
        t.stopReason =
          o.delta?.stop_reason ?? o.choices?.[0]?.finish_reason ?? t.stopReason;
        const u = o.message?.usage ?? o.usage;
        if (!u) continue;
        const p = usageFromJson({ usage: u });
        for (const k of Object.keys(usage)) if (p[k]) usage[k] = p[k];
      } catch {
        /* partial line */
      }
    }
    if (buf.length > 1_000_000) buf = "";
  };
  return t;
}

/** First real SSE event in a buffer: { type, error } or null while only pings have arrived. */
export function firstEvent(text) {
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("data:")) continue;
    const data = l.slice(5).trim();
    if (!data || data === "[DONE]") return { type: "done" };
    try {
      const o = JSON.parse(data);
      if (o.type === "error" || o.error)
        return { type: "error", error: o.error ?? o };
      return { type: o.type ?? "data" };
    } catch {
      return text.endsWith("\n") ? { type: "data" } : null; // incomplete line: wait for more
    }
  }
  return null;
}

export function createProxy({ cfg, db, upstream, accounts, events, alerts }) {
  // ---------- concurrency gate with a wait limit ----------
  let active = 0;
  const waiting = [];
  function acquire(signal) {
    if (active < cfg.maxConcurrent) {
      active++;
      return Promise.resolve();
    }
    if (waiting.length >= cfg.maxQueue)
      return Promise.reject(new HttpError(429, "queue full"));
    return new Promise((resolve, reject) => {
      const entry = {};
      const drop = (err) => {
        const i = waiting.indexOf(entry);
        if (i < 0) return;
        waiting.splice(i, 1);
        clearTimeout(entry.timer);
        reject(err);
      };
      entry.timer = setTimeout(
        () => drop(new HttpError(429, "queue timeout")),
        cfg.queueTimeoutMs,
      );
      signal?.addEventListener(
        "abort",
        () => drop(new HttpError(499, "client left")),
        { once: true },
      );
      entry.resolve = () => {
        clearTimeout(entry.timer);
        resolve();
      };
      waiting.push(entry);
    });
  }
  function release() {
    // A lower limit set at run time takes effect as slots free up.
    if (active > cfg.maxConcurrent) return void active--;
    const next = waiting.shift();
    if (next) next.resolve();
    else active--;
  }

  // ---------- per-minute counters, in-flight counts and bad-key blocking (in memory) ----------
  const minute = new Map(); // projectId -> timestamps
  const inflight = new Map(); // projectId -> requests not finished yet
  const badKeys = new Map(); // ip -> { n, since, blockedUntil }
  const rpmCount = (id) => {
    const t = Date.now();
    const list = (minute.get(id) ?? []).filter((x) => t - x < 60_000);
    if (list.length) minute.set(id, list);
    else minute.delete(id);
    return list;
  };
  const isBlocked = (ip) => (badKeys.get(ip)?.blockedUntil ?? 0) > Date.now();
  const noteBadKey = (ip) => {
    const t = Date.now();
    const b = badKeys.get(ip) ?? { n: 0, since: t, blockedUntil: 0 };
    if (t - b.since > 60_000) Object.assign(b, { n: 0, since: t });
    b.n++;
    if (b.n >= cfg.badKeyLimit) {
      Object.assign(b, { n: 0, blockedUntil: t + 10 * 60_000 });
      events.add(
        "ip_blocked",
        ip,
        `Blocked for 10 minutes after ${cfg.badKeyLimit} invalid keys`,
      );
    }
    badKeys.set(ip, b);
  };
  setInterval(() => {
    const t = Date.now();
    for (const [ip, b] of badKeys)
      if (b.blockedUntil < t && t - b.since > 60_000) badKeys.delete(ip);
    for (const id of [...minute.keys()]) rpmCount(id);
  }, 60_000).unref();

  // ---------- model settings ----------
  const modelRows = () => db.prepare("SELECT * FROM models").all();
  const aliasesOf = (r) =>
    (r?.aliases ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  function resolveModel(requested) {
    const want = String(requested || cfg.defaultModel).trim();
    const rows = modelRows();
    const byAlias = rows.find((r) => aliasesOf(r).includes(want.toLowerCase()));
    const id = byAlias?.id ?? want;
    return { id, row: rows.find((r) => r.id === id) ?? null };
  }
  /** A project's "allowed models" entry matches a model by exact id or by one of its aliases. */
  function modelAllowed(project, modelId, modelRow) {
    const allowed = String(project.allowed_models ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (!allowed.length) return true;
    const names = [modelId.toLowerCase(), ...aliasesOf(modelRow)];
    return allowed.some((a) => names.includes(a));
  }
  function priceFor(model) {
    const row = db
      .prepare("SELECT price_in, price_out FROM models WHERE id = ?")
      .get(String(model ?? ""));
    if (row?.price_in != null && row?.price_out != null)
      return { in: row.price_in, out: row.price_out };
    const m = String(model ?? "").toLowerCase();
    const fam = Object.keys(cfg.pricing).find((k) => m.includes(k));
    return fam ? cfg.pricing[fam] : null;
  }
  const costOf = (model, u) => {
    const p = priceFor(model);
    if (!p) return 0;
    return (
      (u.in_tok * p.in +
        u.cache_read * p.in * 0.1 +
        u.cache_write * p.in * 1.25 +
        u.out_tok * p.out) /
      1e6
    );
  };

  // ---------- logging ----------
  const insert = db.prepare(
    `INSERT INTO requests (project_id, ip, method, path, model, stream, status, failed, ms, queue_ms, ttfb_ms,
      in_tok, out_tok, cache_read, cache_write, cost, error, max_tokens, user_agent, account, attempts, request_id, stop_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const listeners = new Set();
  function log(r) {
    const failed = r.status >= 400 || !!r.error;
    try {
      insert.run(
        r.project_id ?? null,
        r.ip ?? null,
        r.method,
        r.path,
        r.model ?? null,
        r.stream ? 1 : 0,
        r.status,
        failed ? 1 : 0,
        r.ms ?? 0,
        r.queue_ms ?? 0,
        r.ttfb_ms ?? null,
        r.in_tok ?? 0,
        r.out_tok ?? 0,
        r.cache_read ?? 0,
        r.cache_write ?? 0,
        r.cost ?? 0,
        r.error ? String(r.error).slice(0, 2000) : null,
        r.max_tokens ?? null,
        r.user_agent ? String(r.user_agent).slice(0, 200) : null,
        r.account ?? null,
        r.attempts ?? null,
        r.request_id ?? null,
        r.stop_reason ?? null,
      );
    } catch (e) {
      console.error("log failed", e.message);
    }
    for (const fn of listeners) {
      try {
        fn({ ...r, failed });
      } catch (e) {
        console.error("request listener failed", e.message);
      }
    }
  }
  const usedSince = db.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(in_tok+out_tok+cache_read+cache_write),0) t
     FROM requests WHERE project_id = ? AND failed = 0 AND ts >= ? AND path != '/v1/messages/count_tokens'`,
  );

  function findProject(req) {
    const auth = String(req.headers.authorization ?? "");
    const key =
      req.headers["x-api-key"] ||
      (auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "");
    if (!key) return null;
    return (
      db
        .prepare("SELECT * FROM projects WHERE key_hash = ?")
        .get(hashKey(String(key))) ?? null
    );
  }
  const expired = (p) => p.expires_at && new Date(p.expires_at) < new Date();

  /** Model list for a project: only enabled models it may use. */
  async function modelsFor(project) {
    const list = await upstream.listModels();
    const rows = Object.fromEntries(modelRows().map((r) => [r.id, r]));
    return list
      .filter((m) => rows[m.id]?.enabled !== 0)
      .filter((m) => modelAllowed(project, m.id, rows[m.id]))
      .map((m) => ({
        id: m.id,
        type: "model",
        object: "model",
        display_name: m.name,
        created: m.createdAt,
        owned_by: "anthropic",
        context_window: m.contextWindow,
        ...(rows[m.id]?.max_tokens_cap
          ? { max_output_tokens: rows[m.id].max_tokens_cap }
          : {}),
      }));
  }

  /** Today's and this month's use, counting requests still running toward the request cap. */
  function usage(project) {
    const d = usedSince.get(project.id, zoneStart(cfg.timeZone, "day"));
    const m = usedSince.get(project.id, zoneStart(cfg.timeZone, "month"));
    return {
      dayN: d.n + (inflight.get(project.id) ?? 0),
      dayT: d.t,
      monthT: m.t,
    };
  }

  /** Every check that can refuse a request, in order. Returns [status, type, message] or null. */
  async function refusal(project, modelId, modelRow, countsTowardCaps) {
    if (!project.enabled)
      return [403, "permission_error", "This project key is disabled."];
    if (expired(project))
      return [403, "permission_error", "This project key has expired."];
    const known = await upstream.listModels();
    if (known.length && !known.some((m) => m.id === modelId))
      return [
        400,
        "invalid_request_error",
        `Unknown model: ${modelId}. GET /v1/models lists the models you can use.`,
      ];
    if (modelRow && !modelRow.enabled)
      return [403, "permission_error", `Model is turned off: ${modelId}`];
    if (!modelAllowed(project, modelId, modelRow))
      return [
        403,
        "permission_error",
        `Model not allowed for this project: ${modelId}`,
      ];
    if (!countsTowardCaps) return null;
    if (project.rpm_cap && rpmCount(project.id).length >= project.rpm_cap)
      return [
        429,
        "rate_limit_error",
        `Limit of ${project.rpm_cap} requests per minute reached.`,
      ];
    if (
      project.daily_request_cap ||
      project.daily_token_cap ||
      project.monthly_token_cap
    ) {
      const u = usage(project);
      if (project.daily_request_cap && u.dayN >= project.daily_request_cap)
        return [
          429,
          "rate_limit_error",
          "Daily request limit reached for this project.",
        ];
      if (project.daily_token_cap && u.dayT >= project.daily_token_cap)
        return [
          429,
          "rate_limit_error",
          "Daily token limit reached for this project.",
        ];
      if (project.monthly_token_cap && u.monthT >= project.monthly_token_cap)
        return [
          429,
          "rate_limit_error",
          "Monthly token limit reached for this project.",
        ];
    }
    return null;
  }

  /** Lower max_tokens to the project's and model's cap. */
  function clampMaxTokens(body, project, modelRow) {
    const caps = [project.max_tokens_cap, modelRow?.max_tokens_cap].filter(
      (n) => n > 0,
    );
    const field =
      "max_completion_tokens" in body ? "max_completion_tokens" : "max_tokens";
    if (!caps.length) return body[field] ?? null;
    const cap = Math.min(...caps);
    if (!(body[field] > 0) || body[field] > cap) body[field] = cap;
    return body[field];
  }

  /** Whether a project's 5-hour pause applies to an account. */
  function overProjectQuota(project, accountId) {
    if (!project.quota_cap_pct) return false;
    const q = accounts.quota(accountId ?? "default");
    return q?.fiveHour != null && q.fiveHour >= project.quota_cap_pct;
  }

  /**
   * Sends one attempt. Resolves to
   *   { kind: "ok", up, first, reader }  headers and the first event are in; nothing sent yet
   *   { kind: "retry", reason, ... }     this account can't serve; try another
   *   { kind: "final", up, text }        an error to pass to the client as is
   * Throws only when the request was aborted (client left or timeout).
   */
  async function attempt(path, payload, headers, signal) {
    let up;
    try {
      up = await fetch(cfg.upstream + path, {
        method: "POST",
        headers,
        body: payload,
        signal,
      });
    } catch (e) {
      if (signal.aborted) throw e;
      return {
        kind: "retry",
        reason: "server",
        status: 502,
        message: `Backend unreachable: ${e.cause?.code ?? e.message}`,
      };
    }
    const ctype = up.headers.get("content-type") ?? "";
    if (up.status >= 400) {
      const text = await up.text();
      let o = null;
      try {
        o = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      const type = o?.error?.type ?? null;
      const why = classify(up.status, type);
      const message = o?.error?.message ?? text.slice(0, 500);
      const retryAfter =
        Number(up.headers.get("retry-after")) || Number(o?.retry_after) || 0;
      if (why)
        return {
          kind: "retry",
          reason: why,
          status: up.status,
          type,
          message,
          retryAfter,
        };
      return { kind: "final", up, text };
    }
    if (!ctype.includes("event-stream") || !up.body)
      return { kind: "ok", up, first: [], reader: up.body?.getReader() };
    // Streams: wait for the first real event, so an account error can still fall back.
    const reader = up.body.getReader();
    const first = [];
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      first.push(value);
      text += Buffer.from(value).toString("utf8");
      const ev = firstEvent(text);
      if (!ev) {
        if (text.length > 256_000) break;
        continue;
      }
      if (ev.type === "error") {
        const type = ev.error?.type ?? null;
        const why = classify(0, type);
        if (why) {
          reader.cancel().catch(() => {});
          const status =
            why === "limited" ? 429 : why === "signed_out" ? 401 : 502;
          return {
            kind: "retry",
            reason: why,
            status,
            type,
            message: ev.error?.message ?? "Stream error",
            retryAfter: 0,
          };
        }
      }
      break;
    }
    return { kind: "ok", up, first, reader };
  }

  async function handle(req, res, path) {
    const started = Date.now();
    const ip = clientIp(req, cfg.trustedProxy);
    const requestId = randomUUID();
    res.setHeader("x-gateway-request-id", requestId);
    const row = {
      ip,
      method: req.method,
      path,
      user_agent: req.headers["user-agent"],
      request_id: requestId,
    };
    if (isBlocked(ip)) {
      log({
        ...row,
        status: 429,
        error: "Address blocked after too many invalid keys",
      });
      return apiError(
        res,
        429,
        "rate_limit_error",
        "Too many invalid keys from this address. Try again later.",
        { "retry-after": "600" },
      );
    }

    const project = findProject(req);
    if (!project) {
      noteBadKey(ip);
      log({ ...row, status: 401, error: "Missing or unknown API key" });
      return apiError(
        res,
        401,
        "authentication_error",
        "Missing or invalid API key.",
      );
    }
    row.project_id = project.id;

    // A browser call must come from an origin this project allows (its key is visible to that page).
    const origin = req.headers.origin;
    if (origin && !originAllowed(originList(project.allowed_origins), origin)) {
      log({ ...row, status: 403, error: `Origin not allowed: ${origin}` });
      return apiError(
        res,
        403,
        "permission_error",
        `Origin ${origin} is not allowed for this key. Add it under the project's allowed web origins.`,
      );
    }

    if (
      req.method === "GET" &&
      (path === "/v1/models" || path.startsWith("/v1/models/"))
    ) {
      if (!project.enabled || expired(project))
        return apiError(
          res,
          403,
          "permission_error",
          expired(project)
            ? "This project key has expired."
            : "This project key is disabled.",
        );
      const list = await modelsFor(project);
      if (path === "/v1/models")
        return send(res, 200, {
          object: "list",
          data: list,
          has_more: false,
          first_id: list[0]?.id ?? null,
          last_id: list.at(-1)?.id ?? null,
        });
      const one = list.find(
        (m) => m.id === decodeURIComponent(path.slice("/v1/models/".length)),
      );
      return one
        ? send(res, 200, one)
        : apiError(res, 404, "not_found_error", "Model not found.");
    }
    if (req.method !== "POST")
      return apiError(res, 405, "invalid_request_error", "Use POST.", {
        allow: "POST",
      });

    let body;
    try {
      const raw = (await readBody(req, cfg.maxBodyMb * 1_000_000)).toString(
        "utf8",
      );
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        throw new HttpError(400, "Body must be JSON.");
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new HttpError(400, "Body must be a JSON object.");
    } catch (e) {
      const status = e.status ?? 400;
      log({ ...row, status, error: e.message });
      if (status === 408) return; // connection already closed
      return apiError(
        res,
        status,
        status === 413 ? "request_too_large" : "invalid_request_error",
        e.message,
      );
    }
    const { id: modelId, row: modelRow } = resolveModel(body.model);
    body.model = modelId;
    row.model = modelId;
    row.stream = body.stream === true;
    const counts = path !== "/v1/messages/count_tokens";
    // OpenAI-style streams only report token use when asked to.
    if (row.stream && path === "/v1/chat/completions")
      body.stream_options = {
        ...(body.stream_options ?? {}),
        include_usage: true,
      };

    const refuse = await refusal(project, modelId, modelRow, counts);
    if (refuse) {
      log({ ...row, status: refuse[0], error: refuse[2] });
      alerts?.projectRefused(project, refuse[2]);
      return apiError(res, ...refuse);
    }
    if (counts) {
      row.max_tokens = clampMaxTokens(body, project, modelRow);
      minute.set(project.id, [...rpmCount(project.id), Date.now()]);
    }
    db.prepare(
      "UPDATE projects SET last_used_at = datetime('now') WHERE id = ?",
    ).run(project.id);

    // Abort everything when the client goes away.
    const ctrl = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) ctrl.abort(new HttpError(499, "client left"));
    });

    inflight.set(project.id, (inflight.get(project.id) ?? 0) + 1);
    const finished = () => {
      const n = (inflight.get(project.id) ?? 1) - 1;
      if (n > 0) inflight.set(project.id, n);
      else inflight.delete(project.id);
    };

    try {
      await acquire(ctrl.signal);
    } catch (e) {
      finished();
      if (e.status === 499)
        return log({
          ...row,
          status: 499,
          ms: Date.now() - started,
          error: "Client left while queued",
        });
      const timeout = e.message === "queue timeout";
      log({
        ...row,
        status: 429,
        ms: Date.now() - started,
        error: timeout ? "Waited too long in the queue" : "Queue full",
      });
      events.add(
        timeout ? "queue_timeout" : "queue_full",
        null,
        timeout
          ? "A request waited too long in the queue"
          : "A request was refused: queue full",
      );
      return apiError(
        res,
        429,
        "overloaded_error",
        timeout
          ? "The gateway is busy and the request waited too long. Try again shortly."
          : "The gateway queue is full. Try again shortly.",
        { "retry-after": "10" },
      );
    }
    row.queue_ms = Date.now() - started;

    const baseHeaders = {
      "content-type": "application/json",
      "x-api-key": cfg.internalKey,
    };
    for (const h of ["anthropic-version", "anthropic-beta"])
      if (req.headers[h]) baseHeaders[h] = req.headers[h];
    baseHeaders.accept = row.stream ? "text/event-stream" : "application/json";
    const payload = JSON.stringify(body);

    // Idle timer: aborts when the backend sends nothing for requestTimeoutMs.
    let idle;
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => ctrl.abort(new HttpError(504, "timeout")),
        cfg.requestTimeoutMs,
      );
    };
    const cleanup = () => {
      clearTimeout(idle);
      release();
      finished();
    };

    let result = null;
    let lastRetry = null;
    let tried = 0;
    try {
      const { list, why, retryAt } = accounts.candidates(project);
      const pool = list.filter((a) => !overProjectQuota(project, a.id));
      if (!pool.length) {
        cleanup();
        const msg = list.length
          ? `Paused: the 5-hour usage of every account this project may use is at or above ${project.quota_cap_pct}%.`
          : (why ?? "No Claude account is available.");
        const wait = retryAt
          ? Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))
          : 60;
        log({ ...row, status: 429, ms: Date.now() - started, error: msg });
        alerts?.noAccount(project, msg);
        return apiError(
          res,
          429,
          "rate_limit_error",
          msg +
            (retryAt
              ? ` The next account is free at ${new Date(retryAt).toISOString()}.`
              : ""),
          {
            "retry-after": String(wait),
          },
        );
      }
      let serverErrors = 0;
      for (const acct of pool) {
        tried++;
        row.account = acct.id;
        touch();
        const r = await attempt(
          path,
          payload,
          { ...baseHeaders, ...accounts.headerFor(acct.id) },
          ctrl.signal,
        );
        if (r.kind !== "retry") {
          result = r;
          break;
        }
        lastRetry = r;
        if (acct.id && r.reason === "limited") {
          const until = accounts.limited(acct.id, r.retryAfter, r.message);
          events.add(
            "fallback",
            acct.id,
            `Rate limited until ${new Date(until).toISOString()}`,
          );
        } else if (acct.id && r.reason === "signed_out") {
          accounts.signedOut(acct.id, r.message);
          events.add("fallback", acct.id, "Signed out");
        } else if (r.reason === "server" && ++serverErrors > 1) break; // one retry for backend errors
      }
    } catch {
      cleanup();
      const reason = ctrl.signal.reason;
      if (reason?.status === 499)
        return log({
          ...row,
          status: 499,
          attempts: tried,
          ms: Date.now() - started,
          error: "Client left before the reply",
        });
      log({
        ...row,
        status: 504,
        attempts: tried,
        ms: Date.now() - started,
        error: "Timed out waiting for the backend",
      });
      return apiError(res, 504, "timeout_error", "The request timed out.");
    }
    row.attempts = tried;

    if (!result) {
      cleanup();
      const r = lastRetry;
      const status =
        r.reason === "limited"
          ? 429
          : r.reason === "signed_out"
            ? 503
            : r.status;
      const message =
        r.reason === "limited"
          ? tried > 1
            ? `All ${tried} accounts tried are rate limited. ${r.message}`
            : r.message
          : r.reason === "signed_out"
            ? "The Claude account is signed out. Sign in again on the gateway computer."
            : r.message;
      log({ ...row, status, ms: Date.now() - started, error: message });
      if (r.reason !== "server") alerts?.noAccount(project, message);
      return apiError(
        res,
        status,
        r.type ?? (r.reason === "limited" ? "rate_limit_error" : "api_error"),
        message,
        r.retryAfter ? { "retry-after": String(r.retryAfter) } : {},
      );
    }
    if (row.account) {
      accounts.used(row.account);
      accounts.ok(row.account);
    }

    // ---------- send the reply ----------
    const up = result.up;
    const ctype = up.headers.get("content-type") ?? "application/json";
    const outHeaders = { "content-type": ctype };
    for (const h of ["retry-after", "request-id", "x-request-id"]) {
      const v = up.headers.get(h);
      if (v) outHeaders[h] = v;
    }
    if (ctype.includes("event-stream"))
      Object.assign(outHeaders, {
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      });
    res.writeHead(up.status, outHeaders);

    const tracker = ctype.includes("event-stream") ? sseTracker() : null;
    const chunks = [];
    let size = 0;
    let error = null;
    const take = (chunk) => {
      row.ttfb_ms ??= Date.now() - started;
      if (!res.destroyed) res.write(chunk);
      if (tracker) tracker.push(chunk);
      else if ((size += chunk.length) <= 20_000_000)
        chunks.push(Buffer.from(chunk));
    };
    try {
      if (result.kind === "final") take(Buffer.from(result.text));
      else {
        for (const c of result.first) take(c);
        while (result.reader) {
          touch();
          const { value, done } = await result.reader.read();
          if (done) break;
          take(value);
        }
      }
    } catch (e) {
      const reason = ctrl.signal.reason;
      error =
        reason?.status === 499
          ? "Client left during the reply"
          : reason?.status === 504
            ? "The backend went quiet; the reply was cut off"
            : `Stream interrupted: ${e.message}`;
    } finally {
      res.end();
      cleanup();
    }

    let used = USAGE_ZERO();
    if (tracker) {
      used = tracker.usage;
      error ??= tracker.error;
      row.stop_reason = tracker.stopReason;
    } else {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        const o = JSON.parse(text);
        used = usageFromJson(o);
        row.stop_reason =
          o.stop_reason ?? o.choices?.[0]?.finish_reason ?? null;
        if (up.status >= 400) error ??= o?.error?.message ?? text.slice(0, 500);
      } catch {
        if (up.status >= 400) error ??= text.slice(0, 500);
      }
    }
    log({
      ...row,
      status: up.status,
      ms: Date.now() - started,
      ...used,
      cost: costOf(modelId, used),
      error,
    });
  }

  return {
    handle,
    log,
    costOf,
    onRequest: (fn) => listeners.add(fn),
    usage,
    stats: () => ({
      active,
      queued: waiting.length,
      blockedIps: [...badKeys]
        .filter(([, b]) => b.blockedUntil > Date.now())
        .map(([ip, b]) => ({
          ip,
          until: new Date(b.blockedUntil).toISOString(),
        })),
    }),
    unblock: (ip) => badKeys.delete(ip),
    acquire,
    release,
  };
}
