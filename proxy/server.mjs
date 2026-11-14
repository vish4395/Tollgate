// Claude gateway: per-project API keys, Claude accounts with fallback, limits, usage tracking,
// monitoring and alerts in front of the Claude backend. Plain Node 22, no npm dependencies.
import http from "node:http";
import https from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, VERSION, loadConfig, saveConfig, hashPassword } from "./config.mjs";
import { openDb, newKey, prune } from "./db.mjs";
import { anyProjectAllows, preflight, setCors } from "./cors.mjs";
import { createUpstream } from "./upstream.mjs";
import { createEvents } from "./events.mjs";
import { createAccounts } from "./accounts.mjs";
import { createNotifier } from "./notify.mjs";
import { createAlerts } from "./alerts.mjs";
import { createProxy } from "./proxy.mjs";
import { createMonitor } from "./monitor.mjs";
import { createAdmin } from "./admin.mjs";
import { metricsText } from "./metrics.mjs";
import { send, apiError } from "./http-util.mjs";

const cfg = loadConfig();
const db = openDb(process.env.GATEWAY_DB ?? join(ROOT, "gateway.db"));

// ---------- CLI ----------
const [cmd, ...args] = process.argv.slice(2);
if (cmd === "set-password") {
  if (String(args[0] ?? "").length < 10) {
    console.error("Usage: set-password <new password, at least 10 characters>");
    process.exit(1);
  }
  cfg.adminPasswordHash = hashPassword(args[0]);
  cfg.passwordChangedAt = new Date().toISOString();
  cfg.sessionEpoch++;
  saveConfig(cfg);
  console.log("Admin password changed. Every dashboard session was signed out.");
  process.exit(0);
}
if (cmd === "add-project") {
  if (!args[0]) throw new Error("Usage: add-project <name>");
  const k = newKey();
  db.prepare("INSERT INTO projects (name, key_prefix, key_hash) VALUES (?, ?, ?)").run(args[0], k.prefix, k.hash);
  console.log(`Project "${args[0]}" key: ${k.key}`);
  process.exit(0);
}

// ---------- TLS ----------
const CERT = join(process.env.GATEWAY_HOME ?? ROOT, "certs/gateway.pem");
const CERT_KEY = join(process.env.GATEWAY_HOME ?? ROOT, "certs/gateway-key.pem");
const TLS = existsSync(CERT) && existsSync(CERT_KEY) ? { cert: readFileSync(CERT), key: readFileSync(CERT_KEY) } : null;
const SCHEME = TLS ? "https" : "http";

// ---------- parts ----------
// The supervisor (gateway.mjs) runs the backend and talks to us over IPC.
let backendPid = null;
const events = createEvents(db);
process.on("message", (m) => {
  if (m?.type === "backend-pid") backendPid = m.pid;
  if (m?.type === "backend-exit") events.add("backend_restart", "backend", `Backend stopped (code ${m.code}, signal ${m.signal}); restarting`);
});
const backend = {
  pid: () => backendPid,
  restart: () => (process.send ? (process.send({ type: "restart-backend" }), true) : false),
};
const upstream = createUpstream(cfg);
const accounts = createAccounts({ cfg, db, upstream, events });
const notifier = createNotifier({ cfg, events });
const alerts = createAlerts({ cfg, db, notifier, events });
const proxy = createProxy({ cfg, db, upstream, accounts, events, alerts });
const monitor = createMonitor({ cfg, db, upstream, accounts, proxy, alerts, events, backend });
const admin = createAdmin({ cfg, db, upstream, proxy, accounts, alerts, notifier, events, monitor, scheme: SCHEME, backend });

const API_PATHS = ["/v1/messages", "/v1/chat/completions", "/v1/models", "/v1/messages/count_tokens"];
const PUBLIC = join(ROOT, "proxy/public");
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
};
const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

let draining = false;
async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    if (path === "/health") {
      const up = await upstream.health();
      return send(res, up.ok && !draining ? 200 : 503, { status: draining ? "draining" : up.ok ? "ok" : "degraded", backend: up.status, version: VERSION });
    }
    if (path.startsWith("/v1/")) {
      const origin = req.headers.origin;
      if (origin && anyProjectAllows(db, origin)) {
        if (req.method === "OPTIONS") return preflight(req, res, origin);
        setCors(req, res, origin);
      } else if (req.method === "OPTIONS") return send(res, 403, "Origin not allowed.");
      if (draining) return apiError(res, 503, "overloaded_error", "The gateway is restarting. Try again in a few seconds.", { "retry-after": "5" });
      if (!API_PATHS.includes(path) && !path.startsWith("/v1/models/")) return apiError(res, 404, "not_found_error", "Unknown endpoint.");
      return await proxy.handle(req, res, path);
    }
    if (path === "/metrics") {
      const tokenOk = cfg.metricsEnabled && cfg.metricsToken && req.headers.authorization === `Bearer ${cfg.metricsToken}`;
      if (!tokenOk && !admin.isAdmin(req)) return send(res, cfg.metricsEnabled ? 401 : 404, cfg.metricsEnabled ? "Bearer token required." : "Not found");
      return send(res, 200, metricsText({ db, proxy, accounts, alerts, monitor }), { "content-type": "text/plain; version=0.0.4" });
    }
    if (path.startsWith("/admin/")) return await admin.handle(req, res, path, url);
    const file = STATIC[path];
    if (file && req.method === "GET") return send(res, 200, readFileSync(join(PUBLIC, file[0]), "utf8"), { ...PAGE_HEADERS, "content-type": file[1] });
    return send(res, 404, "Not found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) apiError(res, 500, "api_error", "Gateway error.");
    else res.end();
  }
}

const servers = [];
function start(server, port, scheme) {
  server.requestTimeout = 0; // long replies are fine; bodies have their own read timeout
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  server.on("error", (e) => {
    console.error(`Can't listen on ${cfg.host}:${port}: ${e.code === "EADDRINUSE" ? "another program is using this port" : e.message}`);
    // Wait before exiting so the supervisor doesn't spin.
    setTimeout(() => process.exit(1), 15_000);
  });
  server.listen(port, cfg.host, () => console.log(`Gateway ${VERSION} on ${scheme}://${cfg.host}:${port} (LAN: ${scheme}://${cfg.publicHost}:${port}) -> ${cfg.upstream}`));
  servers.push(server);
}
if (TLS) {
  start(https.createServer(TLS, handler), cfg.port, "https");
  if (cfg.httpPort) start(http.createServer(handler), cfg.httpPort, "http");
} else start(http.createServer(handler), cfg.port, "http");

// ---------- background work ----------
upstream.listModels(true);
monitor.start();
const safePrune = () => {
  try {
    prune(db, cfg.retentionDays);
  } catch (e) {
    console.error("prune failed", e.message);
  }
};
safePrune();
setInterval(safePrune, 6 * 3600e3).unref();
events.add("gateway_start", null, `Gateway ${VERSION} started`);

// ---------- stay up, and stop gently ----------
process.on("unhandledRejection", (e) => console.error("unhandled rejection", e));
process.on("uncaughtException", (e) => {
  console.error("uncaught exception", e);
  process.exit(1); // the supervisor starts a clean copy
});
function shutdown() {
  if (draining) return;
  draining = true;
  console.log("Draining: finishing running requests (up to 20 s)");
  for (const s of servers) s.close();
  const t0 = Date.now();
  const wait = setInterval(() => {
    const { active, queued } = proxy.stats();
    if ((active === 0 && queued === 0) || Date.now() - t0 > 20_000) {
      clearInterval(wait);
      try {
        db.close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    }
  }, 200);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("message", (m) => m?.type === "shutdown" && shutdown());
