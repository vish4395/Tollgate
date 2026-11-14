// Dashboard API: sign-in, status, projects, accounts, models, usage, requests, monitoring, alerts,
// activity, playground and settings.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { originList } from "./cors.mjs";
import { newKey } from "./db.mjs";
import {
  EDITABLE,
  VERSION,
  saveConfig,
  hashPassword,
  checkPassword,
  validateSettings,
  ALERT_DEFAULTS,
  NOTIFY_DEFAULTS,
} from "./config.mjs";
import { send, readJson, clientIp, isHttps, HttpError } from "./http-util.mjs";
import { usageFromJson, sseTracker } from "./proxy.mjs";
import { memoryCached } from "./sysinfo.mjs";
import { zoneStart, zoneDay, zoneOffsetMin, zoneEndOfDay } from "./time.mjs";
import { ALERT_INFO } from "./alerts.mjs";
import { checkWebhookUrl } from "./notify.mjs";

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
const SECRET_FIELDS = {
  webhook: ["url"],
  telegram: ["token"],
  email: ["pass"],
};

export function createAdmin({
  cfg,
  db,
  upstream,
  proxy,
  accounts,
  alerts,
  notifier,
  events,
  monitor,
  scheme,
  backend,
}) {
  // ---------- sessions: exp.epoch.signature; bumping the epoch signs everyone out ----------
  const sign = (v) =>
    createHmac("sha256", cfg.sessionSecret).update(v).digest("base64url");
  const makeSession = () => {
    const v = `${Date.now() + 7 * 864e5}.${cfg.sessionEpoch}`;
    return `${v}.${sign(v)}`;
  };
  const isAdmin = (req) => {
    const m = /(?:^|;\s*)cgw_admin=([^;]+)/.exec(req.headers.cookie ?? "");
    if (!m) return false;
    const [exp, epoch, sig] = m[1].split(".");
    if (
      !exp ||
      !epoch ||
      !sig ||
      Number(exp) < Date.now() ||
      Number(epoch) !== cfg.sessionEpoch
    )
      return false;
    const a = Buffer.from(sign(`${exp}.${epoch}`));
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const cookie = (req, value, maxAge) =>
    `cgw_admin=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isHttps(req, cfg.trustedProxy) ? "; Secure" : ""}`;
  const loginFails = new Map(); // ip -> { n, until }
  let globalFails = []; // timestamps, all addresses
  setInterval(() => {
    for (const [ip, f] of loginFails)
      if (f.until < Date.now() && f.n === 0) loginFails.delete(ip);
  }, 300_000).unref();

  const urls = () => ({
    lanUrl: `${scheme}://${cfg.publicHost}:${cfg.port}`,
    localUrl: `${scheme}://localhost:${cfg.port}`,
    httpUrl:
      scheme === "https" && cfg.httpPort
        ? `http://${cfg.publicHost}:${cfg.httpPort}`
        : null,
    publicUrl: cfg.publicUrl || null,
  });
  const dayStart = () => zoneStart(cfg.timeZone, "day");

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
    allowedOrigins: p.allowed_origins ?? "",
    accounts: p.accounts ?? "",
    note: p.note ?? "",
    createdAt: p.created_at,
    lastUsedAt: p.last_used_at,
  });

  function accountViews() {
    const use = Object.fromEntries(
      db
        .prepare(
          `SELECT account, COUNT(*) n, SUM(failed) err, SUM(in_tok+out_tok+cache_read+cache_write) tok, SUM(cost) cost
           FROM requests WHERE ts >= ? AND account IS NOT NULL GROUP BY account`,
        )
        .all(dayStart())
        .map((u) => [u.account, u]),
    );
    const prof = Object.fromEntries(accounts.profiles().map((p) => [p.id, p]));
    const health = monitor.lastHealth();
    return accounts.rows().map((a) => {
      const p = prof[a.id] ?? {};
      return {
        id: a.id,
        label: a.label,
        enabled: !!a.enabled,
        priority: a.priority,
        reservePct: a.reserve_pct,
        weeklyReservePct: a.weekly_reserve_pct,
        state: a.state,
        cooldownUntil: a.cooldown_until,
        lastError: a.last_error,
        lastUsedAt: a.last_used_at,
        email: p.email ?? null,
        plan:
          p.subscriptionType ??
          (a.id === "default" ? health?.plan : null) ??
          null,
        loggedIn:
          p.loggedIn ?? (a.id === "default" ? health?.loggedIn : null) ?? null,
        daysUntilRenewal:
          p.daysUntilRenewal ??
          (a.id === "default" ? health?.daysUntilRenewal : null) ??
          null,
        quota: accounts.quota(a.id),
        today: use[a.id] ?? null,
      };
    });
  }

  const audit = (req, what, subject = null) =>
    events.add(
      "admin",
      subject,
      what,
      "admin",
      clientIp(req, cfg.trustedProxy),
    );

  // ---------- routes: "METHOD /path/:id" ----------
  const routes = {
    "GET /admin/api/status": async () => {
      const [mem, health, tele] = await Promise.all([
        memoryCached(backend.pid()).catch(() => null),
        upstream.health(),
        upstream.telemetry(),
      ]);
      const today = db
        .prepare(
          `SELECT COUNT(*) n, COALESCE(SUM(in_tok+out_tok+cache_read+cache_write),0) tok, COALESCE(SUM(cost),0) cost,
             COALESCE(SUM(failed),0) err FROM requests WHERE ts >= ? AND path LIKE '/v1/%'`,
        )
        .get(dayStart());
      const lastHour = db
        .prepare(
          `SELECT COUNT(*) n, COALESCE(SUM(failed),0) err FROM requests WHERE ts >= ? AND path LIKE '/v1/%'`,
        )
        .get(new Date(Date.now() - 3600e3).toISOString());
      const firstCall = db
        .prepare(
          "SELECT 1 FROM requests WHERE failed = 0 AND path LIKE '/v1/%' LIMIT 1",
        )
        .get();
      return {
        version: VERSION,
        platform: process.platform,
        uptimeSec: Math.round((Date.now() - STARTED) / 1000),
        ...proxy.stats(),
        maxConcurrent: cfg.maxConcurrent,
        maxQueue: cfg.maxQueue,
        memory: mem,
        upstream: health,
        telemetry: tele,
        accounts: accountViews(),
        alerts: alerts
          .openList()
          .map((a) => ({ ...a, title: ALERT_INFO[a.kind]?.title ?? a.kind })),
        today,
        lastHour,
        timeZone: cfg.timeZone,
        setup: {
          signedIn: accounts
            .rows()
            .some((a) => a.state !== "signed_out" && a.enabled),
          hasProject: !!db.prepare("SELECT 1 FROM projects LIMIT 1").get(),
          firstCall: !!firstCall,
          alertsSet: Object.values(cfg.notify).some((c) => c.enabled),
          passwordChanged: !!cfg.passwordChangedAt,
        },
        connection: { ...urls(), defaultModel: cfg.defaultModel },
      };
    },

    // ---------- projects ----------
    "GET /admin/api/projects": () => {
      const rows = db
        .prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE")
        .all();
      const usage = Object.fromEntries(
        db
          .prepare(
            `SELECT project_id,
               SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) today,
               COUNT(*) n30, SUM(in_tok+out_tok+cache_read+cache_write) tok30, SUM(cost) cost30, SUM(failed) err30
             FROM requests WHERE ts >= ? GROUP BY project_id`,
          )
          .all(dayStart(), since(30))
          .map((u) => [u.project_id, u]),
      );
      return rows.map((p) => {
        const u = proxy.usage(p);
        return {
          ...projectView(p),
          usage: {
            ...(usage[p.id] ?? {}),
            dayN: u.dayN,
            tokToday: u.dayT,
            tokMonth: u.monthT,
          },
        };
      });
    },
    "POST /admin/api/projects": async (req) => {
      const b = await readJson(req);
      const name = String(b.name ?? "")
        .trim()
        .slice(0, 60);
      if (!name) return [400, { error: "Name is required." }];
      if (
        db
          .prepare("SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE")
          .get(name)
      )
        return [400, { error: "A project with this name exists." }];
      const k = newKey();
      const r = db
        .prepare(
          "INSERT INTO projects (name, key_prefix, key_hash, note) VALUES (?, ?, ?, ?)",
        )
        .run(name, k.prefix, k.hash, String(b.note ?? "").slice(0, 200));
      audit(req, "Created project", name);
      return [201, { key: k.key, id: Number(r.lastInsertRowid) }];
    },
    "PATCH /admin/api/projects/:id": async (req, id) => {
      const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(+id);
      if (!p) return [404, { error: "Not found." }];
      const b = await readJson(req);
      const pick = (k, col, f) => (k in b ? f(b[k]) : p[col]);
      const expires = (v) => {
        if (!v) return null;
        const iso = /^\d{4}-\d{2}-\d{2}$/.test(String(v))
          ? zoneEndOfDay(cfg.timeZone, v)
          : Number.isFinite(Date.parse(String(v)))
            ? new Date(String(v)).toISOString()
            : null;
        if (!iso || Number.isNaN(Date.parse(iso)))
          throw new HttpError(400, "The expiry date is not valid.");
        return iso;
      };
      const pctv = (v) => {
        const n = int(v);
        return n ? Math.min(100, n) : null;
      };
      const name = pick(
        "name",
        "name",
        (v) => String(v).trim().slice(0, 60) || p.name,
      );
      if (
        name.toLowerCase() !== p.name.toLowerCase() &&
        db
          .prepare("SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE")
          .get(name)
      )
        return [400, { error: "A project with this name exists." }];
      const known = new Set(accounts.rows().map((a) => a.id));
      const acctList = (v) => {
        const list = [
          ...new Set(
            String(v ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ];
        const bad = list.filter((x) => !known.has(x));
        if (bad.length)
          throw new HttpError(400, `Unknown account: ${bad.join(", ")}`);
        return list.join(",") || null;
      };
      db.prepare(
        `UPDATE projects SET name = ?, enabled = ?, daily_request_cap = ?, daily_token_cap = ?, monthly_token_cap = ?,
           rpm_cap = ?, max_tokens_cap = ?, quota_cap_pct = ?, expires_at = ?, allowed_models = ?, allowed_origins = ?,
           accounts = ?, note = ? WHERE id = ?`,
      ).run(
        name,
        pick("enabled", "enabled", (v) => (v ? 1 : 0)),
        pick("dailyRequestCap", "daily_request_cap", int),
        pick("dailyTokenCap", "daily_token_cap", int),
        pick("monthlyTokenCap", "monthly_token_cap", int),
        pick("rpmCap", "rpm_cap", int),
        pick("maxTokensCap", "max_tokens_cap", int),
        pick("quotaCapPct", "quota_cap_pct", pctv),
        pick("expiresAt", "expires_at", expires),
        pick("allowedModels", "allowed_models", (v) =>
          String(v)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .join(",")
            .slice(0, 500),
        ),
        pick("allowedOrigins", "allowed_origins", (v) =>
          originList(v).join(", ").slice(0, 1000),
        ),
        pick("accounts", "accounts", acctList),
        pick("note", "note", (v) => String(v).slice(0, 200)),
        p.id,
      );
      audit(req, `Changed project: ${Object.keys(b).join(", ")}`, name);
      return { ok: true };
    },
    "POST /admin/api/projects/:id/rotate": (req, id) => {
      const k = newKey();
      const p = db.prepare("SELECT name FROM projects WHERE id = ?").get(+id);
      if (!p) return [404, { error: "Not found." }];
      db.prepare(
        "UPDATE projects SET key_prefix = ?, key_hash = ? WHERE id = ?",
      ).run(k.prefix, k.hash, +id);
      audit(req, "Rotated key", p.name);
      return { key: k.key };
    },
    "DELETE /admin/api/projects/:id": (req, id) => {
      const p = db.prepare("SELECT name FROM projects WHERE id = ?").get(+id);
      if (!p) return [404, { error: "Not found." }];
      db.prepare("DELETE FROM projects WHERE id = ?").run(+id);
      audit(req, "Deleted project", p.name);
      return { ok: true };
    },

    // ---------- accounts ----------
    "GET /admin/api/accounts": () => ({
      accounts: accountViews(),
      multi: accounts.isMulti(),
    }),
    "POST /admin/api/accounts/refresh": async () => {
      await accounts.refresh();
      return { accounts: accountViews() };
    },
    "PATCH /admin/api/accounts/:id": async (req, id) => {
      const a = accounts.get(decodeURIComponent(id));
      if (!a) return [404, { error: "Not found." }];
      const b = await readJson(req);
      const pick = (k, col, f) => (k in b ? f(b[k]) : a[col]);
      const pctv = (v) => {
        const n = int(v);
        return n ? Math.min(100, n) : null;
      };
      db.prepare(
        "UPDATE accounts SET label = ?, enabled = ?, priority = ?, reserve_pct = ?, weekly_reserve_pct = ? WHERE id = ?",
      ).run(
        pick("label", "label", (v) => String(v).trim().slice(0, 80) || a.id),
        pick("enabled", "enabled", (v) => (v ? 1 : 0)),
        pick("priority", "priority", (v) =>
          Math.max(0, Math.min(100000, Math.floor(Number(v)) || 0)),
        ),
        pick("reservePct", "reserve_pct", pctv),
        pick("weeklyReservePct", "weekly_reserve_pct", pctv),
        a.id,
      );
      audit(req, `Changed account: ${Object.keys(b).join(", ")}`, a.id);
      return { ok: true };
    },
    "POST /admin/api/accounts/order": async (req) => {
      const b = await readJson(req);
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
      const up = db.prepare("UPDATE accounts SET priority = ? WHERE id = ?");
      ids.forEach((aid, i) => up.run((i + 1) * 10, aid));
      audit(req, `Reordered accounts: ${ids.join(", ")}`);
      return { ok: true };
    },
    "POST /admin/api/accounts/:id/resume": (req, id) => {
      const a = accounts.get(decodeURIComponent(id));
      if (!a) return [404, { error: "Not found." }];
      accounts.clear(a.id);
      audit(req, "Resumed account (cleared pause)", a.id);
      return { ok: true };
    },
    "DELETE /admin/api/accounts/:id": (req, id) => {
      const a = accounts.get(decodeURIComponent(id));
      if (!a) return [404, { error: "Not found." }];
      if (accounts.profiles().some((p) => p.id === a.id))
        return [
          400,
          {
            error: `This account still exists on the backend. Remove it first: node proxy/cli.mjs account remove ${a.id}`,
          },
        ];
      db.prepare("DELETE FROM accounts WHERE id = ?").run(a.id);
      audit(req, "Removed account from the list", a.id);
      return { ok: true };
    },
    "POST /admin/api/accounts/:id/test": async (req, id) => {
      const a = accounts.get(decodeURIComponent(id));
      if (!a) return [404, { error: "Not found." }];
      const t0 = Date.now();
      try {
        const r = await fetch(cfg.upstream + "/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": cfg.internalKey,
            "anthropic-version": "2023-06-01",
            ...accounts.headerFor(a.id),
          },
          body: JSON.stringify({
            model: cfg.defaultModel,
            max_tokens: 8,
            messages: [{ role: "user", content: "Reply with: ok" }],
          }),
          signal: AbortSignal.timeout(60_000),
        });
        const o = await r.json().catch(() => ({}));
        if (r.ok) accounts.ok(a.id);
        return {
          ok: r.ok,
          status: r.status,
          ms: Date.now() - t0,
          error: r.ok ? null : (o.error?.message ?? `Status ${r.status}`),
        };
      } catch (e) {
        return { ok: false, ms: Date.now() - t0, error: e.message };
      }
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
               SUM(failed) err, MAX(ts) last FROM requests WHERE ts >= ? GROUP BY model`,
          )
          .all(since(30))
          .map((u) => [u.model, u]),
      );
      const fam = (mid) =>
        Object.keys(cfg.pricing).find((k) => mid.includes(k));
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
      if (b.enabled === false && mid === cfg.defaultModel)
        return [
          400,
          { error: "This is the default model. Choose another default first." },
        ];
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
      audit(req, `Changed model: ${Object.keys(b).join(", ")}`, mid);
      return { ok: true };
    },

    // ---------- usage ----------
    "GET /admin/api/usage": (req, _id, q) => {
      const days = Math.min(90, Math.max(1, Number(q.days) || 7));
      const from = days === 1 ? dayStart() : since(days);
      const off = zoneOffsetMin(cfg.timeZone);
      const rows = db
        .prepare(
          `SELECT r.ts, r.model, r.failed, r.ms, r.ttfb_ms, r.in_tok, r.out_tok, r.cache_read, r.cache_write, r.cost, r.ip, r.account,
             COALESCE(p.name, '(no valid key)') project
           FROM requests r LEFT JOIN projects p ON p.id = r.project_id WHERE r.ts >= ? AND r.path LIKE '/v1/%' ORDER BY r.id DESC LIMIT 100000`,
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
          if (r.failed) a.err++;
          a.in_tok += r.in_tok;
          a.out_tok += r.out_tok;
          a.cache += r.cache_read + r.cache_write;
          a.cost += r.cost;
          if (!r.failed && r.ms) a.ms.push(r.ms);
          if (!r.failed && r.ttfb_ms) a.ttfb.push(r.ttfb_ms);
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
      const day = (r) => zoneDay(r.ts, off);
      const byDayProject = {};
      for (const r of rows) {
        const d = day(r);
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
        timeZone: cfg.timeZone,
        total: group(() => "all")[0] ?? null,
        byProject: group((r) => r.project).sort((a, b) => b.n - a.n),
        byAccount: group((r) => r.account ?? "-").sort((a, b) => b.n - a.n),
        byModel: group((r) => r.model ?? "-").sort((a, b) => b.n - a.n),
        byDay: group(day).sort((a, b) => a.key.localeCompare(b.key)),
        byIp: group((r) => r.ip ?? "-")
          .sort((a, b) => b.n - a.n)
          .slice(0, 20),
        byDayProject,
        capped: rows.length >= 100000,
      };
    },

    // ---------- requests ----------
    "GET /admin/api/requests": (req, _id, q) => {
      const where = [];
      const params = [];
      const add = (sql, ...v) => {
        where.push(sql);
        params.push(...v);
      };
      if (q.errors === "1") add("r.failed = 1");
      if (q.project) add("r.project_id = ?", Number(q.project));
      if (q.model) add("r.model = ?", String(q.model));
      if (q.account) add("r.account = ?", String(q.account));
      if (q.ip) add("r.ip = ?", String(q.ip));
      if (q.status) add("r.status = ?", Number(q.status));
      if (q.from) add("r.ts >= ?", new Date(q.from).toISOString());
      if (q.to) add("r.ts < ?", new Date(q.to).toISOString());
      if (q.q) {
        const like = `%${String(q.q).replace(/[\\%_]/g, (c) => "\\" + c)}%`;
        add(
          "(r.error LIKE ? ESCAPE '\\' OR r.path LIKE ? ESCAPE '\\' OR r.model LIKE ? ESCAPE '\\' OR r.request_id = ? OR r.ip = ?)",
          like,
          like,
          like,
          String(q.q),
          String(q.q),
        );
      }
      if (q.before) add("r.id < ?", Number(q.before));
      if (q.after) add("r.id > ?", Number(q.after));
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
      const cols = [
        "ts",
        "project",
        "account",
        "ip",
        "path",
        "model",
        "stream",
        "status",
        "failed",
        "ms",
        "ttfb_ms",
        "queue_ms",
        "in_tok",
        "out_tok",
        "cache_read",
        "cache_write",
        "max_tokens",
        "cost",
        "stop_reason",
        "attempts",
        "request_id",
        "error",
      ];
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="gateway-requests-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
      res.write(cols.join(",") + "\n");
      // Stream row by row so a long period never sits in memory.
      const it = db
        .prepare(
          `SELECT r.*, ROUND(r.cost, 6) cost, p.name project FROM requests r LEFT JOIN projects p ON p.id = r.project_id
           WHERE r.ts >= ? ORDER BY r.id`,
        )
        .iterate(since(days));
      let batch = "";
      for (const r of it) {
        batch += cols.map((c) => csvCell(r[c])).join(",") + "\n";
        if (batch.length > 64_000) {
          res.write(batch);
          batch = "";
        }
      }
      res.end(batch);
      return null;
    },
    "DELETE /admin/api/errors": (req) => {
      db.prepare("UPDATE requests SET error = NULL WHERE failed = 1").run();
      audit(req, "Cleared error messages");
      return { ok: true };
    },
    "POST /admin/api/unblock": async (req) => {
      const b = await readJson(req);
      proxy.unblock(String(b.ip ?? ""));
      audit(req, "Unblocked address", String(b.ip ?? ""));
      return { ok: true };
    },

    // ---------- monitoring ----------
    "GET /admin/api/monitoring": (req, _id, q) => {
      const ranges = { "1h": 1, "24h": 24, "7d": 168, "30d": 720 };
      const hours = ranges[q.range] ?? 24;
      const rows = db
        .prepare("SELECT * FROM samples WHERE ts >= ? ORDER BY ts")
        .all(new Date(Date.now() - hours * 3600e3).toISOString());
      // At most ~240 points: average groups of samples.
      const per = Math.max(1, Math.ceil(rows.length / 240));
      const points = [];
      for (let i = 0; i < rows.length; i += per) {
        const g = rows.slice(i, i + per);
        const avg = (k) => {
          const v = g.map((r) => r[k]).filter((x) => x != null);
          return v.length
            ? Math.round(v.reduce((s, x) => s + x, 0) / v.length)
            : null;
        };
        const max = (k) => Math.max(0, ...g.map((r) => r[k] ?? 0));
        const accts = {};
        for (const r of g)
          for (const a of JSON.parse(r.accounts || "[]")) {
            accts[a.id] ??= { five: null, week: null };
            if (a.five != null) accts[a.id].five = a.five;
            if (a.week != null) accts[a.id].week = a.week;
          }
        points.push({
          ts: g[0].ts,
          up: g.every((r) => r.up) ? 1 : g.some((r) => r.up) ? 0.5 : 0,
          active: max("active"),
          queued: max("queued"),
          proxyMb: avg("proxy_mb"),
          backendMb: avg("backend_mb"),
          n: g.reduce((s, r) => s + (r.n ?? 0), 0),
          failed: g.reduce((s, r) => s + (r.failed ?? 0), 0),
          p50: avg("p50"),
          p95: max("p95"),
          accounts: accts,
        });
      }
      const off = zoneOffsetMin(cfg.timeZone);
      const days = {};
      for (const r of db
        .prepare("SELECT ts, up FROM samples WHERE ts >= ?")
        .iterate(since(90))) {
        const d = zoneDay(r.ts, off);
        days[d] ??= { n: 0, up: 0 };
        days[d].n++;
        days[d].up += r.up;
      }
      return {
        range: q.range ?? "24h",
        points,
        uptime: Object.entries(days)
          .sort()
          .map(([day, v]) => ({
            day,
            pct: Math.round((v.up / v.n) * 1000) / 10,
            samples: v.n,
          })),
      };
    },

    // ---------- alerts ----------
    "GET /admin/api/alerts": () => ({
      open: alerts
        .openList()
        .map((a) => ({ ...a, title: ALERT_INFO[a.kind]?.title ?? a.kind })),
      history: alerts
        .history(200)
        .map((a) => ({ ...a, title: ALERT_INFO[a.kind]?.title ?? a.kind })),
      rules: cfg.alerts.rules,
      ruleInfo: Object.fromEntries(
        Object.keys(ALERT_DEFAULTS).map((k) => [k, ALERT_INFO[k]]),
      ),
      repeatMinutes: cfg.alerts.repeatMinutes,
      quietFrom: cfg.alerts.quietFrom,
      quietTo: cfg.alerts.quietTo,
      channels: Object.fromEntries(
        Object.entries(cfg.notify).map(([name, c]) => [
          name,
          Object.fromEntries(
            Object.entries(c).map(([k, v]) => [
              k,
              SECRET_FIELDS[name]?.includes(k) ? { set: !!v } : v,
            ]),
          ),
        ]),
      ),
    }),
    "PATCH /admin/api/alerts/settings": async (req) => {
      const b = await readJson(req);
      const next = structuredClone(cfg.alerts);
      const nextNotify = structuredClone(cfg.notify);
      if (b.rules && typeof b.rules === "object")
        for (const [k, v] of Object.entries(b.rules)) {
          if (!ALERT_DEFAULTS[k] || typeof v !== "object") continue;
          for (const [f, val] of Object.entries(v)) {
            if (!(f in ALERT_DEFAULTS[k])) continue;
            if (f === "enabled") next.rules[k].enabled = !!val;
            else {
              const n = Number(val);
              if (!Number.isFinite(n) || n < 0 || n > 100000)
                return [400, { error: `${k}.${f} must be a number.` }];
              next.rules[k][f] = n;
            }
          }
        }
      if ("repeatMinutes" in b)
        next.repeatMinutes = Math.max(
          0,
          Math.min(10080, Math.floor(Number(b.repeatMinutes)) || 0),
        );
      for (const f of ["quietFrom", "quietTo"])
        if (f in b) {
          const v = String(b[f] ?? "").trim();
          if (v && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(v))
            return [
              400,
              { error: "Quiet hours use HH:MM, for example 22:00." },
            ];
          next[f] = v;
        }
      if (b.channels && typeof b.channels === "object")
        for (const [name, c] of Object.entries(b.channels)) {
          if (!NOTIFY_DEFAULTS[name] || typeof c !== "object") continue;
          for (const [f, val] of Object.entries(c)) {
            if (!(f in NOTIFY_DEFAULTS[name])) continue;
            // A secret is replaced only when a new value is typed.
            if (
              SECRET_FIELDS[name]?.includes(f) &&
              (val == null || typeof val === "object" || val === "")
            )
              continue;
            if (f === "enabled") nextNotify[name].enabled = !!val;
            else if (f === "minSeverity") {
              if (!["info", "warning", "critical"].includes(val))
                return [
                  400,
                  {
                    error:
                      "Minimum severity must be info, warning or critical.",
                  },
                ];
              nextNotify[name].minSeverity = val;
            } else if (f === "port")
              nextNotify[name].port = Math.max(
                1,
                Math.min(65535, Number(val) || 587),
              );
            else nextNotify[name][f] = String(val).trim().slice(0, 500);
          }
          if (name === "webhook" && nextNotify.webhook.url) {
            const bad = checkWebhookUrl(nextNotify.webhook.url);
            if (bad) return [400, { error: bad }];
          }
          if (
            name === "email" &&
            !["tls", "starttls", "none"].includes(nextNotify.email.security)
          )
            return [
              400,
              { error: "Email security must be tls, starttls or none." },
            ];
        }
      for (const [name, c] of Object.entries(b.clearSecrets ?? {}))
        if (c && SECRET_FIELDS[name])
          for (const f of SECRET_FIELDS[name]) nextNotify[name][f] = "";
      cfg.alerts = next;
      cfg.notify = nextNotify;
      saveConfig(cfg);
      audit(req, "Changed alert settings");
      return { ok: true };
    },
    "POST /admin/api/alerts/test/:id": async (req, id) => {
      if (!NOTIFY_DEFAULTS[id]) return [404, { error: "Unknown channel." }];
      const [r] = await notifier.test(id);
      audit(req, "Sent a test alert", id);
      return r ?? { ok: false, error: "Nothing was sent." };
    },
    "POST /admin/api/alerts/:id/dismiss": (req, id) => {
      if (!alerts.dismiss(+id)) return [404, { error: "Not found." }];
      audit(req, "Resolved an alert by hand", id);
      return { ok: true };
    },
    "POST /admin/api/monitor/run": async () => {
      await monitor.tick();
      return { ok: true };
    },

    // ---------- activity ----------
    "GET /admin/api/events": (req, _id, q) => {
      const where = [];
      const params = [];
      if (q.kind) {
        where.push("kind = ?");
        params.push(String(q.kind));
      }
      if (q.before) {
        where.push("id < ?");
        params.push(Number(q.before));
      }
      const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
      return db
        .prepare(
          `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`,
        )
        .all(...params);
    },

    // ---------- playground (streams the reply as server-sent events) ----------
    "POST /admin/api/playground": async (req, _id, _q, res) => {
      const b = await readJson(req, 200_000);
      const model = String(b.model || cfg.defaultModel);
      const body = {
        model,
        stream: true,
        max_tokens: Math.min(32000, Math.max(1, Number(b.maxTokens) || 512)),
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
      const account = b.account
        ? String(b.account)
        : (accounts.candidates(null).list[0]?.id ?? null);
      const ctrl = new AbortController();
      res.on("close", () => !res.writableFinished && ctrl.abort());
      await proxy.acquire(ctrl.signal).catch(() => {
        throw new HttpError(429, "The gateway is busy. Try again in a moment.");
      });
      const t0 = Date.now();
      const tracker = sseTracker();
      let status = 0;
      let error = null;
      try {
        const r = await fetch(cfg.upstream + "/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": cfg.internalKey,
            "anthropic-version": "2023-06-01",
            accept: "text/event-stream",
            ...accounts.headerFor(account),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any([
            ctrl.signal,
            AbortSignal.timeout(cfg.requestTimeoutMs),
          ]),
        });
        status = r.status;
        res.writeHead(r.status, {
          "content-type": r.headers.get("content-type") ?? "application/json",
          "cache-control": "no-cache",
        });
        for await (const chunk of r.body ?? []) {
          tracker.push(chunk);
          res.write(chunk);
        }
        if (!r.ok) error = `Status ${r.status}`;
      } catch (e) {
        error = e.message;
        if (!res.headersSent)
          res.writeHead(502, { "content-type": "application/json" });
        res.write(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: e.message },
          }),
        );
      } finally {
        res.end();
        proxy.release();
      }
      proxy.log({
        ip: clientIp(req, cfg.trustedProxy),
        method: "POST",
        path: "/playground",
        model,
        stream: true,
        account,
        status: status || 502,
        ms: Date.now() - t0,
        ...tracker.usage,
        cost: proxy.costOf(model, tracker.usage),
        error: error ?? tracker.error,
        stop_reason: tracker.stopReason,
        max_tokens: body.max_tokens,
      });
      return null;
    },

    // ---------- settings ----------
    "GET /admin/api/settings": () => ({
      ...Object.fromEntries(Object.keys(EDITABLE).map((k) => [k, cfg[k]])),
      pricing: cfg.pricing,
      version: VERSION,
      metricsToken: cfg.metricsEnabled ? cfg.metricsToken : null,
      ports: {
        https: scheme === "https" ? cfg.port : null,
        http: scheme === "https" ? cfg.httpPort : cfg.port,
      },
    }),
    "PATCH /admin/api/settings": async (req) => {
      const b = await readJson(req);
      const { values, error } = validateSettings(b);
      if (error) return [400, { error }];
      const pricing = structuredClone(cfg.pricing);
      if (b.pricing && typeof b.pricing === "object")
        for (const [fam, p] of Object.entries(b.pricing)) {
          if (!pricing[fam]) continue;
          if (num(p?.in) == null || num(p?.out) == null)
            return [400, { error: `Prices for ${fam} must be numbers.` }];
          pricing[fam] = { in: num(p.in), out: num(p.out) };
        }
      const restartBackend = ["maxConcurrent", "enforceMaxTokens"].some(
        (k) => k in values && values[k] !== cfg[k],
      );
      Object.assign(cfg, values, { pricing });
      if (cfg.metricsEnabled && !cfg.metricsToken)
        cfg.metricsToken = randomBytes(18).toString("base64url");
      saveConfig(cfg);
      audit(
        req,
        `Changed settings: ${Object.keys(values).join(", ") || "prices"}`,
      );
      return { ok: true, restartBackend };
    },
    "GET /admin/api/settings/export": () => {
      const {
        internalKey,
        sessionSecret,
        adminPasswordHash,
        metricsToken,
        ...rest
      } = cfg;
      (void internalKey, sessionSecret, adminPasswordHash, metricsToken);
      const notify = Object.fromEntries(
        Object.entries(rest.notify).map(([n, c]) => [
          n,
          Object.fromEntries(
            Object.entries(c).filter(([k]) => !SECRET_FIELDS[n]?.includes(k)),
          ),
        ]),
      );
      return {
        exportedAt: new Date().toISOString(),
        version: VERSION,
        settings: { ...rest, notify },
        models: db.prepare("SELECT * FROM models").all(),
      };
    },
    "POST /admin/api/settings/import": async (req) => {
      const b = await readJson(req, 500_000);
      const s = b.settings ?? {};
      const { values, error } = validateSettings(s);
      if (error) return [400, { error }];
      Object.assign(cfg, values);
      if (s.pricing && typeof s.pricing === "object")
        for (const [fam, p] of Object.entries(s.pricing))
          if (num(p?.in) != null && num(p?.out) != null)
            cfg.pricing[fam] = { in: num(p.in), out: num(p.out) };
      if (s.alerts?.rules)
        for (const [k, v] of Object.entries(s.alerts.rules))
          if (cfg.alerts.rules[k] && typeof v === "object")
            Object.assign(cfg.alerts.rules[k], v);
      for (const f of ["repeatMinutes", "quietFrom", "quietTo"])
        if (s.alerts && f in s.alerts) cfg.alerts[f] = s.alerts[f];
      if (s.notify)
        for (const [n, c] of Object.entries(s.notify))
          if (cfg.notify[n] && typeof c === "object")
            for (const [k, v] of Object.entries(c))
              if (k in NOTIFY_DEFAULTS[n] && !SECRET_FIELDS[n]?.includes(k))
                cfg.notify[n][k] = v;
      const up = db.prepare(
        `INSERT INTO models (id, enabled, max_tokens_cap, price_in, price_out, aliases, note) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, max_tokens_cap=excluded.max_tokens_cap,
           price_in=excluded.price_in, price_out=excluded.price_out, aliases=excluded.aliases, note=excluded.note`,
      );
      for (const m of Array.isArray(b.models) ? b.models : [])
        if (m?.id)
          up.run(
            String(m.id),
            m.enabled ? 1 : 0,
            int(m.max_tokens_cap),
            num(m.price_in),
            num(m.price_out),
            m.aliases ?? null,
            m.note ?? null,
          );
      saveConfig(cfg);
      audit(req, "Imported settings");
      return { ok: true };
    },
    "POST /admin/api/password": async (req) => {
      const b = await readJson(req);
      if (!checkPassword(b.current ?? "", cfg.adminPasswordHash))
        return [400, { error: "Current password is wrong." }];
      if (String(b.next ?? "").length < 10)
        return [400, { error: "Use at least 10 characters." }];
      cfg.adminPasswordHash = hashPassword(String(b.next));
      cfg.passwordChangedAt = new Date().toISOString();
      cfg.sessionEpoch++; // signs out every other session
      saveConfig(cfg);
      audit(req, "Changed the dashboard password");
      return (
        send(
          req.res,
          200,
          { ok: true },
          { "set-cookie": cookie(req, makeSession(), 604800) },
        ),
        null
      );
    },
    "POST /admin/api/logout-all": (req) => {
      cfg.sessionEpoch++;
      saveConfig(cfg);
      audit(req, "Signed out every session");
      return { ok: true };
    },
    "POST /admin/api/restart-backend": async (req) => {
      if (!backend.restart())
        return [
          500,
          {
            error:
              "The gateway is not running under its supervisor (start it with: node proxy/cli.mjs start).",
          },
        ];
      audit(req, "Restarted the backend");
      return { ok: true };
    },
  };

  // Compile "METHOD /a/:id/b" into regexes once.
  const table = Object.entries(routes).map(([k, fn]) => {
    const [method, pattern] = k.split(" ");
    const re = new RegExp(
      "^" + pattern.replace(/[.]/g, "\\.").replace(/:id/g, "([^/]+)") + "$",
    );
    return { method, re, fn, literal: !pattern.includes(":id") };
  });
  // Literal paths win over ":id" paths (e.g. /accounts/order before /accounts/:id).
  table.sort((a, b) => Number(b.literal) - Number(a.literal));

  async function login(req, res) {
    const ip = clientIp(req, cfg.trustedProxy);
    const t = Date.now();
    globalFails = globalFails.filter((x) => t - x < 60_000);
    const f = loginFails.get(ip) ?? { n: 0, until: 0 };
    if (f.until > t || globalFails.length >= 30)
      return send(
        res,
        429,
        { error: "Too many attempts. Wait a minute." },
        { "retry-after": "60" },
      );
    const { password } = await readJson(req, 10_000);
    if (!password || !checkPassword(password, cfg.adminPasswordHash)) {
      f.n++;
      globalFails.push(t);
      if (f.n >= 5) Object.assign(f, { n: 0, until: t + 60_000 });
      loginFails.set(ip, f);
      events.add("login_failed", ip, "Wrong dashboard password", null, ip);
      return send(res, 401, { error: "Wrong password." });
    }
    loginFails.delete(ip);
    events.add("login", ip, "Signed in to the dashboard", "admin", ip);
    return send(
      res,
      200,
      { ok: true },
      { "set-cookie": cookie(req, makeSession(), 604800) },
    );
  }

  async function handle(req, res, path, url) {
    req.res = res;
    try {
      if (path === "/admin/login" && req.method === "POST")
        return await login(req, res);
      // State-changing calls must come from our own page: a custom header can't be sent cross-site without CORS.
      if (req.method !== "GET" && req.headers["x-cgw"] !== "1")
        return send(res, 403, { error: "Bad request origin." });
      if (path === "/admin/logout" && req.method === "POST")
        return send(
          res,
          200,
          { ok: true },
          { "set-cookie": cookie(req, "", 0) },
        );
      if (!isAdmin(req)) return send(res, 401, { error: "Sign in first." });

      let hit = null;
      for (const r of table) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(path);
        if (m) {
          hit = { fn: r.fn, id: m[1] };
          break;
        }
      }
      if (!hit) return send(res, 404, { error: "Not found." });
      const out = await hit.fn(
        req,
        hit.id,
        Object.fromEntries(url.searchParams),
        res,
      );
      if (out === null || res.headersSent) return;
      if (Array.isArray(out) && typeof out[0] === "number")
        return send(res, out[0], out[1]);
      return send(res, 200, out);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError)
        return send(res, e.status, { error: e.message });
      if (/UNIQUE constraint/.test(e.message))
        return send(res, 400, { error: "That name is already used." });
      console.error(e);
      return send(res, 500, {
        error: "Something went wrong. Details are in logs/proxy.log.",
      });
    }
  }

  return { handle, isAdmin };
}
