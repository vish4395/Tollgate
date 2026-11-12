// Claude gateway key proxy: per-project API keys and usage tracking in front of Meridian.
// Plain Node 22, no npm dependencies.
import http from "node:http";
import https from "node:https";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { openDb, hashKey, newKey } from "./db.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = join(ROOT, "config.json");
const STARTED = Date.now();

// ---------- config ----------
function loadConfig() {
  const defaults = {
    host: "0.0.0.0",
    port: 4100,
    publicHost: lanIp() ?? "localhost",
    upstream: "http://127.0.0.1:4101",
    maxConcurrent: 2,
    maxQueue: 20,
    requestTimeoutMs: 180000,
    retentionDays: 30,
    defaultModel: "claude-haiku-5-5",
    // Estimated API-equivalent prices, USD per million tokens. Edit to taste.
    pricing: {
      haiku: { in: 1, out: 5 },
      sonnet: { in: 3, out: 15 },
      opus: { in: 5, out: 25 },
      fable: { in: 5, out: 25 },
    },
  };
  let cfg = existsSync(CONFIG_FILE)
    ? JSON.parse(readFileSync(CONFIG_FILE, "utf8"))
    : {};
  cfg = { ...defaults, ...cfg };
  let changed = !existsSync(CONFIG_FILE);
  if (!cfg.internalKey) {
    const f = join(ROOT, ".internal-key");
    cfg.internalKey = existsSync(f)
      ? readFileSync(f, "utf8").trim()
      : randomBytes(24).toString("hex");
    changed = true;
  }
  if (!cfg.sessionSecret) {
    cfg.sessionSecret = randomBytes(32).toString("hex");
    changed = true;
  }
  if (!cfg.adminPasswordHash) {
    const pw = randomBytes(9).toString("base64url");
    cfg.adminPasswordHash = hashPassword(pw);
    const f = join(ROOT, "ADMIN_PASSWORD.txt");
    writeFileSync(f, `${pw}\n`);
    chmodSync(f, 0o600);
    console.log(`Admin password written to ${f}`);
    changed = true;
  }
  if (changed) saveConfig(cfg);
  return cfg;
}
function saveConfig(c) {
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2) + "\n");
  chmodSync(CONFIG_FILE, 0o600);
}
function lanIp() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === "IPv4" && !a.internal) return a.address;
  return null;
}
function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(pw, salt, 32).toString("hex")}`;
}
function checkPassword(pw, stored) {
  const [salt, hex] = stored.split(":");
  const a = scryptSync(String(pw), salt, 32);
  return timingSafeEqual(a, Buffer.from(hex, "hex"));
}

const cfg = loadConfig();
const CERT = join(ROOT, "certs/gateway.pem");
const CERT_KEY = join(ROOT, "certs/gateway-key.pem");
const TLS =
  existsSync(CERT) && existsSync(CERT_KEY)
    ? { cert: readFileSync(CERT), key: readFileSync(CERT_KEY) }
    : null;
const SCHEME = TLS ? "https" : "http";
cfg.httpPort ??= 4180;
const db = openDb(join(ROOT, "gateway.db"));

// ---------- CLI ----------
const [cmd, ...args] = process.argv.slice(2);
if (cmd === "set-password") {
  if (!args[0]) throw new Error("Usage: set-password <new password>");
  cfg.adminPasswordHash = hashPassword(args[0]);
  saveConfig(cfg);
  console.log("Admin password changed.");
  process.exit(0);
}
if (cmd === "add-project") {
  if (!args[0]) throw new Error("Usage: add-project <name>");
  const k = newKey();
  db.prepare(
    "INSERT INTO projects (name, key_prefix, key_hash) VALUES (?, ?, ?)",
  ).run(args[0], k.prefix, k.hash);
  console.log(`Project "${args[0]}" key: ${k.key}`);
  process.exit(0);
}

// ---------- helpers ----------
const send = (res, status, body, headers = {}) => {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type":
      typeof body === "string" ? "text/plain" : "application/json",
    ...headers,
  });
  res.end(data);
};
const apiError = (res, status, type, message) =>
  send(res, status, { type: "error", error: { type, message } });

function readBody(req, limit = 20_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const clientIp = (req) =>
  (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");

function priceFor(model) {
  const m = String(model ?? "").toLowerCase();
  const key = Object.keys(cfg.pricing).find((k) => m.includes(k));
  return key ? cfg.pricing[key] : null;
}
function costOf(model, u) {
  const p = priceFor(model);
  if (!p) return 0;
  return (
    ((u.in_tok ?? 0) * p.in +
      (u.cache_read ?? 0) * p.in * 0.1 +
      (u.cache_write ?? 0) * p.in * 1.25 +
      (u.out_tok ?? 0) * p.out) /
    1e6
  );
}

// ---------- concurrency gate ----------
let active = 0;
const waiting = [];
function acquire() {
  if (active < cfg.maxConcurrent) {
    active++;
    return Promise.resolve();
  }
  if (waiting.length >= cfg.maxQueue)
    return Promise.reject(new Error("queue full"));
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

// ---------- usage parsing ----------
function usageFromJson(o) {
  const u = o?.usage ?? {};
  return {
    in_tok: u.input_tokens ?? u.prompt_tokens ?? 0,
    out_tok: u.output_tokens ?? u.completion_tokens ?? 0,
    cache_read:
      u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
    cache_write: u.cache_creation_input_tokens ?? 0,
  };
}
// Streams: keep only usage numbers while the bytes pass through.
function sseUsageTracker() {
  const usage = { in_tok: 0, out_tok: 0, cache_read: 0, cache_write: 0 };
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
          /* ignore partial lines */
        }
      }
      if (buf.length > 1_000_000) buf = "";
    },
  };
}

function logRequest(row) {
  try {
    db.prepare(
      `INSERT INTO requests (project_id, ip, method, path, model, stream, status, ms, queue_ms,
        in_tok, out_tok, cache_read, cache_write, cost, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.project_id ?? null,
      row.ip ?? null,
      row.method,
      row.path,
      row.model ?? null,
      row.stream ? 1 : 0,
      row.status,
      row.ms ?? 0,
      row.queue_ms ?? 0,
      row.in_tok ?? 0,
      row.out_tok ?? 0,
      row.cache_read ?? 0,
      row.cache_write ?? 0,
      row.cost ?? 0,
      row.error ? String(row.error).slice(0, 2000) : null,
    );
  } catch (e) {
    console.error("log failed", e);
  }
}

// ---------- API proxy ----------
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

function todayUsage(projectId) {
  return db
    .prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(in_tok+out_tok+cache_read+cache_write),0) t
       FROM requests WHERE project_id = ? AND ts >= strftime('%Y-%m-%dT00:00:00Z','now')`,
    )
    .get(projectId);
}

async function proxyApi(req, res, path) {
  const started = Date.now();
  const row = { ip: clientIp(req), method: req.method, path };
  const project = findProject(req);
  if (!project) {
    logRequest({ ...row, status: 401, error: "Missing or unknown API key" });
    return apiError(
      res,
      401,
      "authentication_error",
      "Missing or invalid API key.",
    );
  }
  row.project_id = project.id;
  if (!project.enabled) {
    logRequest({ ...row, status: 403, error: "Project disabled" });
    return apiError(
      res,
      403,
      "permission_error",
      "This project key is disabled.",
    );
  }

  let body = Buffer.alloc(0);
  let parsed = null;
  if (req.method === "POST") {
    try {
      body = await readBody(req);
      parsed = JSON.parse(body.toString("utf8") || "{}");
    } catch (e) {
      logRequest({ ...row, status: 400, error: e.message });
      return apiError(res, 400, "invalid_request_error", "Body must be JSON.");
    }
    row.model = parsed.model;
    row.stream = parsed.stream === true;
    const allowed = (project.allowed_models ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (
      allowed.length &&
      !allowed.some((m) => String(parsed.model ?? "").includes(m))
    ) {
      logRequest({
        ...row,
        status: 403,
        error: `Model not allowed: ${parsed.model}`,
      });
      return apiError(
        res,
        403,
        "permission_error",
        `Model not allowed for this project: ${parsed.model}`,
      );
    }
    const t = todayUsage(project.id);
    if (project.daily_request_cap && t.n >= project.daily_request_cap) {
      logRequest({ ...row, status: 429, error: "Daily request cap reached" });
      return apiError(
        res,
        429,
        "rate_limit_error",
        "Daily request cap reached for this project.",
      );
    }
    if (project.daily_token_cap && t.t >= project.daily_token_cap) {
      logRequest({ ...row, status: 429, error: "Daily token cap reached" });
      return apiError(
        res,
        429,
        "rate_limit_error",
        "Daily token cap reached for this project.",
      );
    }
  }
  db.prepare(
    "UPDATE projects SET last_used_at = datetime('now') WHERE id = ?",
  ).run(project.id);

  const gated = req.method === "POST";
  if (gated) {
    try {
      await acquire();
    } catch {
      logRequest({ ...row, status: 429, error: "Queue full" });
      return apiError(
        res,
        429,
        "overloaded_error",
        "Gateway queue is full. Try again shortly.",
      );
    }
  }
  row.queue_ms = Date.now() - started;

  const headers = {};
  for (const h of [
    "content-type",
    "anthropic-version",
    "anthropic-beta",
    "accept",
  ])
    if (req.headers[h]) headers[h] = req.headers[h];
  headers["x-api-key"] = cfg.internalKey;
  headers.authorization = `Bearer ${cfg.internalKey}`;

  let upstream;
  try {
    upstream = await fetch(
      cfg.upstream +
        path +
        (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""),
      {
        method: req.method,
        headers,
        body: req.method === "POST" ? body : undefined,
        signal: AbortSignal.timeout(cfg.requestTimeoutMs),
      },
    );
  } catch (e) {
    if (gated) release();
    logRequest({
      ...row,
      status: 502,
      ms: Date.now() - started,
      error: `Upstream unreachable: ${e.message}`,
    });
    return apiError(
      res,
      502,
      "api_error",
      "The Claude backend is not reachable.",
    );
  }

  const ctype = upstream.headers.get("content-type") ?? "application/json";
  res.writeHead(upstream.status, { "content-type": ctype });
  const isSse = ctype.includes("event-stream");
  const tracker = isSse ? sseUsageTracker() : null;
  const chunks = [];
  let error = null;
  try {
    for await (const chunk of upstream.body ?? []) {
      res.write(chunk);
      if (tracker) tracker.push(chunk);
      else if (chunks.length < 2000) chunks.push(chunk);
    }
  } catch (e) {
    error = `Stream interrupted: ${e.message}`;
  } finally {
    res.end();
    if (gated) release();
  }

  let usage = { in_tok: 0, out_tok: 0, cache_read: 0, cache_write: 0 };
  if (tracker) {
    usage = tracker.usage;
    error ??= tracker.error;
  } else if (req.method === "POST") {
    try {
      const o = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      usage = usageFromJson(o);
      if (upstream.status >= 400)
        error ??= o?.error?.message ?? JSON.stringify(o).slice(0, 500);
    } catch {
      if (upstream.status >= 400)
        error ??= Buffer.concat(chunks).toString("utf8").slice(0, 500);
    }
  }
  if (req.method === "GET" && upstream.status < 400) return; // model lists etc. are not logged
  logRequest({
    ...row,
    status: upstream.status,
    ms: Date.now() - started,
    ...usage,
    cost: costOf(row.model, usage),
    error,
  });
}

// ---------- admin ----------
const sign = (v) =>
  createHmac("sha256", cfg.sessionSecret).update(v).digest("base64url");
function makeSession() {
  const exp = String(Date.now() + 7 * 864e5);
  return `${exp}.${sign(exp)}`;
}
function isAdmin(req) {
  const m = /(?:^|;\s*)cgw_admin=([^;]+)/.exec(req.headers.cookie ?? "");
  if (!m) return false;
  const [exp, sig] = m[1].split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sign(exp));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}
const loginFails = new Map();

function psList() {
  return new Promise((resolve) =>
    execFile(
      "ps",
      ["-axo", "pid=,ppid=,rss=,command="],
      { maxBuffer: 8e6 },
      (err, out) => {
        if (err) return resolve([]);
        resolve(
          out
            .split("\n")
            .filter(Boolean)
            .map((l) => {
              const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l);
              return m
                ? { pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] }
                : null;
            })
            .filter(Boolean),
        );
      },
    ),
  );
}
async function memory() {
  const procs = await psList();
  const root = procs.find(
    (p) =>
      /meridian\/node_modules\/(\.bin\/meridian|@rynfar\/meridian\/dist\/cli)/.test(
        p.cmd,
      ) && !/grep|pgrep/.test(p.cmd),
  );
  let meridianKb = 0;
  let cliCount = 0;
  if (root) {
    const ids = new Set([root.pid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of procs)
        if (!ids.has(p.pid) && ids.has(p.ppid)) {
          ids.add(p.pid);
          grew = true;
        }
    }
    for (const p of procs)
      if (ids.has(p.pid)) {
        meridianKb += p.rss;
        if (p.pid !== root.pid && /claude/.test(p.cmd)) cliCount++;
      }
  }
  return {
    proxyMb: Math.round(process.memoryUsage().rss / 1048576),
    meridianMb: Math.round(meridianKb / 1024),
    meridianPid: root?.pid ?? null,
    cliProcesses: cliCount,
  };
}

async function upstreamHealth() {
  try {
    const r = await fetch(cfg.upstream + "/health", {
      signal: AbortSignal.timeout(3000),
    });
    const h = await r.json();
    return {
      ok: r.ok && h.status === "healthy",
      status: h.status,
      version: h.version,
      mode: h.mode,
      loggedIn: h.auth?.loggedIn ?? null,
      plan: h.auth?.planLabel ?? null,
      daysUntilRenewal: h.auth?.daysUntilRenewal ?? null,
      upstreamState: h.upstream?.claude?.state ?? null,
      lastError: h.upstream?.claude?.lastErrorKind ?? null,
    };
  } catch (e) {
    return { ok: false, status: "unreachable", error: e.message };
  }
}

const projectView = (p) => ({
  id: p.id,
  name: p.name,
  keyPrefix: p.key_prefix,
  enabled: !!p.enabled,
  dailyRequestCap: p.daily_request_cap,
  dailyTokenCap: p.daily_token_cap,
  allowedModels: p.allowed_models ?? "",
  note: p.note ?? "",
  createdAt: p.created_at,
  lastUsedAt: p.last_used_at,
});

async function admin(req, res, path, url) {
  if (path === "/admin/login" && req.method === "POST") {
    const ip = clientIp(req);
    const f = loginFails.get(ip) ?? { n: 0, until: 0 };
    if (f.until > Date.now())
      return send(res, 429, { error: "Too many attempts. Wait a minute." });
    const { password } = JSON.parse(
      (await readBody(req, 10000)).toString() || "{}",
    );
    if (!password || !checkPassword(password, cfg.adminPasswordHash)) {
      f.n++;
      if (f.n >= 5) Object.assign(f, { n: 0, until: Date.now() + 60000 });
      loginFails.set(ip, f);
      return send(res, 401, { error: "Wrong password." });
    }
    loginFails.delete(ip);
    return send(
      res,
      200,
      { ok: true },
      {
        "set-cookie": `cgw_admin=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`,
      },
    );
  }
  if (path === "/admin/logout")
    return send(
      res,
      200,
      { ok: true },
      {
        "set-cookie":
          "cgw_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      },
    );
  if (!isAdmin(req)) return send(res, 401, { error: "Sign in first." });
  // CSRF: state-changing admin calls must come from our own page (custom header can't be sent cross-site without CORS).
  if (req.method !== "GET" && req.headers["x-cgw"] !== "1")
    return send(res, 403, { error: "Bad request origin." });

  const q = Object.fromEntries(url.searchParams);
  const m = /^\/admin\/api\/projects\/(\d+)(\/rotate)?$/.exec(path);

  if (path === "/admin/api/status" && req.method === "GET") {
    return send(res, 200, {
      uptimeSec: Math.round((Date.now() - STARTED) / 1000),
      active,
      queued: waiting.length,
      maxConcurrent: cfg.maxConcurrent,
      memory: await memory(),
      upstream: await upstreamHealth(),
      connection: {
        lanUrl: `${SCHEME}://${cfg.publicHost}:${cfg.port}`,
        localUrl: `${SCHEME}://localhost:${cfg.port}`,
        httpUrl:
          TLS && cfg.httpPort
            ? `http://${cfg.publicHost}:${cfg.httpPort}`
            : null,
        defaultModel: cfg.defaultModel,
        models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
      },
    });
  }
  if (path === "/admin/api/projects" && req.method === "GET") {
    const rows = db.prepare("SELECT * FROM projects ORDER BY name").all();
    const usage = db
      .prepare(
        `SELECT project_id,
           SUM(CASE WHEN ts >= strftime('%Y-%m-%dT00:00:00Z','now') THEN 1 ELSE 0 END) today,
           COUNT(*) n30, SUM(in_tok+out_tok+cache_read+cache_write) tok30, SUM(cost) cost30,
           SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) err30
         FROM requests WHERE ts >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days') GROUP BY project_id`,
      )
      .all();
    const by = Object.fromEntries(usage.map((u) => [u.project_id, u]));
    return send(
      res,
      200,
      rows.map((p) => ({ ...projectView(p), usage: by[p.id] ?? null })),
    );
  }
  if (path === "/admin/api/projects" && req.method === "POST") {
    const b = JSON.parse((await readBody(req, 10000)).toString() || "{}");
    const name = String(b.name ?? "")
      .trim()
      .slice(0, 60);
    if (!name) return send(res, 400, { error: "Name is required." });
    if (db.prepare("SELECT 1 FROM projects WHERE name = ?").get(name))
      return send(res, 400, { error: "A project with this name exists." });
    const k = newKey();
    db.prepare(
      "INSERT INTO projects (name, key_prefix, key_hash, note) VALUES (?, ?, ?, ?)",
    ).run(name, k.prefix, k.hash, String(b.note ?? "").slice(0, 200));
    return send(res, 201, { key: k.key });
  }
  if (m && !m[2] && req.method === "PATCH") {
    const b = JSON.parse((await readBody(req, 10000)).toString() || "{}");
    const num = (v) =>
      v === "" || v == null ? null : Math.max(0, Math.floor(Number(v))) || null;
    const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(+m[1]);
    if (!p) return send(res, 404, { error: "Not found." });
    db.prepare(
      "UPDATE projects SET enabled = ?, daily_request_cap = ?, daily_token_cap = ?, allowed_models = ?, note = ? WHERE id = ?",
    ).run(
      "enabled" in b ? (b.enabled ? 1 : 0) : p.enabled,
      "dailyRequestCap" in b ? num(b.dailyRequestCap) : p.daily_request_cap,
      "dailyTokenCap" in b ? num(b.dailyTokenCap) : p.daily_token_cap,
      "allowedModels" in b
        ? String(b.allowedModels).slice(0, 300)
        : p.allowed_models,
      "note" in b ? String(b.note).slice(0, 200) : p.note,
      p.id,
    );
    return send(res, 200, { ok: true });
  }
  if (m && m[2] && req.method === "POST") {
    const k = newKey();
    const r = db
      .prepare("UPDATE projects SET key_prefix = ?, key_hash = ? WHERE id = ?")
      .run(k.prefix, k.hash, +m[1]);
    return r.changes
      ? send(res, 200, { key: k.key })
      : send(res, 404, { error: "Not found." });
  }
  if (m && !m[2] && req.method === "DELETE") {
    db.prepare("DELETE FROM projects WHERE id = ?").run(+m[1]);
    return send(res, 200, { ok: true });
  }
  if (path === "/admin/api/usage" && req.method === "GET") {
    const days = Math.min(90, Math.max(1, Number(q.days) || 7));
    const since = `-${days} days`;
    const daily = db
      .prepare(
        `SELECT substr(ts,1,10) day, COUNT(*) n, SUM(in_tok+out_tok+cache_read+cache_write) tok, SUM(cost) cost,
           SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) err, CAST(AVG(ms) AS INTEGER) avg_ms
         FROM requests WHERE ts >= strftime('%Y-%m-%dT%H:%M:%SZ','now',?) GROUP BY day ORDER BY day`,
      )
      .all(since);
    const byModel = db
      .prepare(
        `SELECT COALESCE(model,'-') model, COUNT(*) n, SUM(in_tok) in_tok, SUM(out_tok) out_tok,
           SUM(cache_read+cache_write) cache, SUM(cost) cost, CAST(AVG(ms) AS INTEGER) avg_ms
         FROM requests WHERE ts >= strftime('%Y-%m-%dT%H:%M:%SZ','now',?) GROUP BY model ORDER BY n DESC`,
      )
      .all(since);
    const byProject = db
      .prepare(
        `SELECT COALESCE(p.name,'(no valid key)') project, COUNT(*) n, SUM(r.in_tok) in_tok, SUM(r.out_tok) out_tok,
           SUM(r.cache_read+r.cache_write) cache, SUM(r.cost) cost, CAST(AVG(r.ms) AS INTEGER) avg_ms,
           SUM(CASE WHEN r.status >= 400 THEN 1 ELSE 0 END) err
         FROM requests r LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.ts >= strftime('%Y-%m-%dT%H:%M:%SZ','now',?) GROUP BY project ORDER BY n DESC`,
      )
      .all(since);
    const byIp = db
      .prepare(
        `SELECT ip, COUNT(*) n FROM requests WHERE ts >= strftime('%Y-%m-%dT%H:%M:%SZ','now',?)
         GROUP BY ip ORDER BY n DESC LIMIT 20`,
      )
      .all(since);
    return send(res, 200, { days, daily, byModel, byProject, byIp });
  }
  if (path === "/admin/api/requests" && req.method === "GET") {
    const where = [];
    const params = [];
    if (q.errors === "1") where.push("r.status >= 400");
    if (q.project) {
      where.push("r.project_id = ?");
      params.push(Number(q.project));
    }
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const rows = db
      .prepare(
        `SELECT r.*, p.name project FROM requests r LEFT JOIN projects p ON p.id = r.project_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY r.id DESC LIMIT ${limit}`,
      )
      .all(...params);
    return send(res, 200, rows);
  }
  if (path === "/admin/api/errors" && req.method === "DELETE") {
    db.prepare("UPDATE requests SET error = NULL WHERE status >= 400").run();
    return send(res, 200, { ok: true });
  }
  if (path === "/admin/api/test" && req.method === "POST") {
    const t0 = Date.now();
    try {
      const r = await fetch(cfg.upstream + "/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.internalKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: cfg.defaultModel,
          max_tokens: 50,
          messages: [
            { role: "user", content: "Reply with the single word: pong" },
          ],
        }),
        signal: AbortSignal.timeout(60000),
      });
      const o = await r.json();
      const text =
        o.content?.find((c) => c.type === "text")?.text ??
        o.error?.message ??
        "";
      return send(res, 200, {
        ok: r.ok,
        status: r.status,
        ms: Date.now() - t0,
        text: text.slice(0, 200),
      });
    } catch (e) {
      return send(res, 200, {
        ok: false,
        ms: Date.now() - t0,
        text: e.message,
      });
    }
  }
  return send(res, 404, { error: "Not found." });
}

// ---------- server ----------
const PAGE = join(ROOT, "proxy/public/index.html");
const handler = async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    if (path === "/health") {
      const up = await upstreamHealth();
      return send(res, up.ok ? 200 : 503, {
        status: up.ok ? "ok" : "degraded",
        backend: up.status,
      });
    }
    if (path.startsWith("/v1/")) {
      if (
        ![
          "/v1/messages",
          "/v1/chat/completions",
          "/v1/models",
          "/v1/messages/count_tokens",
        ].includes(path) &&
        !path.startsWith("/v1/models/")
      )
        return apiError(res, 404, "not_found_error", "Unknown endpoint.");
      return await proxyApi(req, res, path);
    }
    if (path.startsWith("/admin/")) return await admin(req, res, path, url);
    if (path === "/" && req.method === "GET") {
      return send(res, 200, readFileSync(PAGE, "utf8"), {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
        "x-frame-options": "DENY",
      });
    }
    return send(res, 404, "Not found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) apiError(res, 500, "api_error", "Gateway error.");
    else res.end();
  }
};

// https on cfg.port when certs/gateway.pem + certs/gateway-key.pem exist (made with mkcert),
// plus plain http on cfg.httpPort for clients that do not trust the local CA.
function start(server, port, scheme) {
  server.requestTimeout = 0;
  server.listen(port, cfg.host, () =>
    console.log(
      `Gateway on ${scheme}://${cfg.host}:${port} (LAN: ${scheme}://${cfg.publicHost}:${port}) -> ${cfg.upstream}`,
    ),
  );
}
if (TLS) {
  start(https.createServer(TLS, handler), cfg.port, "https");
  if (cfg.httpPort) start(http.createServer(handler), cfg.httpPort, "http");
} else {
  start(http.createServer(handler), cfg.port, "http");
}

// Prune old rows daily.
const prune = () =>
  db
    .prepare(
      "DELETE FROM requests WHERE ts < strftime('%Y-%m-%dT%H:%M:%SZ','now',?)",
    )
    .run(`-${cfg.retentionDays} days`);
prune();
setInterval(prune, 864e5).unref();
