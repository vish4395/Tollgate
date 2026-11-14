# Monitoring and alerts

Once a minute the gateway reads the backend's health and every account's quota, records a sample, and checks its alert rules. Samples, alerts and activity are kept for the history period in Settings (30 days by default).

## Rules

Change thresholds or turn rules off under **Alerts → Rules**.

| Alert | Severity | Opens when (default) | Closes when |
|---|---|---|---|
| Account near its limit | warning | 5-hour use ≥ 80 % or 7-day ≥ 90 % | Use drops below |
| Account limit reached | warning | The account was paused after a rate limit | The pause ends |
| Account signed out | critical | The backend reports it signed out, or a request was refused for sign-in | It signs in again |
| Account sign-in expires soon | warning | Renewal needed within 7 days | Renewed |
| No Claude account available | critical | A request found no account it could use | Any account is ready |
| Claude backend is down | critical | Unhealthy for 2 minutes | Healthy again |
| Claude backend keeps restarting | critical | 3 restarts in 10 minutes | Fewer restarts |
| Many requests are failing | warning | ≥ 20 % of at least 10 requests in 5 minutes failed (wrong keys and refused origins don't count) | Rate drops |
| Responses are slow | warning | Off by default. Slowest 5 % over 60 s for 10 minutes | Faster again |
| Gateway queue is full | warning | Requests were refused or timed out in the queue in the last 5 minutes | 5 quiet minutes |
| Project near its limit | info | 80 % of a daily or monthly cap | New day or month |
| Project limit reached | warning | A request was refused by a cap | New day or month |
| Security warning | warning | An address is blocked for bad keys, or 10 failed dashboard sign-ins in 15 minutes | Block ends |

Each alert is one entry per subject (for example one per account). You get a message when it opens, a **reminder** while it stays open (every 4 hours by default; 0 turns reminders off), and a message when it closes. **Resolve** on the Alerts page closes one by hand; it opens again at the next check if the problem is still there.

**Quiet hours** (for example 22:00 to 07:00, in the gateway's time zone) hold back info and warning messages. Critical alerts still go out.

## Channels

Set them up under **Alerts → Where alerts go**. Each channel has an on/off switch, a minimum severity and a **Send test** button. Each channel sends at most 30 messages an hour. Failed sends are listed under Activity.

### Webhook

Paste an https URL. The gateway POSTs JSON:

```json
{
  "text": "🚨 Account signed out\nwork is signed out. Run: node proxy/cli.mjs account login work\nSubject: work\nGateway: 192.168.1.20:4100\n2026-11-15T09:30:00.000Z",
  "content": "…same text, for Discord…",
  "kind": "account_signed_out",
  "severity": "critical",
  "subject": "work",
  "title": "Account signed out",
  "message": "…",
  "resolved": false,
  "at": "2026-11-15T09:30:00.000Z"
}
```

`text` works with **Slack**, **Google Chat** and **Microsoft Teams** incoming webhooks; `content` works with **Discord**. Your own endpoint can use the other fields.

### Telegram

1. Talk to **@BotFather** in Telegram, send `/newbot`, and copy the token (`123456:ABC…`).
2. Send any message to your new bot (or add it to a group).
3. Find the chat id, for example by messaging **@userinfobot**, or by opening `https://api.telegram.org/bot<token>/getUpdates` and reading `chat.id`.
4. Paste both into the Telegram card and press **Send test**.

### Email

Any SMTP server: your mail provider, a company relay, or a local one.

| Provider | Server | Port | Security |
|---|---|---|---|
| Gmail / Google Workspace | `smtp.gmail.com` | 587 | STARTTLS, with an [app password](https://support.google.com/accounts/answer/185833) |
| Microsoft 365 | `smtp.office365.com` | 587 | STARTTLS |
| Most others | see your provider | 587 or 465 | STARTTLS or TLS |
| Mailpit / MailHog (testing) | `localhost` | 1025 | None |

**To** takes several addresses separated by commas.

Secrets (webhook URL, bot token, SMTP password) are stored in `config.json` (readable only by you) and never shown again in the dashboard; type a new value to replace one.

## Monitoring page

- **Uptime:** one bar per day for 90 days (green ≥ 99.5 %, amber ≥ 95 %, red below, grey for no data).
- **Charts** for 1 h, 24 h, 7 d or 30 d: requests and failures, response time (typical and slowest 5 %), each account's 5-hour and 7-day use, running and waiting requests, and memory.

## Metrics for other tools

Turn on **Settings → Backend → Metrics endpoint**. The dashboard then shows a token; scrape:

```
GET /metrics
Authorization: Bearer <token>
```

It serves Prometheus text: `gateway_up`, `gateway_backend_up`, `gateway_requests_active`, `gateway_requests_queued`, `gateway_alerts_open`, `gateway_blocked_ips`, and per project `gateway_requests_24h`, `gateway_failed_24h` and `gateway_tokens_24h`. Per account it serves `gateway_account_usable`, `gateway_account_five_hour_pct` and `gateway_account_weekly_pct`. For a simple uptime check, `GET /health` needs no token and answers `200` when the backend is healthy.
