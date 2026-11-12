// Forwards /v1/* to Meridian after checking the project key and every limit, and logs usage.
import { hashKey } from "./db.mjs";
import { send, apiError, readBody, clientIp } from "./http-util.mjs";

const USAGE_ZERO = () => ({
  in_tok: 0,
  out_tok: 0,
  cache_read: 0,
  cache_write: 0,
});

export function usageFromJson(o) {
  const u = o?.usage ?? {};
  return {
    in_tok: u.input_tokens ?? u.prompt_tokens ?? 0,
    out_tok: u.output_tokens ?? u.completion_tokens ?? 0,
    cache_read:
      u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
    cache_write: u.cache_creation_input_tokens ?? 0,
  };
}

// Streams: keep only usage numbers and errors while the bytes pass through.
function sseTracker() {
  const usage = USAGE_ZERO();
  let buf = "";
  let error = null;
  return {
    usage,
    get error() {
      return error;
    },
    push(chunk) {
      buf += Buffer.from(chunk).toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (
          !data ||
          data === "[DONE]" ||
          (!data.includes("usage") && !data.includes("error"))
        )
          continue;
        try {
          const o = JSON.parse(data);
          if (o.type === "error" || o.error)
            error =
              o.error?.message ?? JSON.stringify(o.error ?? o).slice(0, 500);
          const u = o.message?.usage ?? o.usage;
          if (!u) continue;
          const p = usageFromJson({ usage: u });
          for (const k of Object.keys(usage)) if (p[k]) usage[k] = p[k];
        } catch {
          /* partial line */
        }
      }
      if (buf.length > 1_000_000) buf = "";
    },
  };
}

export function createProxy({ cfg, db, upstream }) {
  // ---------- concurrency gate ----------
  let active = 0;
  const waiting = [];
  const acquire = () => {
    if (active < cfg.maxConcurrent) {
      active++;
      return Promise.resolve();
    }
    if (waiting.length >= cfg.maxQueue)
      return Promise.reject(new Error("queue full"));
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  // ---------- per-minute counters and bad-key blocking (in memory) ----------
  const minute = new Map(); // projectId -> timestamps
  const badKeys = new Map(); // ip -> { n, since, blockedUntil }
  const rpmCount = (id) => {
    const now = Date.now();
    const list = (minute.get(id) ?? []).filter((t) => now - t < 60_000);
    minute.set(id, list);
    return list;
  };
  const isBlocked = (ip) => (badKeys.get(ip)?.blockedUntil ?? 0) > Date.now();
  const noteBadKey = (ip) => {
    const now = Date.now();
    const b = badKeys.get(ip) ?? { n: 0, since: now, blockedUntil: 0 };
    if (now - b.since > 60_000) Object.assign(b, { n: 0, since: now });
    b.n++;
    if (b.n >= cfg.badKeyLimit)
      Object.assign(b, { n: 0, blockedUntil: now + 10 * 60_000 });
    badKeys.set(ip, b);
  };

  // ---------- model settings ----------
  const modelRows = () => db.prepare("SELECT * FROM models").all();
  function resolveModel(requested) {
    const want = String(requested || cfg.defaultModel).trim();
    const rows = modelRows();
    const byAlias = rows.find((r) =>
      (r.aliases ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .includes(want.toLowerCase()),
    );
    const id = byAlias?.id ?? want;
    return { id, row: rows.find((r) => r.id === id) ?? null };
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
    `INSERT INTO requests (project_id, ip, method, path, model, stream, status, ms, queue_ms, ttfb_ms,
      in_tok, out_tok, cache_read, cache_write, cost, error, max_tokens, user_agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  function log(r) {
    try {
      insert.run(
        r.project_id ?? null,
        r.ip ?? null,
        r.method,
        r.path,
        r.model ?? null,
        r.stream ? 1 : 0,
        r.status,
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
      );
    } catch (e) {
      console.error("log failed", e);
    }
  }
  const usedSince = db.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(in_tok+out_tok+cache_read+cache_write),0) t
     FROM requests WHERE project_id = ? AND status < 400 AND ts >= ?`,
  );
  const startOfDay = () => new Date().toISOString().slice(0, 10) + "T00:00:00Z";
  const startOfMonth = () =>
    new Date().toISOString().slice(0, 7) + "-01T00:00:00Z";

  function findProject(req) {
    const auth = req.headers.authorization ?? "";
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

  /** Model list for a project: only enabled models it may use. */
  async function modelsFor(project) {
    const list = await upstream.listModels();
    const rows = Object.fromEntries(modelRows().map((r) => [r.id, r]));
    const allowed = (project.allowed_models ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list
      .filter((m) => rows[m.id]?.enabled !== 0)
      .filter((m) => !allowed.length || allowed.some((a) => m.id.includes(a)))
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

  /** Every check that can refuse a request, in order. Returns [status, type, message] or null. */
  async function refusal(project, modelId, modelRow) {
    if (!project.enabled)
      return [403, "permission_error", "This project key is disabled."];
    if (project.expires_at && new Date(project.expires_at) < new Date())
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
    const allowed = (project.allowed_models ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allowed.length && !allowed.some((a) => modelId.includes(a)))
      return [
        403,
        "permission_error",
        `Model not allowed for this project: ${modelId}`,
      ];
    if (project.rpm_cap && rpmCount(project.id).length >= project.rpm_cap)
      return [
        429,
        "rate_limit_error",
        `Limit of ${project.rpm_cap} requests per minute reached.`,
      ];
    if (project.daily_request_cap || project.daily_token_cap) {
      const d = usedSince.get(project.id, startOfDay());
      if (project.daily_request_cap && d.n >= project.daily_request_cap)
        return [
          429,
          "rate_limit_error",
          "Daily request limit reached for this project.",
        ];
      if (project.daily_token_cap && d.t >= project.daily_token_cap)
        return [
          429,
          "rate_limit_error",
          "Daily token limit reached for this project.",
        ];
    }
    if (project.monthly_token_cap) {
      const m = usedSince.get(project.id, startOfMonth());
      if (m.t >= project.monthly_token_cap)
        return [
          429,
          "rate_limit_error",
          "Monthly token limit reached for this project.",
        ];
    }
    if (project.quota_cap_pct) {
      const pct = await upstream.fiveHourPct();
      if (pct != null && pct >= project.quota_cap_pct)
        return [
          429,
          "rate_limit_error",
          `Paused: the subscription's 5-hour usage is at ${pct}% (this project stops at ${project.quota_cap_pct}%).`,
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

  async function handle(req, res, path) {
    const started = Date.now();
    const ip = clientIp(req);
    const row = {
      ip,
      method: req.method,
      path,
      user_agent: req.headers["user-agent"],
    };
    if (isBlocked(ip))
      return apiError(
        res,
        429,
        "rate_limit_error",
        "Too many invalid keys from this address. Try again later.",
      );

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

    if (
      req.method === "GET" &&
      (path === "/v1/models" || path.startsWith("/v1/models/"))
    ) {
      if (!project.enabled)
        return apiError(
          res,
          403,
          "permission_error",
          "This project key is disabled.",
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
      return apiError(res, 405, "invalid_request_error", "Use POST.");

    let body;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch (e) {
      log({ ...row, status: 400, error: e.message });
      return apiError(res, 400, "invalid_request_error", "Body must be JSON.");
    }
    const { id: modelId, row: modelRow } = resolveModel(body.model);
    body.model = modelId;
    row.model = modelId;
    row.stream = body.stream === true;

    const refuse = await refusal(project, modelId, modelRow);
    if (refuse) {
      log({ ...row, status: refuse[0], error: refuse[2] });
      return apiError(res, ...refuse);
    }
    if (path !== "/v1/messages/count_tokens")
      row.max_tokens = clampMaxTokens(body, project, modelRow);
    rpmCount(project.id).push(Date.now());
    db.prepare(
      "UPDATE projects SET last_used_at = datetime('now') WHERE id = ?",
    ).run(project.id);

    try {
      await acquire();
    } catch {
      log({ ...row, status: 429, error: "Queue full" });
      return apiError(
        res,
        429,
        "overloaded_error",
        "The gateway queue is full. Try again shortly.",
      );
    }
    row.queue_ms = Date.now() - started;

    const headers = {
      "content-type": "application/json",
      "x-api-key": cfg.internalKey,
      authorization: `Bearer ${cfg.internalKey}`,
    };
    for (const h of ["anthropic-version", "anthropic-beta", "accept"])
      if (req.headers[h]) headers[h] = req.headers[h];

    let up;
    try {
      up = await fetch(cfg.upstream + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.requestTimeoutMs),
      });
    } catch (e) {
      release();
      const timedOut = e.name === "TimeoutError";
      log({
        ...row,
        status: timedOut ? 504 : 502,
        ms: Date.now() - started,
        error: timedOut ? "Timed out" : `Backend unreachable: ${e.message}`,
      });
      return apiError(
        res,
        timedOut ? 504 : 502,
        "api_error",
        timedOut
          ? "The request timed out."
          : "The Claude backend is not reachable.",
      );
    }

    const ctype = up.headers.get("content-type") ?? "application/json";
    res.writeHead(up.status, { "content-type": ctype });
    const tracker = ctype.includes("event-stream") ? sseTracker() : null;
    const chunks = [];
    let error = null;
    let closed = false;
    res.on("close", () => (closed = true));
    try {
      for await (const chunk of up.body ?? []) {
        row.ttfb_ms ??= Date.now() - started;
        if (!closed) res.write(chunk);
        if (tracker) tracker.push(chunk);
        else if (chunks.length < 4000) chunks.push(Buffer.from(chunk));
      }
    } catch (e) {
      error = `Stream interrupted: ${e.message}`;
    } finally {
      res.end();
      release();
    }

    let usage = USAGE_ZERO();
    if (tracker) {
      usage = tracker.usage;
      error ??= tracker.error;
    } else {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        const o = JSON.parse(text);
        usage = usageFromJson(o);
        if (up.status >= 400) error ??= o?.error?.message ?? text.slice(0, 500);
      } catch {
        if (up.status >= 400) error ??= text.slice(0, 500);
      }
    }
    if (closed && !error && !tracker) error = null;
    log({
      ...row,
      status: up.status,
      ms: Date.now() - started,
      ...usage,
      cost: costOf(modelId, usage),
      error,
    });
  }

  return {
    handle,
    log,
    costOf,
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
  };
}
