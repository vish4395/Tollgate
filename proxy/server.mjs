// Claude gateway: per-project API keys, limits and usage tracking in front of Meridian.
// Plain Node 22, no npm dependencies.
import http from "node:http";
import https from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadConfig, saveConfig, hashPassword } from "./config.mjs";
import { openDb, newKey } from "./db.mjs";
import { createUpstream } from "./upstream.mjs";
import { createProxy } from "./proxy.mjs";
import { createAdmin } from "./admin.mjs";
import { send, apiError } from "./http-util.mjs";

const cfg = loadConfig();
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

// ---------- TLS ----------
const CERT = join(ROOT, "certs/gateway.pem");
const CERT_KEY = join(ROOT, "certs/gateway-key.pem");
const TLS =
  existsSync(CERT) && existsSync(CERT_KEY)
    ? { cert: readFileSync(CERT), key: readFileSync(CERT_KEY) }
    : null;
const SCHEME = TLS ? "https" : "http";

const upstream = createUpstream(cfg);
const proxy = createProxy({ cfg, db, upstream });
// The supervisor (gateway.mjs) runs the backend and tells us its process id over IPC.
let backendPid = null;
process.on("message", (m) => {
  if (m?.type === "backend-pid") backendPid = m.pid;
});
const backend = {
  pid: () => backendPid,
  restart: () =>
    process.send ? (process.send({ type: "restart-backend" }), true) : false,
};
const admin = createAdmin({
  cfg,
  db,
  upstream,
  proxy,
  scheme: SCHEME,
  backend,
});

const API_PATHS = [
  "/v1/messages",
  "/v1/chat/completions",
  "/v1/models",
  "/v1/messages/count_tokens",
];
const PAGE = join(ROOT, "proxy/public/index.html");
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    if (path === "/health") {
      const up = await upstream.health();
      return send(res, up.ok ? 200 : 503, {
        status: up.ok ? "ok" : "degraded",
        backend: up.status,
      });
    }
    if (path.startsWith("/v1/")) {
      if (!API_PATHS.includes(path) && !path.startsWith("/v1/models/"))
        return apiError(res, 404, "not_found_error", "Unknown endpoint.");
      return await proxy.handle(req, res, path);
    }
    if (path.startsWith("/admin/"))
      return await admin.handle(req, res, path, url);
    if (path === "/" && req.method === "GET")
      return send(res, 200, readFileSync(PAGE, "utf8"), PAGE_HEADERS);
    return send(res, 404, "Not found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) apiError(res, 500, "api_error", "Gateway error.");
    else res.end();
  }
}

function start(server, port, scheme) {
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.listen(port, cfg.host, () =>
    console.log(
      `Gateway on ${scheme}://${cfg.host}:${port} (LAN: ${scheme}://${cfg.publicHost}:${port}) -> ${cfg.upstream}`,
    ),
  );
}
if (TLS) {
  start(https.createServer(TLS, handler), cfg.port, "https");
  if (cfg.httpPort) start(http.createServer(handler), cfg.httpPort, "http");
} else start(http.createServer(handler), cfg.port, "http");

// Keep the model list and quota warm, and prune old rows daily.
upstream.listModels(true);
setInterval(() => upstream.getQuota(true), 60_000).unref();
const prune = () =>
  db
    .prepare("DELETE FROM requests WHERE ts < ?")
    .run(new Date(Date.now() - cfg.retentionDays * 864e5).toISOString());
prune();
setInterval(prune, 6 * 3600e3).unref();
