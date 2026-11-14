# Changelog

## 2.0.0 (2026-11-15)

### New
- **Several Claude accounts with automatic fallback.** Add accounts with `node proxy/cli.mjs account add <name>`. A rate-limited account is paused until its limit resets and the request is retried on the next account; signed-out accounts are skipped. Each project can choose its accounts and their order; each account can keep a reserve. New **Accounts** page.
- **Monitoring:** one sample a minute (uptime, requests, failures, latency, queue, memory, each account's quota) on a new **Monitoring** page, with a 90-day uptime strip.
- **Alerts** with rules, reminders and quiet hours, sent to the dashboard and optionally a webhook (Slack, Discord, Teams, Google Chat), Telegram or email (built-in SMTP client).
- **Activity** page: restarts, account changes, fallbacks, blocked addresses, sign-ins and an audit log of dashboard changes.
- **`/metrics`** in Prometheus format (off by default, bearer token).
- New dashboard: sidebar on desktop and bottom bar on phones, light and dark themes, setup checklist, a page per project with tabs, request search and filters with a live view that keeps loaded rows, confirmations and undo for disruptive actions, streaming playground, settings backup and restore.
- `x-gateway-request-id` on every response; `request-id` and `retry-after` from the backend are passed on.
- Test suite (`npm test`) against a fake backend.

### Fixed
- Callers could fake their address with `cf-connecting-ip` through a local tunnel, getting around blocking and the sign-in limit. Proxy headers are now believed only with the new **trusted proxy** setting.
- Limits ignored requests still running, so bursts could overshoot daily caps.
- OpenAI-style streams logged 0 tokens. Usage is now requested and counted.
- Errors inside a stream were logged as successes and missing from error counts (new `failed` column).
- A client that disconnected kept its slot until the backend finished; the request is now cancelled. Queued requests now give up after 60 seconds instead of waiting forever.
- Long streamed replies were cut off after 3 minutes; the timeout now applies to silence, not total length.
- "Max output tokens" is now enforced by the backend.
- "Allowed models" matched by substring; it now matches exact ids or aliases.
- A key expiring "on" a date stopped working at the start of that day; it now lasts to its end.
- Daily and monthly limits reset at UTC midnight; they now follow the gateway's time zone.
- Wrong input in the dashboard gave 500 errors; settings were partly saved when one value was wrong.
- Request bodies up to 20 MB were buffered on a 96 MB heap with no read timeout; the limit is now 10 MB (setting) with a 30-second timeout.
- The gateway could crash on a busy port and restart in a loop; it now waits and reports it. It finishes running requests before stopping.
- Logs only rotated at start; they now rotate while running and keep 3 old files.
- The backend's working folder was inside this repository, so the model could see its files and git status.
- Sessions couldn't be revoked; changing the password or **Sign out everywhere** now ends them all. Logout needs the CSRF header.
- The dashboard ran inline scripts; it now runs under a strict Content-Security-Policy.

## 1.0.0
- First release: per-project keys, limits, usage log, dashboard, https, login service on macOS, Linux and Windows.
