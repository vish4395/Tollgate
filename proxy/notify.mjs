// Sends alerts to the channels set up in Settings → Alerts: webhook, Telegram and email.
import { sendMail } from "./smtp.mjs";

export const SEVERITY = { info: 0, warning: 1, critical: 2 };
const ICON = { info: "ℹ️", warning: "⚠️", critical: "🚨", resolved: "✅" };

/** Minutes since midnight in the gateway's time zone. */
function localMinutes(tz) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  const [h, m] = p.split(":").map(Number);
  return h * 60 + m;
}
const toMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
export function inQuietHours(cfg) {
  const from = toMin(cfg.alerts.quietFrom);
  const to = toMin(cfg.alerts.quietTo);
  if (from == null || to == null || from === to) return false;
  const now = localMinutes(cfg.timeZone);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** Only https URLs to hosts that aren't this machine or the local network, unless allowed. */
export function checkWebhookUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return "The webhook URL is not valid.";
  }
  if (url.protocol !== "https:") return "The webhook URL must start with https://";
  return null;
}

export function createNotifier({ cfg, events }) {
  const sent = new Map(); // channel -> timestamps in the last hour
  const allow = (ch) => {
    const t = Date.now();
    const list = (sent.get(ch) ?? []).filter((x) => t - x < 3600e3);
    if (list.length >= 30) return false; // at most 30 messages an hour per channel
    list.push(t);
    sent.set(ch, list);
    return true;
  };

  const title = (a) => `${ICON[a.resolved ? "resolved" : a.severity] ?? ""} ${a.resolved ? "Resolved: " : ""}${a.title}`.trim();
  const text = (a) =>
    [title(a), a.message, a.subject ? `Subject: ${a.subject}` : null, `Gateway: ${cfg.publicUrl || `${cfg.publicHost}:${cfg.port}`}`, new Date().toISOString()]
      .filter(Boolean)
      .join("\n");

  const channels = {
    async webhook(c, a) {
      const bad = checkWebhookUrl(c.url);
      if (bad) throw new Error(bad);
      const t = text(a);
      const r = await fetch(c.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "claude-gateway" },
        // text: Slack, Google Chat, Teams (simple); content: Discord. The rest is for your own endpoint.
        body: JSON.stringify({ text: t, content: t.slice(0, 1900), kind: a.kind, severity: a.severity, subject: a.subject, title: a.title, message: a.message, resolved: !!a.resolved, at: new Date().toISOString() }),
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      if (r.status >= 300) throw new Error(`Webhook answered ${r.status}`);
    },
    async telegram(c, a) {
      if (!/^\d+:[\w-]+$/.test(c.token)) throw new Error("The Telegram bot token doesn't look right (it's like 123456:ABC-...).");
      const r = await fetch(`https://api.telegram.org/bot${c.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: c.chatId, text: text(a).slice(0, 4000), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(8000),
      });
      const o = await r.json().catch(() => ({}));
      if (!o.ok) throw new Error(`Telegram: ${o.description ?? r.status}`);
    },
    async email(c, a) {
      if (!c.host || !c.from || !c.to) throw new Error("Email needs a server, a From and a To address.");
      await sendMail({ ...c, port: Number(c.port), subject: `[Claude gateway] ${title(a)}`, text: text(a) });
    },
  };

  /** Sends an alert to every enabled channel whose minimum severity it meets. */
  async function dispatch(a, { force = false, only = null } = {}) {
    if (!force && a.severity !== "critical" && inQuietHours(cfg)) return [];
    const results = [];
    for (const [name, fn] of Object.entries(channels)) {
      const c = cfg.notify[name];
      if (only && only !== name) continue;
      if (!force && (!c?.enabled || SEVERITY[a.severity] < SEVERITY[c.minSeverity ?? "warning"])) continue;
      if (!force && !allow(name)) {
        results.push({ channel: name, ok: false, error: "Rate limited (30 an hour)" });
        continue;
      }
      try {
        await fn(c, a);
        results.push({ channel: name, ok: true });
      } catch (e) {
        results.push({ channel: name, ok: false, error: e.message });
        events.add("notify_failed", name, e.message);
      }
    }
    return results;
  }

  return { dispatch, test: (name) => dispatch({ kind: "test", severity: "info", title: "Test alert", message: "If you can read this, the channel works." }, { force: true, only: name }) };
}
