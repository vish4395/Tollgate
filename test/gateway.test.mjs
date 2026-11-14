import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fakeBackend, startGateway } from "./helpers.mjs";

const lastRow = (gw) => new DatabaseSync(join(gw.dir, "gateway.db")).prepare("SELECT * FROM requests ORDER BY id DESC LIMIT 1").get();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("keys, limits and logging", () => {
  let be, gw, key;
  before(async () => {
    be = await fakeBackend();
    gw = await startGateway(be);
    key = gw.key("app");
    await gw.admin("/admin/api/accounts/refresh", { method: "POST" });
  });
  after(async () => {
    await gw.stop();
    await be.close();
  });

  test("rejects a missing or wrong key", async () => {
    assert.equal((await gw.call("")).status, 401);
    assert.equal((await gw.call("cgw_nope")).status, 401);
  });

  test("forwards with the internal key and logs tokens", async () => {
    const r = await gw.call(key);
    assert.equal(r.status, 200);
    assert.ok(r.headers.get("x-gateway-request-id"));
    assert.equal(be.hits.at(-1).headers["x-api-key"], "internal-test-key");
    const row = lastRow(gw);
    assert.equal(row.in_tok, 10);
    assert.equal(row.out_tok, 3);
    assert.equal(row.cache_read, 5);
    assert.equal(row.failed, 0);
    assert.equal(row.account, "default");
  });

  test("counts tokens on OpenAI-style streams", async () => {
    const r = await gw.call(key, { stream: true }, {}, "/v1/chat/completions");
    await r.text();
    await wait(50);
    assert.equal(be.hits.at(-1).body.stream_options.include_usage, true);
    const row = lastRow(gw);
    assert.equal(row.in_tok, 10);
    assert.equal(row.cache_read, 90);
    assert.equal(row.out_tok, 4);
    assert.equal(row.stop_reason, "stop");
  });

  test("allowed models match exactly, not by substring", async () => {
    const p = (await gw.admin("/admin/api/projects")).body.find((x) => x.name === "app");
    await gw.admin(`/admin/api/projects/${p.id}`, { method: "PATCH", body: { allowedModels: "haiku" } });
    assert.equal((await gw.call(key)).status, 403, "'haiku' is not an id or alias yet");
    await gw.admin("/admin/api/models/claude-haiku-5-5", { method: "PATCH", body: { aliases: "haiku" } });
    assert.equal((await gw.call(key)).status, 200);
    assert.equal((await gw.call(key, { model: "claude-sonnet-5-5" })).status, 403);
    await gw.admin(`/admin/api/projects/${p.id}`, { method: "PATCH", body: { allowedModels: "" } });
  });

  test("requests per minute and per day", async () => {
    const k = gw.key("capped");
    const p = (await gw.admin("/admin/api/projects")).body.find((x) => x.name === "capped");
    await gw.admin(`/admin/api/projects/${p.id}`, { method: "PATCH", body: { rpmCap: 2 } });
    assert.equal((await gw.call(k)).status, 200);
    assert.equal((await gw.call(k)).status, 200);
    const third = await gw.call(k);
    assert.equal(third.status, 429);
    assert.match((await third.json()).error.message, /per minute/);
    await gw.admin(`/admin/api/projects/${p.id}`, { method: "PATCH", body: { rpmCap: "", dailyRequestCap: 2 } });
    assert.equal((await gw.call(k)).status, 429, "two successful requests already today");
  });

  test("count_tokens does not use up request caps", async () => {
    const k = gw.key("counter");
    const p = (await gw.admin("/admin/api/projects")).body.find((x) => x.name === "counter");
    await gw.admin(`/admin/api/projects/${p.id}`, { method: "PATCH", body: { dailyRequestCap: 1 } });
    for (let i = 0; i < 3; i++) assert.equal((await gw.call(k, {}, {}, "/v1/messages/count_tokens")).status, 200);
    assert.equal((await gw.call(k)).status, 200);
  });

  test("an expiry date lasts to the end of that day", async () => {
    const k = gw.key("expiring");
    const p = (await gw.admin("/admin/api/projects")).body.find((x) => x.name === "expiring");
    const today = new Date().toISOString().slice(0, 10);
    await gw.admin(`/admin/api/projects/${p.id}`, { method: "PATCH", body: { expiresAt: today } });
    assert.equal((await gw.call(k)).status, 200);
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    await gw.admin(`/admin/api/projects/${p.id}`, { method: "PATCH", body: { expiresAt: yesterday } });
    assert.equal((await gw.call(k)).status, 403);
  });

  test("bad admin input is a 400, not a 500", async () => {
    const p = (await gw.admin("/admin/api/projects")).body[0];
    assert.equal((await gw.admin(`/admin/api/projects/${p.id}`, { method: "PATCH", body: { name: "capped" } })).status, 400);
    assert.equal((await gw.admin(`/admin/api/projects/${p.id}`, { method: "PATCH", body: { expiresAt: "not a date" } })).status, 400);
    assert.equal((await gw.admin("/admin/api/settings", { method: "PATCH", body: { maxQueue: 5, maxConcurrent: 99 } })).status, 400);
    assert.notEqual((await gw.admin("/admin/api/settings")).body.maxQueue, 5, "nothing is saved when one value is wrong");
  });

  test("a forged proxy header does not change the logged address", async () => {
    await gw.call("cgw_bad", {}, { "cf-connecting-ip": "6.6.6.6", "x-forwarded-for": "7.7.7.7" });
    assert.equal(lastRow(gw).ip, "127.0.0.1");
  });

  test("body size limit", async () => {
    const big = "x".repeat(11_000_000);
    const r = await gw.call(key, { messages: [{ role: "user", content: big }] });
    assert.equal(r.status, 413);
  });

  test("admin needs the custom header for changes", async () => {
    const r = await fetch(gw.url + "/admin/api/logout-all", { method: "POST" });
    assert.equal(r.status, 403);
  });
});

describe("CORS", () => {
  let be, gw, key, id;
  before(async () => {
    be = await fakeBackend();
    gw = await startGateway(be);
    key = gw.key("web");
    id = (await gw.admin("/admin/api/projects")).body[0].id;
    await gw.admin(`/admin/api/projects/${id}`, { method: "PATCH", body: { allowedOrigins: "http://localhost:5173" } });
  });
  after(async () => {
    await gw.stop();
    await be.close();
  });
  test("preflight for an allowed origin", async () => {
    const r = await fetch(gw.url + "/v1/messages", { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "http://localhost:5173");
  });
  test("other origins are refused", async () => {
    const pre = await fetch(gw.url + "/v1/messages", { method: "OPTIONS", headers: { origin: "http://evil.test" } });
    assert.equal(pre.status, 403);
    assert.equal((await gw.call(key, {}, { origin: "http://evil.test" })).status, 403);
    assert.equal((await gw.call(key, {}, { origin: "http://localhost:5173" })).status, 200);
  });
});

describe("accounts and fallback", () => {
  let be, gw, key;
  before(async () => {
    be = await fakeBackend({ profiles: ["a", "b"], mode: {} });
    gw = await startGateway(be);
    key = gw.key("app");
    await gw.admin("/admin/api/accounts/refresh", { method: "POST" });
  });
  after(async () => {
    await gw.stop();
    await be.close();
  });

  test("pins each request to the first account", async () => {
    assert.equal((await gw.call(key)).status, 200);
    assert.equal(be.hits.at(-1).profile, "a");
  });

  test("falls back when an account is rate limited, and pauses it", async () => {
    be.mode.a = "limited";
    const r = await gw.call(key);
    assert.equal(r.status, 200);
    const row = lastRow(gw);
    assert.equal(row.account, "b");
    assert.equal(row.attempts, 2);
    const a = (await gw.admin("/admin/api/accounts")).body.accounts.find((x) => x.id === "a");
    assert.equal(a.state, "limited");
    assert.ok(a.cooldownUntil > Date.now() + 100_000, "uses retry-after");
    // While paused, a is skipped without trying it.
    const before = be.hits.length;
    await gw.call(key);
    assert.equal(be.hits.length - before, 1);
    assert.equal(be.hits.at(-1).profile, "b");
    be.mode.a = "ok";
    await gw.admin("/admin/api/accounts/a/resume", { method: "POST" });
  });

  test("falls back on an error at the start of a stream", async () => {
    be.mode.a = "stream_limited";
    const r = await gw.call(key, { stream: true });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.match(text, /message_start/);
    assert.doesNotMatch(text, /limit in stream/);
    await wait(50);
    assert.equal(lastRow(gw).account, "b");
    be.mode.a = "ok";
    await gw.admin("/admin/api/accounts/a/resume", { method: "POST" });
  });

  test("marks a signed-out account and moves on", async () => {
    be.mode.a = "signed_out";
    assert.equal((await gw.call(key)).status, 200);
    const a = (await gw.admin("/admin/api/accounts")).body.accounts.find((x) => x.id === "a");
    assert.equal(a.state, "signed_out");
    be.mode.a = "ok";
    await gw.admin("/admin/api/accounts/a/resume", { method: "POST" });
  });

  test("a project limited to one account uses only that one", async () => {
    const p = (await gw.admin("/admin/api/projects")).body[0];
    await gw.admin(`/admin/api/projects/${p.id}`, { method: "PATCH", body: { accounts: "b" } });
    await gw.call(key);
    assert.equal(be.hits.at(-1).profile, "b");
    be.mode.b = "limited";
    const r = await gw.call(key);
    assert.equal(r.status, 429);
    assert.ok(r.headers.get("retry-after"));
    be.mode.b = "ok";
    await gw.admin("/admin/api/accounts/b/resume", { method: "POST" });
    assert.equal((await gw.admin(`/admin/api/projects/${p.id}`, { method: "PATCH", body: { accounts: "zzz" } })).status, 400);
    await gw.admin(`/admin/api/projects/${p.id}`, { method: "PATCH", body: { accounts: "" } });
  });

  test("account order and turning one off", async () => {
    await gw.admin("/admin/api/accounts/order", { method: "POST", body: { ids: ["b", "a"] } });
    await gw.call(key);
    assert.equal(be.hits.at(-1).profile, "b");
    await gw.admin("/admin/api/accounts/b", { method: "PATCH", body: { enabled: false } });
    await gw.call(key);
    assert.equal(be.hits.at(-1).profile, "a");
  });

  test("an alert opens when no account can serve, and the request log says why", async () => {
    be.mode.a = "limited";
    be.mode.b = "limited";
    await gw.admin("/admin/api/accounts/b", { method: "PATCH", body: { enabled: true } });
    const r = await gw.call(key);
    assert.equal(r.status, 429);
    const alerts = (await gw.admin("/admin/api/alerts")).body.open;
    assert.ok(alerts.some((x) => x.kind === "no_account"));
    const events = (await gw.admin("/admin/api/events?kind=fallback")).body;
    assert.ok(events.length >= 1);
  });
});

describe("queue and disconnects", () => {
  let be, gw, key;
  before(async () => {
    be = await fakeBackend({ mode: { "": "hang" } });
    gw = await startGateway(be, { maxConcurrent: 1, maxQueue: 5, queueTimeoutMs: 800, requestTimeoutMs: 60000 });
    key = gw.key("app");
  });
  after(async () => {
    await gw.stop();
    await be.close();
  });

  test("a waiting request gives up after the queue timeout", async () => {
    const ctrl = new AbortController();
    const first = gw.call(key, {}, {}).catch(() => {});
    void first;
    await wait(150);
    const second = await gw.call(key);
    assert.equal(second.status, 429);
    assert.match((await second.json()).error.message, /waited too long/);
    void ctrl;
  });

  test("a client that leaves frees its slot", async () => {
    // The first request (still hanging) holds the only slot. Abort a new one, then check the slot count.
    const status = async () => (await gw.admin("/admin/api/status")).body;
    const ctrl = new AbortController();
    gw.call(key, {}, {}).catch(() => {}); // queued behind the hanging one
    const p = fetch(gw.url + "/v1/messages", { method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }) }).catch(() => {});
    await wait(100);
    ctrl.abort();
    await p;
    await wait(200);
    const s = await status();
    assert.ok(s.queued <= 1, `queued ${s.queued}`);
  });
});
