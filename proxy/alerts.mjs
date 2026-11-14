// Alerts: one open alert per kind and subject, a notification when it opens, a reminder while it
// stays open, and one when it clears.

export const ALERT_INFO = {
  account_near_limit: { title: "Account near its limit", severity: "warning" },
  account_limited: { title: "Account limit reached", severity: "warning" },
  account_signed_out: { title: "Account signed out", severity: "critical" },
  account_renewal: { title: "Account sign-in expires soon", severity: "warning" },
  no_account: { title: "No Claude account available", severity: "critical" },
  backend_down: { title: "Claude backend is down", severity: "critical" },
  backend_restarts: { title: "Claude backend keeps restarting", severity: "critical" },
  error_spike: { title: "Many requests are failing", severity: "warning" },
  slow_responses: { title: "Responses are slow", severity: "warning" },
  queue_full: { title: "Gateway queue is full", severity: "warning" },
  project_cap: { title: "Project near its limit", severity: "info" },
  project_cap_reached: { title: "Project limit reached", severity: "warning" },
  security: { title: "Security warning", severity: "warning" },
};
// Which rule (settings) controls each alert kind.
const RULE_OF = { backend_restarts: "backend_down", project_cap_reached: "project_cap" };

export function createAlerts({ cfg, db, notifier, events }) {
  const findOpen = db.prepare("SELECT * FROM alerts WHERE kind = ? AND subject = ? AND resolved_at IS NULL");
  const iso = () => new Date().toISOString();
  const ruleOn = (kind) => cfg.alerts.rules[RULE_OF[kind] ?? kind]?.enabled !== false;

  function notify(row, resolved = false) {
    const info = ALERT_INFO[row.kind] ?? { title: row.kind };
    notifier
      .dispatch({ kind: row.kind, severity: row.severity, subject: row.subject, title: info.title, message: row.message, resolved })
      .then((r) => {
        if (r.some((x) => x.ok)) db.prepare("UPDATE alerts SET notified_at = ? WHERE id = ?").run(iso(), row.id);
      })
      .catch((e) => console.error("notify failed", e.message));
  }

  /** Opens an alert, or refreshes the open one. Sends a reminder after repeatMinutes. */
  function open(kind, subject = "", message = "", severity) {
    if (!ruleOn(kind)) return;
    const sev = severity ?? ALERT_INFO[kind]?.severity ?? "warning";
    const cur = findOpen.get(kind, subject);
    if (cur) {
      db.prepare("UPDATE alerts SET last_seen_at = ?, message = ?, severity = ? WHERE id = ?").run(iso(), message, sev, cur.id);
      const last = Date.parse(cur.notified_at ?? cur.opened_at);
      if (cfg.alerts.repeatMinutes > 0 && Date.now() - last > cfg.alerts.repeatMinutes * 60_000) notify({ ...cur, message, severity: sev });
      return;
    }
    const r = db.prepare("INSERT INTO alerts (kind, subject, severity, message, last_seen_at) VALUES (?, ?, ?, ?, ?)").run(kind, subject, sev, message, iso());
    events.add("alert_opened", subject || kind, `${ALERT_INFO[kind]?.title ?? kind}: ${message}`);
    notify({ id: Number(r.lastInsertRowid), kind, subject, severity: sev, message });
  }

  function resolve(kind, subject = "") {
    const cur = findOpen.get(kind, subject);
    if (!cur) return;
    db.prepare("UPDATE alerts SET resolved_at = ? WHERE id = ?").run(iso(), cur.id);
    events.add("alert_resolved", subject || kind, ALERT_INFO[kind]?.title ?? kind);
    if (cur.notified_at) notify(cur, true);
  }

  /** Opens or resolves depending on a condition. */
  const set = (cond, kind, subject, message, severity) => (cond ? open(kind, subject, message, severity) : resolve(kind, subject));

  return {
    open,
    resolve,
    set,
    openList: () => db.prepare("SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY opened_at DESC").all(),
    history: (limit = 200) => db.prepare("SELECT * FROM alerts ORDER BY id DESC LIMIT ?").all(limit),
    // Called by the proxy when a request is refused.
    projectRefused(project, msg) {
      if (/limit reached/i.test(msg)) open("project_cap_reached", project.name, msg);
    },
    noAccount(project, msg) {
      open("no_account", project.name, msg);
    },
    // Resolve by hand from the dashboard.
    dismiss(id) {
      const a = db.prepare("SELECT * FROM alerts WHERE id = ?").get(id);
      if (a && !a.resolved_at) resolve(a.kind, a.subject);
      return !!a;
    },
  };
}
