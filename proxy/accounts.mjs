// Claude accounts (backend "profiles"): state, quota, cooldowns, and which ones a project may use.
// With no extra accounts set up, the backend's own sign-in shows as one account named "default".

const now = () => Date.now();

export function createAccounts({ cfg, db, upstream, events }) {
  const quota = new Map(); // id -> { fiveHour, weekly, fiveResets, weeklyResets, stale, at }
  let profiles = []; // what the backend reports
  let multi = false; // true once real profiles exist (then requests are pinned with a header)

  const rows = () => db.prepare("SELECT * FROM accounts ORDER BY priority, id").all();
  const get = (id) => db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  const setState = (id, state, error = null, cooldownUntil = null) => {
    const before = get(id);
    if (!before) return;
    db.prepare("UPDATE accounts SET state = ?, last_error = ?, cooldown_until = ? WHERE id = ?").run(
      state,
      error ? String(error).slice(0, 500) : null,
      cooldownUntil,
      id,
    );
    if (before.state !== state)
      events.add("account_state", id, `${before.state} → ${state}${error ? `: ${String(error).slice(0, 200)}` : ""}`);
  };

  function ensure(id, label) {
    if (!get(id)) {
      const n = db.prepare("SELECT COUNT(*) n FROM accounts").get().n;
      db.prepare("INSERT INTO accounts (id, label, priority) VALUES (?, ?, ?)").run(id, label ?? id, (n + 1) * 10);
      events.add("account_added", id, "Found on the backend");
    }
  }

  /** Reads sign-in state and quota for every account from the backend. */
  async function refresh() {
    const [list, all] = await Promise.all([upstream.profiles(), upstream.quotaAll()]);
    if (list) {
      profiles = list.profiles ?? [];
      multi = profiles.length > 0;
      if (!multi) ensure("default", "This computer's sign-in");
      else if (get("default") && !profiles.some((p) => p.id === "default") && get("default").enabled) {
        // With named accounts the backend no longer uses this computer's own sign-in.
        db.prepare("UPDATE accounts SET enabled = 0, last_error = ? WHERE id = 'default'").run(
          "Not used: named accounts were added. Add this sign-in as an account too: node proxy/cli.mjs account add main",
        );
        events.add("account_state", "default", "Turned off: named accounts are now used");
      }
      for (const p of profiles) {
        ensure(p.id, p.email ?? p.id);
        const a = get(p.id);
        if (p.loggedIn === false && a.state !== "signed_out") setState(p.id, "signed_out", "Signed out on the backend");
        if (p.loggedIn && a.state === "signed_out") setState(p.id, "ok");
      }
    }
    for (const p of all?.profiles ?? []) {
      const w = Object.fromEntries((p.windows ?? []).map((x) => [x.type, x]));
      const q = {
        fiveHour: w.five_hour ? Math.round(w.five_hour.utilization * 100) : null,
        weekly: w.seven_day ? Math.round(w.seven_day.utilization * 100) : null,
        fiveResets: w.five_hour?.resetsAt ?? null,
        weeklyResets: w.seven_day?.resetsAt ?? null,
        stale: !!p.stale,
        at: now(),
      };
      quota.set(p.id, q);
      const a = get(p.id);
      // The window reset while the account was cooling down: use it again.
      if (a?.state === "limited" && a.cooldown_until && q.fiveHour != null && q.fiveHour < 100 && q.fiveResets && a.cooldown_until > q.fiveResets && now() > q.fiveResets)
        setState(p.id, "ok");
    }
    // Cooldowns that have run out.
    for (const a of rows())
      if (a.state === "limited" && a.cooldown_until && a.cooldown_until <= now()) setState(a.id, "ok");
  }

  const usable = (a) => {
    if (!a.enabled || a.state === "signed_out") return false;
    if (a.state === "limited" && (a.cooldown_until ?? 0) > now()) return false;
    const q = quota.get(a.id);
    if (q && a.reserve_pct && q.fiveHour != null && q.fiveHour >= a.reserve_pct) return false;
    if (q && a.weekly_reserve_pct && q.weekly != null && q.weekly >= a.weekly_reserve_pct) return false;
    return true;
  };

  /** Accounts to try for a project, in order. `why` explains an empty list. */
  function candidates(project) {
    const all = rows();
    if (!all.length) return { list: [{ id: null }], why: null }; // backend not read yet: let it decide
    const wanted = String(project?.accounts ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const pool = wanted.length ? wanted.map((id) => all.find((a) => a.id === id)).filter(Boolean) : all;
    const list = pool.filter(usable);
    if (list.length) return { list, why: null };
    const soon = pool
      .filter((a) => a.enabled && a.state === "limited" && a.cooldown_until)
      .map((a) => a.cooldown_until)
      .sort()[0];
    return {
      list: [],
      why: pool.length ? "Every account this project may use is paused, signed out or over its reserve." : "None of this project's accounts exist any more.",
      retryAt: soon ?? null,
    };
  }

  /** Header that pins a request to one account (none when only the default sign-in exists). */
  const headerFor = (id) => (multi && id ? { "x-meridian-profile": id } : {});

  function cooldownFrom(retryAfterSec, id) {
    if (retryAfterSec > 0) return now() + retryAfterSec * 1000;
    const q = quota.get(id);
    if (q?.fiveResets && q.fiveResets > now()) return q.fiveResets;
    return now() + 5 * 60_000;
  }

  return {
    refresh,
    candidates,
    headerFor,
    rows,
    get,
    quota: (id) => quota.get(id) ?? null,
    isMulti: () => multi,
    profiles: () => profiles,
    used: (id) => id && db.prepare("UPDATE accounts SET last_used_at = datetime('now') WHERE id = ?").run(id),
    limited(id, retryAfterSec, msg) {
      const until = cooldownFrom(retryAfterSec, id);
      setState(id, "limited", msg, until);
      return until;
    },
    signedOut: (id, msg) => setState(id, "signed_out", msg),
    ok: (id) => {
      const a = get(id);
      if (a && a.state !== "ok") setState(id, "ok");
    },
    clear: (id) => setState(id, "ok"),
  };
}
