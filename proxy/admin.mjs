// Dashboard API: sign-in, status, projects, models, usage, requests, playground and settings.
import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { newKey } from "./db.mjs";
import {
  EDITABLE,
  saveConfig,
  hashPassword,
  checkPassword,
} from "./config.mjs";
import { send, readJson, clientIp } from "./http-util.mjs";
import { usageFromJson } from "./proxy.mjs";

const STARTED = Date.now();
const since = (days) => new Date(Date.now() - days * 864e5).toISOString();
const pct = (sorted, p) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
    : null;
const int = (v) =>
  v === "" || v == null ? null : Math.max(0, Math.floor(Number(v))) || null;
const num = (v) =>
  v === "" || v == null || !Number.isFinite(Number(v))
    ? null
    : Math.max(0, Number(v));
const csvCell = (v) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formulas never run
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function run(cmd, args) {
  return new Promise((resolve) =>
    execFile(
      cmd,
      args,
      { maxBuffer: 8e6, timeout: 15000 },
      (err, out, errOut) =>
        resolve({
          ok: !err,
          out: String(out),
          err: String(errOut || err?.message || ""),
        }),
    ),
  );
}

async function memory() {
  const r = await run("ps", ["-axo", "pid=,ppid=,rss=,command="]);
  const procs = r.out
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: +m[1], ppid: +m[2], rss: +m[3], cmd: m[4] }));
  const root = procs.find((p) =>
    /meridian\/node_modules\/(\.bin\/meridian|@rynfar\/meridian\/dist\/cli)/.test(
      p.cmd,
    ),
  );
  let kb = 0;
  let cli = 0;
  if (root) {
    const ids = new Set([root.pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const p of procs)
        if (!ids.has(p.pid) && ids.has(p.ppid)) {
          ids.add(p.pid);
          grew = true;
        }
    }
    for (const p of procs)
      if (ids.has(p.pid)) {
        kb += p.rss;
        if (p.pid !== root.pid && /claude/.test(p.cmd)) cli++;
      }
  }
  return {
    proxyMb: Math.round(process.memoryUsage().rss / 1048576),
    meridianMb: Math.round(kb / 1024),
    meridianPid: root?.pid ?? null,
    cliProcesses: cli,
  };
}

export function createAdmin({ cfg, db, upstream, proxy, scheme }) {
  const sign = (v) =>
    createHmac("sha256", cfg.sessionSecret).update(v).digest("base64url");
  const makeSession = () => {
    const exp = String(Date.now() + 7 * 864e5);
    return `${exp}.${sign(exp)}`;
  };
  const isAdmin = (req) => {
    const m = /(?:^|;\s*)cgw_admin=([^;]+)/.exec(req.headers.cookie ?? "");
    if (!m) return false;
    const [exp, sig] = m[1].split(".");
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const a = Buffer.from(sign(exp));
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const loginFails = new Map();
  const urls = () => ({
    lanUrl: `${scheme}://${cfg.publicHost}:${cfg.port}`,
    localUrl: `${scheme}://localhost:${cfg.port}`,
    httpUrl:
      scheme === "https" && cfg.httpPort
        ? `http://${cfg.publicHost}:${cfg.httpPort}`
        : null,
  });

  const projectView = (p) => ({
    id: p.id,
    name: p.name,
    keyPrefix: p.key_prefix,
    enabled: !!p.enabled,
    dailyRequestCap: p.daily_request_cap,
    dailyTokenCap: p.daily_token_cap,
    monthlyTokenCap: p.monthly_token_cap,
    rpmCap: p.rpm_cap,
    maxTokensCap: p.max_tokens_cap,
    quotaCapPct: p.quota_cap_pct,
    expiresAt: p.expires_at,
    allowedModels: p.allowed_models ?? "",
    note: p.note ?? "",
    createdAt: p.created_at,
    lastUsedAt: p.last_used_at,
  });

  const routes = {
    "GET /admin/api/status": async () => {
      const [mem, health, quota, tele] = await Promise.all([
        memory(),
        upstream.health(),
        upstream.getQuota(),
        upstream.telemetry(),
      ]);
      const today = db
        .prepare(
          `SELECT COUNT(*) n, COALESCE(SUM(in_tok+out_tok+cache_read+cache_write),0) tok, COALESCE(SUM(cost),0) cost,
             SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) err FROM requests WHERE ts >= ?`,
        )
        .get(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
      const lastHour = db
        .prepare(
          `SELECT COUNT(*) n, SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) err5 FROM requests WHERE ts >= ?`,
        )
        .get(new Date(Date.now() - 3600e3).toISOString());
      return {
        uptimeSec: Math.round((Date.now() - STARTED) / 1000),
        ...proxy.stats(),
        maxConcurrent: cfg.maxConcurrent,
        memory: mem,
        upstream: health,
        quota: quota.data
          ? {
              buckets: quota.data.buckets,
              extraUsage: quota.data.extraUsage,
              asOf: quota.data.asOf,
            }
          : null,
        quotaError: quota.error,
        telemetry: tele,
        today,
        lastHour,
        connection: { ...urls(), defaultModel: cfg.defaultModel },
      };
    },

    // ---------- projects ----------
    "GET /admin/api/projects": () => {
      const rows = db.prepare("SELECT * FROM projects ORDER BY name").all();
      const usage = Object.fromEntries(
        db
          .prepare(
            `SELECT project_id,
               SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) today,
               SUM(CASE WHEN ts >= ? AND status < 400 THEN in_tok+out_tok+cache_read+cache_write ELSE 0 END) tokToday,
               SUM(CASE WHEN ts >= ? AND status < 400 THEN in_tok+out_tok+cache_read+cache_write ELSE 0 END) tokMonth,
               COUNT(*) n30, SUM(in_tok+out_tok+cache_read+cache_write) tok30, SUM(cost) cost30,
               SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) err30
             FROM requests WHERE ts >= ? GROUP BY project_id`,
          )
          .all(
            new Date().toISOString().slice(0, 10) + "T00:00:00Z",
            new Date().toISOString().slice(0, 10) + "T00:00:00Z",
            new Date().toISOString().slice(0, 7) + "-01T00:00:00Z",
            since(31),
          )
          .map((u) => [u.project_id, u]),
      );
      return rows.map((p) => ({
        ...projectView(p),
        usage: usage[p.id] ?? null,
      }));
    },
    "POST /admin/api/projects": async (req) => {
      const b = await readJson(req);
      const name = String(b.name ?? "")
        .trim()
        .slice(0, 60);
      if (!name) return [400, { error: "Name is required." }];
      if (db.prepare("SELECT 1 FROM projects WHERE name = ?").get(name))
        return [400, { error: "A project with this name exists." }];
      const k = newKey();
      db.prepare(
        "INSERT INTO projects (name, key_prefix, key_hash, note) VALUES (?, ?, ?, ?)",
      ).run(name, k.prefix, k.hash, String(b.note ?? "").slice(0, 200));
      return [201, { key: k.key }];
    },
    "PATCH /admin/api/projects/:id": async (req, id) => {
      const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(+id);
      if (!p) return [404, { error: "Not found." }];
      const b = await readJson(req);
      const pick = (k, col, f) => (k in b ? f(b[k]) : p[col]);
      const expires = (v) => (v ? new Date(v).toISOString() : null);
      const pctv = (v) => {
        const n = int(v);
        return n ? Math.min(100, n) : null;
      };
      db.prepare(
        `UPDATE projects SET name = ?, enabled = ?, daily_request_cap = ?, daily_token_cap = ?, monthly_token_cap = ?,
           rpm_cap = ?, max_tokens_cap = ?, quota_cap_pct = ?, expires_at = ?, allowed_models = ?, note = ? WHERE id = ?`,
      ).run(
        pick("name", "name", (v) => String(v).trim().slice(0, 60) || p.name),
        pick("enabled", "enabled", (v) => (v ? 1 : 0)),
        pick("dailyRequestCap", "daily_request_cap", int),
        pick("dailyTokenCap", "daily_token_cap", int),
        pick("monthlyTokenCap", "monthly_token_cap", int),
        pick("rpmCap", "rpm_cap", int),
        pick("maxTokensCap", "max_tokens_cap", int),
        pick("quotaCapPct", "quota_cap_pct", pctv),
        pick("expiresAt", "expires_at", expires),
        pick("allowedModels", "allowed_models", (v) => String(v).slice(0, 500)),
        pick("note", "note", (v) => String(v).slice(0, 200)),
        p.id,
      );
      return { ok: true };
    },
    "POST /admin/api/projects/:id/rotate": (req, id) => {
      const k = newKey();
      const r = db
        .prepare(
          "UPDATE projects SET key_prefix = ?, key_hash = ? WHERE id = ?",
        )
        .run(k.prefix, k.hash, +id);
      return r.changes ? { key: k.key } : [404, { error: "Not found." }];
    },
    "DELETE /admin/api/projects/:id": (req, id) => {
      db.prepare("DELETE FROM projects WHERE id = ?").run(+id);
      return { ok: true };
    },

    // ---------- models ----------
    "GET /admin/api/models": async () => {
      const list = await upstream.listModels(true);
      const rows = Object.fromEntries(
        db
          .prepare("SELECT * FROM models")
          .all()
          .map((r) => [r.id, r]),
      );
      const use = Object.fromEntries(
        db
          .prepare(
            `SELECT model, COUNT(*) n, SUM(in_tok+cache_read+cache_write) inp, SUM(out_tok) out, SUM(cost) cost,
               SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) err, MAX(ts) last
             FROM requests WHERE ts >= ? GROUP BY model`,
          )
          .all(since(30))
          .map((u) => [u.model, u]),
      );
      const fam = (id) => Object.keys(cfg.pricing).find((k) => id.includes(k));
      return list.map((m) => {
        const r = rows[m.id] ?? {};
        const f = fam(m.id);
        return {
          ...m,
          family: f ?? null,
          enabled: r.enabled !== 0,
          maxTokensCap: r.max_tokens_cap ?? null,
          priceIn: r.price_in ?? null,
          priceOut: r.price_out ?? null,
          defaultPrice: f ? cfg.pricing[f] : null,
          aliases: r.aliases ?? "",
          note: r.note ?? "",
          isDefault: m.id === cfg.defaultModel,
          usage: use[m.id] ?? null,
        };
      });
    },
    "PATCH /admin/api/models/:id": async (req, id) => {
      const mid = decodeURIComponent(id);
      const b = await readJson(req);
      const cur = db.prepare("SELECT * FROM models WHERE id = ?").get(mid) ?? {
        enabled: 1,
      };
      const pick = (k, col, f) => (k in b ? f(b[k]) : (cur[col] ?? null));
      const aliases = (v) =>
        String(v ?? "")
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter((s) => /^[a-z0-9._-]{1,40}$/.test(s))
          .join(",") || null;
      db.prepare(
        `INSERT INTO models (id, enabled, max_tokens_cap, price_in, price_out, aliases, note) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, max_tokens_cap=excluded.max_tokens_cap,
           price_in=excluded.price_in, price_out=excluded.price_out, aliases=excluded.aliases, note=excluded.note`,
      ).run(
        mid,
        pick("enabled", "enabled", (v) => (v ? 1 : 0)),
        pick("maxTokensCap", "max_tokens_cap", int),
        pick("priceIn", "price_in", num),
        pick("priceOut", "price_out", num),
        pick("aliases", "aliases", aliases),
        pick("note", "note", (v) => String(v).slice(0, 200)),
      );
      if (b.makeDefault) {
        cfg.defaultModel = mid;
        saveConfig(cfg);
      }
      return { ok: true };
    },

    // ---------- usage ----------
    "GET /admin/api/usage": (req, _id, q) => {
      const days = Math.min(90, Math.max(1, Number(q.days) || 7));
      const from =
        days === 1
          ? new Date().toISOString().slice(0, 10) + "T00:00:00Z"
          : since(days);
      const rows = db
        .prepare(
          `SELECT r.ts, r.model, r.status, r.ms, r.ttfb_ms, r.in_tok, r.out_tok, r.cache_read, r.cache_write, r.cost, r.ip,
             COALESCE(p.name, '(no valid key)') project
           FROM requests r LEFT JOIN projects p ON p.id = r.project_id WHERE r.ts >= ? ORDER BY r.id DESC LIMIT 50000`,
        )
        .all(from);
      const group = (keyOf) => {
        const g = new Map();
        for (const r of rows) {
          const k = keyOf(r);
          const a = g.get(k) ?? {
            key: k,
            n: 0,
            err: 0,
            in_tok: 0,
            out_tok: 0,
            cache: 0,
            cost: 0,
            ms: [],
            ttfb: [],
          };
          a.n++;
          if (r.status >= 400) a.err++;
          a.in_tok += r.in_tok;
          a.out_tok += r.out_tok;
          a.cache += r.cache_read + r.cache_write;
          a.cost += r.cost;
          if (r.status < 400 && r.ms) a.ms.push(r.ms);
          if (r.status < 400 && r.ttfb_ms) a.ttfb.push(r.ttfb_ms);
          g.set(k, a);
        }
        return [...g.values()].map(({ ms, ttfb, ...a }) => {
          ms.sort((x, y) => x - y);
          ttfb.sort((x, y) => x - y);
          return {
            ...a,
            p50: pct(ms, 50),
            p95: pct(ms, 95),
            ttfb50: pct(ttfb, 50),
          };
        });
      };
      const byDayProject = {};
      for (const r of rows) {
        const d = r.ts.slice(0, 10);
        byDayProject[d] ??= {};
        byDayProject[d][r.project] =
          (byDayProject[d][r.project] ?? 0) +
          r.in_tok +
          r.out_tok +
          r.cache_read +
          r.cache_write;
      }
      return {
        days,
        total: group(() => "all")[0] ?? null,
        byProject: group((r) => r.project).sort((a, b) => b.n - a.n),
        byModel: group((r) => r.model ?? "-").sort((a, b) => b.n - a.n),
        byDay: group((r) => r.ts.slice(0, 10)).sort((a, b) =>
          a.key.localeCompare(b.key),
        ),
        byIp: group((r) => r.ip ?? "-")
          .sort((a, b) => b.n - a.n)
          .slice(0, 20),
        byDayProject,
        capped: rows.length >= 50000,
      };
    },

    // ---------- requests ----------
    "GET /admin/api/requests": (req, _id, q) => {
      const where = [];
      const params = [];
      if (q.errors === "1") where.push("r.status >= 400");
      if (q.project) {
        where.push("r.project_id = ?");
        params.push(Number(q.project));
      }
      if (q.model) {
        where.push("r.model = ?");
        params.push(String(q.model));
      }
      if (q.before) {
        where.push("r.id < ?");
        params.push(Number(q.before));
      }
      const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
      return db
        .prepare(
          `SELECT r.*, p.name project FROM requests r LEFT JOIN projects p ON p.id = r.project_id
           ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY r.id DESC LIMIT ${limit}`,
        )
        .all(...params);
    },
    "GET /admin/api/requests.csv": (req, _id, q, res) => {
      const days = Math.min(365, Math.max(1, Number(q.days) || 30));
      const rows = db
        .prepare(
          `SELECT r.ts, p.name project, r.ip, r.path, r.model, r.stream, r.status, r.ms, r.ttfb_ms, r.queue_ms,
             r.in_tok, r.out_tok, r.cache_read, r.cache_write, r.max_tokens, ROUND(r.cost, 6) cost, r.error
           FROM requests r LEFT JOIN projects p ON p.id = r.project_id WHERE r.ts >= ? ORDER BY r.id`,
        )
        .all(since(days));
      const cols = [
        "ts",
        "project",
        "ip",
        "path",
        "model",
        "stream",
        "status",
        "ms",
        "ttfb_ms",
        "queue_ms",
        "in_tok",
        "out_tok",
        "cache_read",
        "cache_write",
        "max_tokens",
        "cost",
        "error",
      ];
      const csv = [
        cols.join(","),
        ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")),
      ].join("\n");
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="gateway-requests-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
      res.end(csv);
      return null;
    },
    "DELETE /admin/api/errors": () => {
      db.prepare("UPDATE requests SET error = NULL WHERE status >= 400").run();
      return { ok: true };
    },
    "POST /admin/api/unblock": async (req) => {
      const b = await readJson(req);
      proxy.unblock(String(b.ip ?? ""));
      return { ok: true };
    },

    // ---------- playground ----------
    "POST /admin/api/playground": async (req) => {
      const b = await readJson(req, 200_000);
      const model = String(b.model || cfg.defaultModel);
      const body = {
        model,
        max_tokens: Math.min(8192, Math.max(1, Number(b.maxTokens) || 512)),
        messages: [
          {
            role: "user",
            content: String(b.prompt ?? "").slice(0, 50_000) || "Hello",
          },
        ],
        ...(b.system ? { system: String(b.system).slice(0, 20_000) } : {}),
        ...(b.temperature !== "" && b.temperature != null
          ? { temperature: Math.min(1, Math.max(0, Number(b.temperature))) }
          : {}),
      };
      const t0 = Date.now();
      try {
        const r = await fetch(cfg.upstream + "/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": cfg.internalKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.requestTimeoutMs),
        });
        const o = await r.json();
        const usage = usageFromJson(o);
        const ms = Date.now() - t0;
        const error = r.ok ? null : (o.error?.message ?? `Status ${r.status}`);
        proxy.log({
          ip: clientIp(req),
          method: "POST",
          path: "/playground",
          model,
          status: r.status,
          ms,
          ...usage,
          cost: proxy.costOf(model, usage),
          error,
          max_tokens: body.max_tokens,
        });
        return {
          ok: r.ok,
          status: r.status,
          ms,
          text:
            (o.content ?? [])
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n") ||
            error ||
            "",
          stopReason: o.stop_reason ?? null,
          usage,
          cost: proxy.costOf(model, usage),
        };
      } catch (e) {
        return { ok: false, ms: Date.now() - t0, text: e.message };
      }
    },

    // ---------- settings ----------
    "GET /admin/api/settings": () => ({
      ...Object.fromEntries(Object.keys(EDITABLE).map((k) => [k, cfg[k]])),
      pricing: cfg.pricing,
      ports: {
        https: scheme === "https" ? cfg.port : null,
        http: scheme === "https" ? cfg.httpPort : cfg.port,
      },
    }),
    "PATCH /admin/api/settings": async (req) => {
      const b = await readJson(req);
      for (const [k, rule] of Object.entries(EDITABLE)) {
        if (!(k in b)) continue;
        if (rule === "string") {
          const v = String(b[k]).trim().slice(0, 100);
          if (v) cfg[k] = v;
        } else {
          const v = Math.floor(Number(b[k]));
          if (!Number.isFinite(v) || v < rule.min || v > rule.max)
            return [
              400,
              { error: `${k} must be between ${rule.min} and ${rule.max}.` },
            ];
          cfg[k] = v;
        }
      }
      if (b.pricing && typeof b.pricing === "object") {
        for (const [fam, p] of Object.entries(b.pricing))
          if (cfg.pricing[fam] && num(p?.in) != null && num(p?.out) != null)
            cfg.pricing[fam] = { in: num(p.in), out: num(p.out) };
      }
      saveConfig(cfg);
      return { ok: true };
    },
    "POST /admin/api/password": async (req) => {
      const b = await readJson(req);
      if (!checkPassword(b.current ?? "", cfg.adminPasswordHash))
        return [400, { error: "Current password is wrong." }];
      if (String(b.next ?? "").length < 10)
        return [400, { error: "Use at least 10 characters." }];
      cfg.adminPasswordHash = hashPassword(String(b.next));
      cfg.sessionSecret = (await import("node:crypto"))
        .randomBytes(32)
        .toString("hex"); // signs out other sessions
      saveConfig(cfg);
      return { ok: true, signedOut: true };
    },
    "POST /admin/api/restart-backend": async () => {
      const uid = process.getuid?.();
      const r = await run("launchctl", [
        "kickstart",
        "-k",
        `gui/${uid}/com.local.claude-gateway.meridian`,
      ]);
      return r.ok
        ? { ok: true }
        : [500, { error: r.err.slice(0, 300) || "Restart failed." }];
    },
  };

  async function handle(req, res, path, url) {
    if (path === "/admin/login" && req.method === "POST") {
      const ip = clientIp(req);
      const f = loginFails.get(ip) ?? { n: 0, until: 0 };
      if (f.until > Date.now())
        return send(res, 429, { error: "Too many attempts. Wait a minute." });
      const { password } = await readJson(req, 10_000);
      if (!password || !checkPassword(password, cfg.adminPasswordHash)) {
        f.n++;
        if (f.n >= 5) Object.assign(f, { n: 0, until: Date.now() + 60_000 });
        loginFails.set(ip, f);
        return send(res, 401, { error: "Wrong password." });
      }
      loginFails.delete(ip);
      const secure = req.socket.encrypted ? "; Secure" : "";
      return send(
        res,
        200,
        { ok: true },
        {
          "set-cookie": `cgw_admin=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`,
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
    // State-changing calls must come from our own page: a custom header can't be sent cross-site without CORS.
    if (req.method !== "GET" && req.headers["x-cgw"] !== "1")
      return send(res, 403, { error: "Bad request origin." });

    const m = /^(\/admin\/api\/(?:projects|models))\/([^/]+)(\/rotate)?$/.exec(
      path,
    );
    const key = m
      ? `${req.method} ${m[1]}/:id${m[3] ?? ""}`
      : `${req.method} ${path}`;
    const fn = routes[key];
    if (!fn) return send(res, 404, { error: "Not found." });
    const out = await fn(
      req,
      m?.[2],
      Object.fromEntries(url.searchParams),
      res,
    );
    if (out === null) return;
    if (Array.isArray(out) && typeof out[0] === "number")
      return send(res, out[0], out[1]);
    return send(res, 200, out);
  }

  return { handle };
}
