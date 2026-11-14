// Test helpers: a fake Claude backend and a gateway started against it in a temp folder.
import http from "node:http";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../proxy/config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PASSWORD = "test-password-123";

export const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const okMessage = (model) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model,
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
});

/**
 * Fake backend. `mode[profile]` decides what each account does:
 *   ok | limited | signed_out | stream_limited | server_error | hang
 * Profile "" is a request without the account header.
 */
export async function fakeBackend({ profiles = [], mode = {} } = {}) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || "{}") : {};
    const profile = req.headers["x-meridian-profile"] ?? "";
    const url = req.url.split("?")[0];
    if (url === "/health") return json(res, 200, { status: "healthy", version: "fake", auth: { loggedIn: true, planLabel: "Max" } });
    if (url === "/profiles/list") return json(res, 200, { profiles: profiles.map((id) => ({ id, loggedIn: mode[id] !== "signed_out_listed", email: `${id}@x` })) });
    if (url === "/v1/usage/quota/all")
      return json(res, 200, { profiles: (profiles.length ? profiles : ["default"]).map((id) => ({ id, windows: [{ type: "five_hour", utilization: 0.1, resetsAt: Date.now() + 3600e3 }, { type: "seven_day", utilization: 0.2, resetsAt: Date.now() + 864e5 }] })) });
    if (url === "/v1/models") return json(res, 200, { data: [{ id: "claude-haiku-5-5", display_name: "Haiku" }, { id: "claude-sonnet-5-5", display_name: "Sonnet" }] });
    if (url === "/telemetry/summary") return json(res, 200, {});
    if (req.headers["x-api-key"] !== "internal-test-key") return json(res, 401, { type: "error", error: { type: "authentication_error", message: "bad internal key" } });
    hits.push({ url, profile, body, headers: req.headers });
    const m = mode[profile] ?? "ok";
    if (m === "limited") return json(res, 429, { type: "error", error: { type: "rate_limit_error", message: "Claude Max rate limit reached." }, retry_after: 120 }, { "retry-after": "120" });
    if (m === "signed_out") return json(res, 401, { type: "error", error: { type: "authentication_error", message: "Not logged in" } });
    if (m === "server_error") return json(res, 502, { type: "error", error: { type: "api_error", message: "boom" } });
    if (m === "hang") return; // never answers
    if (body.stream && m === "stream_limited") return sse(res, [{ type: "error", error: { type: "rate_limit_error", message: "limit in stream" } }]);
    if (url === "/v1/chat/completions") {
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 90 } } })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      return json(res, 200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2 } });
    }
    if (body.stream) {
      const msg = okMessage(body.model);
      return sse(res, [
        { type: "message_start", message: { ...msg, content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ]);
    }
    return json(res, 200, okMessage(body.model));
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${port}`, hits, mode, profiles, close: () => new Promise((r) => server.close(r)) };
}

/** Starts a gateway in a temp folder. Returns { url, key(name), admin(path, opts), stop }. */
export async function startGateway(backend, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cgw-test-"));
  const port = await freePort();
  writeFileSync(join(dir, ".internal-key"), "internal-test-key");
  const cfg = {
    host: "127.0.0.1",
    port,
    httpPort: null,
    publicHost: "127.0.0.1",
    upstream: backend.url,
    internalKey: "internal-test-key",
    sessionSecret: "s".repeat(64),
    adminPasswordHash: hashPassword(PASSWORD),
    timeZone: "UTC",
    ...overrides,
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
  const env = { ...process.env, GATEWAY_CONFIG: join(dir, "config.json"), GATEWAY_DB: join(dir, "gateway.db"), GATEWAY_HOME: dir };
  const server = join(ROOT, "proxy", "server.mjs");
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", server], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url + "/health")).status) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  let cookie = null;
  const admin = async (path, opts = {}) => {
    if (!cookie) {
      const r = await fetch(url + "/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
      cookie = r.headers.get("set-cookie").split(";")[0];
    }
    const r = await fetch(url + path, {
      method: opts.method ?? "GET",
      headers: { cookie, "x-cgw": "1", "content-type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const ct = r.headers.get("content-type") ?? "";
    return { status: r.status, body: ct.includes("json") ? await r.json() : await r.text() };
  };
  const key = (name) => {
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", server, "add-project", name], { env, encoding: "utf8" });
    return /cgw_[\w-]+/.exec(r.stdout)?.[0];
  };
  return {
    url,
    dir,
    admin,
    key,
    log: () => log,
    call: (k, body, headers = {}, path = "/v1/messages") =>
      fetch(url + path, { method: "POST", headers: { "content-type": "application/json", "x-api-key": k, ...headers }, body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 20, messages: [{ role: "user", content: "hi" }], ...body }) }),
    async stop() {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.once("exit", r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
