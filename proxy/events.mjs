// Event log (restarts, account changes, fallbacks, admin actions) with listeners for alerts.
export function createEvents(db) {
  const insert = db.prepare("INSERT INTO events (kind, subject, message, actor, ip) VALUES (?, ?, ?, ?, ?)");
  const listeners = new Set();
  return {
    add(kind, subject = null, message = null, actor = null, ip = null) {
      try {
        insert.run(kind, subject, message ? String(message).slice(0, 1000) : null, actor, ip);
      } catch (e) {
        console.error("event log failed", e.message);
      }
      for (const fn of listeners) {
        try {
          fn({ kind, subject, message });
        } catch (e) {
          console.error("event listener failed", e.message);
        }
      }
    },
    on: (fn) => listeners.add(fn),
  };
}
