// Once a minute: read every account's state and quota, record a sample for the Monitoring page,
// and open or resolve alerts.
import { memoryCached } from "./sysinfo.mjs";

const pctile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);

export function createMonitor({ cfg, db, upstream, accounts, proxy, alerts, events, backend }) {
  let downSince = null;
  let lastHealth = null;
  const rule = (k) => cfg.alerts.rules[k];

  async function tick() {
    const health = await upstream.health();
    lastHealth = health;
    await accounts.refresh().catch((e) => console.error("account refresh failed", e.message));
    const stats = proxy.stats();
    const mem = await memoryCached(backend.pid()).catch(() => null);
    const since = new Date(Date.now() - 60_000).toISOString();
    const minute = db.prepare("SELECT ms, failed FROM requests WHERE ts >= ? AND path LIKE '/v1/%'").all(since);
    const ok = minute.filter((r) => !r.failed && r.ms).map((r) => r.ms).sort((a, b) => a - b);
    const acctSnap = accounts.rows().map((a) => {
      const q = accounts.quota(a.id);
      return { id: a.id, state: a.state, enabled: !!a.enabled, five: q?.fiveHour ?? null, week: q?.weekly ?? null };
    });
    db.prepare(
      `INSERT OR REPLACE INTO samples (ts, up, active, queued, proxy_mb, backend_mb, n, failed, p50, p95, accounts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      new Date().toISOString().slice(0, 16) + ":00Z",
      health.ok ? 1 : 0,
      stats.active,
      stats.queued,
      mem?.proxyMb ?? null,
      mem?.meridianMb ?? null,
      minute.length,
      minute.filter((r) => r.failed).length,
      pctile(ok, 50),
      pctile(ok, 95),
      JSON.stringify(acctSnap),
    );
    evaluate(health, stats);
  }

  function evaluate(health, stats) {
    // Backend down for N minutes.
    if (health.ok) downSince = null;
    else downSince ??= Date.now();
    const downMin = downSince ? (Date.now() - downSince) / 60_000 : 0;
    alerts.set(downSince && downMin >= rule("backend_down").minutes - 0.01, "backend_down", "", `Unhealthy for ${Math.round(downMin)} min: ${health.error ?? health.status}`);
    const restarts = db.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'backend_restart' AND ts >= ?").get(new Date(Date.now() - 10 * 60_000).toISOString()).n;
    alerts.set(restarts >= rule("backend_down").restarts, "backend_restarts", "", `${restarts} restarts in the last 10 minutes`);

    // Accounts.
    const nl = rule("account_near_limit");
    for (const a of accounts.rows()) {
      const q = accounts.quota(a.id);
      const name = a.label && a.label !== a.id ? `${a.id} (${a.label})` : a.id;
      if (!a.enabled) {
        for (const k of ["account_near_limit", "account_limited", "account_signed_out", "account_renewal"]) alerts.resolve(k, a.id);
        continue;
      }
      const near = q && ((q.fiveHour ?? 0) >= nl.fiveHourPct || (q.weekly ?? 0) >= nl.weeklyPct);
      alerts.set(near && a.state !== "limited", "account_near_limit", a.id, `${name}: 5-hour ${q?.fiveHour ?? "?"}%, 7-day ${q?.weekly ?? "?"}%`);
      alerts.set(
        a.state === "limited",
        "account_limited",
        a.id,
        `${name} is paused until ${a.cooldown_until ? new Date(a.cooldown_until).toISOString() : "its limit resets"}. ${a.last_error ?? ""}`.trim(),
      );
      alerts.set(a.state === "signed_out", "account_signed_out", a.id, `${name} is signed out. Run: node proxy/cli.mjs account login ${a.id === "default" ? "" : a.id}`.trim());
      const prof = accounts.profiles().find((p) => p.id === a.id);
      const days = prof?.daysUntilRenewal ?? (a.id === "default" ? health.daysUntilRenewal : null);
      alerts.set(days != null && days <= rule("account_renewal").days, "account_renewal", a.id, `${name}: sign-in must be renewed in ${days} days.`);
    }
    // "No account" clears when any account is usable again.
    if (accounts.rows().some((a) => a.enabled && a.state === "ok"))
      for (const al of alerts.openList().filter((x) => x.kind === "no_account")) alerts.resolve("no_account", al.subject);

    // Error rate and speed over the last N minutes.
    const es = rule("error_spike");
    const w = db
      .prepare("SELECT COUNT(*) n, SUM(failed) f FROM requests WHERE ts >= ? AND path LIKE '/v1/%' AND status NOT IN (401, 403, 499)")
      .get(new Date(Date.now() - es.minutes * 60_000).toISOString());
    const rate = w.n ? Math.round(((w.f ?? 0) / w.n) * 100) : 0;
    alerts.set(w.n >= es.minRequests && rate >= es.pct, "error_spike", "", `${rate}% of ${w.n} requests failed in the last ${es.minutes} minutes.`);
    const sr = rule("slow_responses");
    const slow = db
      .prepare("SELECT ms FROM requests WHERE ts >= ? AND failed = 0 AND path LIKE '/v1/%' ORDER BY ms")
      .all(new Date(Date.now() - sr.minutes * 60_000).toISOString())
      .map((r) => r.ms);
    const p95 = pctile(slow, 95);
    alerts.set(slow.length >= 5 && p95 > sr.seconds * 1000, "slow_responses", "", `95% of replies took up to ${Math.round(p95 / 1000)} s in the last ${sr.minutes} minutes.`);

    // Queue refusals in the last 5 minutes.
    const q5 = db.prepare("SELECT COUNT(*) n FROM events WHERE kind IN ('queue_full','queue_timeout') AND ts >= ?").get(new Date(Date.now() - 5 * 60_000).toISOString()).n;
    alerts.set(q5 > 0, "queue_full", "", `${q5} requests were refused or timed out in the queue in the last 5 minutes (running ${stats.active}, waiting ${stats.queued}).`);

    // Projects near their caps.
    const pc = rule("project_cap");
    for (const p of db.prepare("SELECT * FROM projects WHERE enabled = 1").all()) {
      const u = proxy.usage(p);
      const parts = [
        [p.daily_request_cap, u.dayN, "requests today"],
        [p.daily_token_cap, u.dayT, "tokens today"],
        [p.monthly_token_cap, u.monthT, "tokens this month"],
      ].filter(([cap]) => cap);
      const worst = parts.map(([cap, used, label]) => ({ pct: Math.round((used / cap) * 100), label, used, cap })).sort((a, b) => b.pct - a.pct)[0];
      alerts.set(worst && worst.pct >= pc.pct && worst.pct < 100, "project_cap", p.name, worst ? `${p.name}: ${worst.pct}% of ${worst.cap} ${worst.label}.` : "");
      if (!worst || worst.pct < 100) alerts.resolve("project_cap_reached", p.name);
    }

    // Security: addresses blocked right now; failed admin sign-ins in the last 15 minutes.
    const fails = db.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'login_failed' AND ts >= ?").get(new Date(Date.now() - 15 * 60_000).toISOString()).n;
    const blocked = stats.blockedIps.map((b) => b.ip);
    alerts.set(
      blocked.length > 0 || fails >= 10,
      "security",
      "",
      [blocked.length ? `Blocked for invalid keys: ${blocked.join(", ")}.` : null, fails >= 10 ? `${fails} failed dashboard sign-ins in 15 minutes.` : null].filter(Boolean).join(" "),
    );
  }

  let timer = null;
  const run = () =>
    tick().catch((e) => {
      console.error("monitor tick failed", e);
      events.add("monitor_error", null, e.message);
    });
  return {
    start() {
      run();
      // Line up with the start of each minute so samples have round times.
      setTimeout(() => {
        run();
        timer = setInterval(run, 60_000);
        timer.unref();
      }, 60_000 - (Date.now() % 60_000)).unref();
    },
    tick: run,
    lastHealth: () => lastHealth,
  };
}
