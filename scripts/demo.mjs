#!/usr/bin/env node
// Try the dashboard without a Claude account: starts Tollgate against a fake backend with sample
// data in a temporary folder. Nothing touches your real gateway, accounts or data.
//   npm run demo            then open http://127.0.0.1:4199 (password: test-password-123)
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fakeBackend, startGateway } from "../test/helpers.mjs";

const PORT = Number(process.env.DEMO_PORT ?? 4199);
const be = await fakeBackend({
  profiles: ["work", "personal", "spare"],
  quota: { work: [0.86, 0.64], personal: [0.31, 0.42], spare: [0.04, 0.12] },
  delayMs: 600,
});
const gw = await startGateway(be, { publicHost: "192.168.1.20", timeZone: "UTC" }, { port: PORT });
await gw.admin("/admin/api/accounts/refresh", { method: "POST" });

// Projects, with a few limits and account choices.
const names = ["crm", "support-bot", "docs-search", "mobile-app"];
const keys = Object.fromEntries(names.map((n) => [n, gw.key(n)]));
const projects = (await gw.admin("/admin/api/projects")).body;
const id = (n) => projects.find((p) => p.name === n).id;
await gw.admin(`/admin/api/projects/${id("crm")}`, { method: "PATCH", body: { dailyTokenCap: 2_000_000, rpmCap: 60, accounts: "work,spare", note: "CRM assistant" } });
await gw.admin(`/admin/api/projects/${id("support-bot")}`, { method: "PATCH", body: { dailyRequestCap: 400, monthlyTokenCap: 40_000_000, note: "Help desk replies" } });
await gw.admin(`/admin/api/projects/${id("docs-search")}`, { method: "PATCH", body: { allowedModels: "claude-haiku-5-5", allowedOrigins: "http://localhost:5173" } });
await gw.admin(`/admin/api/projects/${id("mobile-app")}`, { method: "PATCH", body: { quotaCapPct: 70, accounts: "personal" } });
await gw.admin("/admin/api/models/claude-haiku-5-5", { method: "PATCH", body: { aliases: "haiku" } });
await gw.admin("/admin/api/models/claude-sonnet-5-5", { method: "PATCH", body: { aliases: "sonnet" } });

// A few live calls, including a fallback from a rate-limited account.
for (const n of names) await gw.call(keys[n]);
be.mode.work = "limited";
await gw.call(keys.crm);
be.mode.work = "ok";
await gw.call("cgw_wrong");

// Fourteen days of history, samples for the charts, and some activity.
const db = new DatabaseSync(join(gw.dir, "gateway.db"));
const rnd = (a, b) => Math.round(a + Math.random() * (b - a));
const ins = db.prepare(`INSERT INTO requests (ts, project_id, ip, method, path, model, stream, status, failed, ms, queue_ms, ttfb_ms, in_tok, out_tok, cache_read, cache_write, cost, account, attempts, stop_reason, error)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const weight = { crm: 1, "support-bot": 0.7, "docs-search": 0.45, "mobile-app": 0.25 };
for (let d = 13; d >= 0; d--)
  for (const n of names) {
    const count = Math.round(rnd(20, 60) * weight[n] * (d % 7 < 5 ? 1 : 0.4));
    for (let i = 0; i < count; i++) {
      const ts = new Date(Date.now() - d * 864e5 - rnd(0, d ? 86_000_000 : 3_000_000)).toISOString();
      const fail = Math.random() < 0.03;
      const sonnet = n === "support-bot" && Math.random() < 0.4;
      const inTok = rnd(200, 3000);
      const outTok = rnd(50, 900);
      const cache = rnd(2000, 30000);
      const acct = n === "mobile-app" ? "personal" : Math.random() < 0.8 ? "work" : "spare";
      ins.run(ts, id(n), `192.168.1.${rnd(30, 60)}`, "POST", Math.random() < 0.2 ? "/v1/chat/completions" : "/v1/messages", sonnet ? "claude-sonnet-5-5" : "claude-haiku-5-5", Math.random() < 0.6 ? 1 : 0, fail ? 429 : 200, fail ? 1 : 0, rnd(900, 6000), rnd(0, 300), rnd(500, 2000), inTok, outTok, cache, rnd(0, 2000), ((inTok + cache * 0.1) * (sonnet ? 3 : 1) + outTok * (sonnet ? 15 : 5)) / 1e6, acct, fail ? 1 : Math.random() < 0.05 ? 2 : 1, fail ? null : "end_turn", fail ? "Limit of 60 requests per minute reached." : null);
    }
  }
const sample = db.prepare("INSERT OR REPLACE INTO samples (ts, up, active, queued, proxy_mb, backend_mb, n, failed, p50, p95, accounts) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
for (let m = 60 * 24 * 7; m >= 1; m--) {
  const t = new Date(Date.now() - m * 60_000);
  const hour = t.getUTCHours();
  const busy = hour >= 8 && hour <= 20 ? 1 : 0.2;
  const n = Math.round(rnd(0, 6) * busy);
  const five = (base) => Math.min(99, Math.round(base + 40 * Math.sin((m / 300) * Math.PI) ** 2));
  sample.run(t.toISOString().slice(0, 16) + ":00Z", m === 3000 || m === 3001 ? 0 : 1, Math.min(2, n), n > 4 ? 1 : 0, rnd(60, 75), rnd(70, 220) * (n ? 1.6 : 1), n, Math.random() < 0.05 ? 1 : 0, rnd(1100, 2200), rnd(2600, 6500), JSON.stringify([{ id: "work", five: five(40), week: 64 }, { id: "personal", five: five(10), week: 42 }, { id: "spare", five: 4, week: 12 }]));
}
await gw.admin("/admin/api/monitor/run", { method: "POST" });

console.log(`
  Tollgate demo is running (fake backend, sample data)
  Dashboard:  http://127.0.0.1:${PORT}
  Password:   test-password-123
  A key:      ${keys.crm}
  Try:        curl http://127.0.0.1:${PORT}/v1/messages -H "x-api-key: ${keys.crm}" -H "content-type: application/json" -d '{"model":"haiku","max_tokens":50,"messages":[{"role":"user","content":"Hi"}]}'
  Ctrl+C stops it and deletes the demo data.
`);
const stop = async () => {
  await gw.stop();
  await be.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
