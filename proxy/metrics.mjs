// Prometheus text format, for Grafana, Uptime Kuma and similar tools.
const line = (name, value, labels = {}) => {
  const l = Object.entries(labels)
    .map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, "_")}"`)
    .join(",");
  return `${name}${l ? `{${l}}` : ""} ${value ?? 0}`;
};

export function metricsText({ db, proxy, accounts, alerts, monitor }) {
  const s = proxy.stats();
  const h = monitor.lastHealth();
  const out = [
    "# TYPE gateway_up gauge",
    line("gateway_up", 1),
    "# TYPE gateway_backend_up gauge",
    line("gateway_backend_up", h?.ok ? 1 : 0),
    "# TYPE gateway_requests_active gauge",
    line("gateway_requests_active", s.active),
    "# TYPE gateway_requests_queued gauge",
    line("gateway_requests_queued", s.queued),
    "# TYPE gateway_alerts_open gauge",
    line("gateway_alerts_open", alerts.openList().length),
    "# TYPE gateway_blocked_ips gauge",
    line("gateway_blocked_ips", s.blockedIps.length),
  ];
  const day = new Date(Date.now() - 864e5).toISOString();
  out.push("# TYPE gateway_requests_24h gauge", "# TYPE gateway_failed_24h gauge", "# TYPE gateway_tokens_24h gauge");
  for (const r of db
    .prepare(
      `SELECT COALESCE(p.name,'(none)') project, COUNT(*) n, SUM(r.failed) f, SUM(r.in_tok+r.out_tok+r.cache_read+r.cache_write) t
       FROM requests r LEFT JOIN projects p ON p.id = r.project_id WHERE r.ts >= ? GROUP BY 1`,
    )
    .all(day)) {
    out.push(line("gateway_requests_24h", r.n, { project: r.project }), line("gateway_failed_24h", r.f, { project: r.project }), line("gateway_tokens_24h", r.t, { project: r.project }));
  }
  out.push("# TYPE gateway_account_usable gauge", "# TYPE gateway_account_five_hour_pct gauge", "# TYPE gateway_account_weekly_pct gauge");
  for (const a of accounts.rows()) {
    const q = accounts.quota(a.id);
    out.push(line("gateway_account_usable", a.enabled && a.state === "ok" ? 1 : 0, { account: a.id, state: a.state }));
    if (q?.fiveHour != null) out.push(line("gateway_account_five_hour_pct", q.fiveHour, { account: a.id }));
    if (q?.weekly != null) out.push(line("gateway_account_weekly_pct", q.weekly, { account: a.id }));
  }
  return out.join("\n") + "\n";
}
