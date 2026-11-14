# Claude CLI API Gateway

Use the Claude subscription you're already signed in to with Claude Code as a local HTTP API, so your own apps can call Claude for development and testing. Each app gets its own API key, its own limits and its own usage history, and a web dashboard shows it all.

```
your apps ──project key──▶  Gateway  :4100  ──internal key──▶  Meridian  :4101  ──▶  Claude Code CLI  ──▶  Claude
            (LAN or local)  keys, limits,                      (localhost only)       (your subscription)
                            usage, dashboard
```

- **Standard APIs:** Anthropic `POST /v1/messages`, OpenAI-style `POST /v1/chat/completions` and `GET /v1/models`, with streaming and tool calling (your app's own tools come back as normal `tool_use` blocks).
- **Per-project keys** with limits: requests per minute and per day, tokens per day and per month, max output tokens, allowed models, key expiry, allowed web origins, and "pause above X% of an account's 5-hour quota".
- **Several Claude accounts with automatic fallback:** when one account hits its usage limit or is signed out, the next one takes over. Each project can choose which accounts it may use and in what order. See [docs/accounts.md](docs/accounts.md).
- **Monitoring and alerts:** a sample every minute (uptime, latency, failures, queue, memory, each account's quota), and alerts for account limits, sign-outs, backend outages, error spikes, slow replies and project caps. Alerts go to the dashboard and, if you set them up, a webhook (Slack, Discord, Teams, Google Chat), Telegram or email. See [docs/alerts.md](docs/alerts.md).
- **Usage tracking** for every request: project, model, tokens, estimated cost, latency, time to first token, status and errors. Prompts and replies are never stored.
- **Dashboard** (desktop and phone, light and dark): overview with a setup checklist, projects, accounts, models, usage, a searchable request log, monitoring charts, alerts, an activity and audit log, a streaming playground, and settings with backup and restore.
- **Low memory:** about 130–160 MB when idle, using plain Node with no npm dependencies for the gateway itself.
- **Runs on macOS, Linux and Windows.** It starts at login as a user service (launchd, systemd or Task Scheduler), and a small supervisor restarts the backend or gateway if either stops.
- **Optional https** with a locally trusted certificate, and an **optional separate Claude sign-in** so the gateway never shares your interactive Claude Code session.

> **Personal use only.** The gateway runs on _your_ Claude subscription. Use it for your own development and testing, and don't offer it to other people or expose it publicly. Check Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and usage policies before relying on it. For production or shared use, use an [Anthropic API key](https://console.anthropic.com/) instead.

---

## Contents

1. [Requirements](#requirements)
2. [Install](#install)
3. [Create a key and make your first call](#create-a-key-and-make-your-first-call)
4. [Connect your apps](#connect-your-apps)
5. [Call it from a web page (browser)](#call-it-from-a-web-page-browser)
6. [Dashboard](#dashboard)
7. [Limits and models](#limits-and-models)
8. [Claude accounts and fallback](#claude-accounts-and-fallback)
9. [Monitoring and alerts](#monitoring-and-alerts)
10. [Optional: https](#optional-https)
11. [Optional: a separate Claude sign-in for the gateway](#optional-a-separate-claude-sign-in-for-the-gateway)
12. [Commands](#commands)
13. [Configuration](#configuration)
14. [Troubleshooting](#troubleshooting)
15. [Security notes](#security-notes)
16. [How it works](#how-it-works)
17. [Tests](#tests)
18. [Uninstall](#uninstall)
19. [Credits and license](#credits-and-license)

---

## Requirements

| | macOS | Linux | Windows 10/11 |
|---|---|---|---|
| Node.js | 22 or newer | 22 or newer | 22 or newer |
| Claude Code CLI, signed in | yes | yes | yes |
| Login service | launchd (built in) | systemd user services (most desktop distros) | Task Scheduler (built in) |
| Tested | yes | written for, not yet tested | written for, not yet tested |

```bash
node -v                                   # v22 or newer
npm install -g @anthropic-ai/claude-code  # the Claude Code CLI
claude                                    # sign in once with your Claude subscription, then exit
```

The gateway uses ports **4100** (API and dashboard), **4180** (plain http when https is on) and **4101** (backend, this computer only).

## Install

**macOS and Linux:**

```bash
git clone https://github.com/vishalsharmads/claude-cli-api-gateway.git ~/claude-gateway
cd ~/claude-gateway
./install.sh
```

**Windows** (PowerShell or Command Prompt):

```bat
git clone https://github.com/vishalsharmads/claude-cli-api-gateway.git %USERPROFILE%\claude-gateway
cd %USERPROFILE%\claude-gateway
install.cmd
```

Both run `node proxy/cli.mjs install`, which:
1. Checks Node and the Claude CLI.
2. Installs [Meridian](https://github.com/rynfar/meridian) at the version pinned in `meridian/package-lock.json`.
3. Creates the gateway's internal key.
4. Registers a login service and starts it.
5. Prints the dashboard address and admin password.

The password is also saved in `ADMIN_PASSWORD.txt`.

| OS | Login service | Notes |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.local.claude-gateway.plist` | Starts at login and restarts if it stops |
| Linux | `~/.config/systemd/user/claude-gateway.service` | Starts at login. To keep it running while logged out: `sudo loginctl enable-linger $USER`. Without systemd (some WSL or containers), run `node proxy/gateway.mjs` from your own startup |
| Windows | Task Scheduler task `ClaudeGateway` (at logon) | Runs hidden through `data/start-hidden.vbs`. The supervisor restarts the backend and gateway; if the supervisor itself is closed, `bin\gateway start` brings it back |

- **Dashboard:** `http://localhost:4100`, or `http://<your-computer-ip>:4100` from other devices on your network.
- **Firewall:** the first time another device connects, macOS or Windows may ask whether Node.js may accept incoming connections. Allow it on private networks. On Linux, open port 4100 in your firewall if you use one (for example `sudo ufw allow 4100/tcp`).

You can keep the folder anywhere. If you move it, run the installer again.

## Create a key and make your first call

1. Open the dashboard and sign in.
2. Go to **Projects → New project**, type a name (for example `my-app`) and click **Create key**.
3. Copy the key. It starts with `cgw_` and is **shown only once**, because the gateway stores only a hash of it.

```bash
export KEY=cgw_your_key_here

curl http://localhost:4100/v1/messages \
  -H "x-api-key: $KEY" \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-haiku-5-5","max_tokens":200,"messages":[{"role":"user","content":"Hello"}]}'
```

You can also create a key from the terminal: `node proxy/cli.mjs add-project my-app`.

## Connect your apps

Send the project key either as `x-api-key: <key>` or as `Authorization: Bearer <key>`.

| Client                                                          | Base URL                         | Key setting         |
| --------------------------------------------------------------- | -------------------------------- | ------------------- |
| Anthropic SDKs (Python, TypeScript…)                            | `http://<host>:4100`             | `ANTHROPIC_API_KEY` |
| OpenAI-style SDKs and tools                                     | `http://<host>:4100/v1`          | `OPENAI_API_KEY`    |
| Apps with an "Anthropic / Claude" provider and a custom address | `http://<host>:4100` (host only) | the project key     |
| Apps with an "OpenAI compatible" provider                       | `http://<host>:4100/v1`          | the project key     |

```bash
# Anthropic SDKs
export ANTHROPIC_BASE_URL=http://localhost:4100
export ANTHROPIC_API_KEY=$KEY

# OpenAI-style clients
export OPENAI_BASE_URL=http://localhost:4100/v1
export OPENAI_API_KEY=$KEY
```

```python
from anthropic import Anthropic
client = Anthropic(base_url="http://localhost:4100", api_key="cgw_...")
print(client.messages.create(model="claude-haiku-5-5", max_tokens=200,
      messages=[{"role": "user", "content": "Hello"}]).content[0].text)
```

**Models:** `GET /v1/models` lists the models your subscription offers, minus any you turn off. `claude-haiku-5-5` is the fastest and the default. You can add short aliases such as `haiku` under **Models**.

**Speed:** expect roughly 1.5–3 s for a short reply with Haiku. Each request runs through the Claude Code CLI, so it's slower than the paid API.

**Apps on other networks** (shared hosting, a VPS, the cloud): see [docs/remote-access.md](docs/remote-access.md) for a public https address through a Cloudflare tunnel, ngrok or Tailscale.

**Apps that block private addresses:** some apps refuse `http://` URLs or private IPs (`192.168.x.x`, `localhost`) for safety. Look for a setting that allows a private host, or use [https](#optional-https).

## Call it from a web page (browser)

Browsers block calls to another address unless that address allows the page's origin (CORS). The gateway allows **no** origins by default. To allow some for one project:

1. In the dashboard, open **Projects**, then the project.
2. Set **Allowed web origins** to the exact origins of your pages, separated by commas, for example `http://localhost:5173, http://192.168.11.20:3000`. Use `*` to allow any origin (only for local experiments).
3. Click **Save**.

The gateway then answers the browser's preflight check. It refuses a request with that project's key when the request comes from a page whose origin isn't on the list (`403 permission_error`). Calls from servers carry no origin and aren't affected.

```js
const res = await fetch("http://GATEWAY-IP:4100/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 300,
    messages: [{ role: "user", content: "Hello" }] }),
});
console.log((await res.json()).content.at(-1).text);
```

With the Anthropic JS SDK, pass `baseURL`, `apiKey` and `dangerouslyAllowBrowser: true`. If your page is served over https, call the gateway over https as well ([Optional: https](#optional-https)), or the browser blocks the call as mixed content.

> **The key is visible to anyone who opens the page.** Use a separate project per web app, with tight limits (requests per minute, tokens per day). Keep browser use to your own network. For a public site, call the gateway from your site's server, not from the browser.

## Dashboard

| Page           | What you get                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**   | Open alerts first, a setup checklist, today's requests, tokens and est. cost, speed, load, memory, every account's quota, a 14-day chart, latest errors |
| **Projects**   | One page per project with tabs: limits, which accounts it may use (and order), web access (CORS), connection snippets (curl, .env, PHP, Node, Python, OpenAI-style) with a key test, and its requests |
| **Accounts**   | Each Claude account: state, plan, 5-hour and 7-day use with reset times, sign-in renewal, today's use, order, on/off, reserve limits, test, "use again now" |
| **Models**     | Turn models on or off, aliases, max output tokens, prices for the cost estimate, default model                                                       |
| **Usage**      | Today / 7 / 30 / 90 days by project, account, model, day and address. Chart with a table view. CSV export                                            |
| **Requests**   | Live log (pausable) with search and filters (project, account, result, dates), details panel, older pages, CSV                                       |
| **Monitoring** | 90-day uptime strip, requests and failures, response time, account quota history, queue and memory over 1 h / 24 h / 7 d / 30 d                       |
| **Alerts**     | Open alerts, history, rules and thresholds, quiet hours, and channels (webhook, Telegram, email) with a test button                                  |
| **Activity**   | Restarts, account changes, fallbacks, blocked addresses, sign-ins and every dashboard change (audit log)                                             |
| **Playground** | Streams a reply from any model and account, with time to first token and token counts                                                                |
| **Settings**   | Gateway, network and time zone, trusted proxy, backend (restart, max-tokens enforcement, metrics), prices, password, sign out everywhere, blocked addresses, backup and restore |

"Est. cost" is what the same tokens would cost on the paid API. It helps you compare projects; your subscription isn't billed per token.

## Limits and models

**Per project** (Projects → Limits). Empty means no limit.

| Limit                             | Behaviour                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Requests / minute, Requests / day | `429` once reached                                                                                                     |
| Tokens / day, Tokens / month      | Counts input, output and cache tokens of successful requests; `429` once reached. Days and months follow the gateway's time zone |
| Pause above 5-hour use %          | Skips any account whose 5-hour use is at or above this %, so one app can't use up your quota                           |
| Allowed models                    | Comma list of exact model ids or aliases (`claude-haiku-5-5,sonnet`)                                                   |
| Key expires on                    | The key works until the end of that day, then `403`                                                                    |
| Max output tokens                 | Lowers the `max_tokens` a client sends; replies stop at about that length (`stop_reason: max_tokens`)                        |
| Accounts                          | Which Claude accounts the project may use, in order. Empty = all                                                       |
| Allowed web origins               | Browser pages that may call with this key (CORS)                                                                       |

**Gateway-wide:**

- At most 2 requests run at once; the rest wait up to 60 seconds in a queue of 20, then get `429` with `Retry-After` (Settings).
- A request is cut off when the backend sends nothing for 3 minutes (long streamed replies are fine).
- A client that disconnects frees its place at once.
- Request bodies are limited to 10 MB.
- An address that sends 20 wrong keys in a minute is blocked for 10 minutes.
- Unknown model names get a clear `400`.
- Every response carries `x-gateway-request-id`, which you can search for under Requests.

## Claude accounts and fallback

By default the gateway uses this computer's Claude sign-in. Add more accounts to share load and keep working when one hits its usage limit:

```bash
node proxy/cli.mjs account add work          # a browser opens: sign in with that account
node proxy/cli.mjs account add main          # add your own account too (see below)
node proxy/cli.mjs account list
```

- Requests go to the **first ready account** in the order set on the **Accounts** page.
- When an account answers "rate limited", the gateway pauses it until its limit resets (or the time the backend gives) and **retries the same request on the next account**. A signed-out account is skipped until you sign it in again. Your app sees one normal reply.
- Each **project** can be limited to some accounts, in its own order (Projects → Accounts).
- Each account can keep a **reserve**: stop using it above a 5-hour or 7-day percentage, so you keep headroom for your own Claude use.
- **Once you add a named account, the gateway stops using this computer's own sign-in**, so also add your main account with `account add main`.

Only add accounts that are yours. Using several accounts to get around usage limits may break Anthropic's terms. Details: [docs/accounts.md](docs/accounts.md).

## Monitoring and alerts

The gateway records a sample every minute and checks these rules (each can be turned off or tuned under **Alerts → Rules**):

| Alert | Default |
|---|---|
| Account near its limit | 5-hour use ≥ 80 % or 7-day ≥ 90 % |
| Account limit reached / signed out / sign-in expiring | When it happens; renewal within 7 days |
| No Claude account available | A request found no usable account |
| Backend down | Unhealthy for 2 minutes, or 3 restarts in 10 minutes |
| Many requests failing | ≥ 20 % of at least 10 requests in 5 minutes |
| Slow responses (off by default) | Slowest 5 % over 60 s for 10 minutes |
| Queue full | Requests refused or timed out in the queue |
| Project near / at its limit | 80 % and 100 % of a daily or monthly cap |
| Security | An address blocked for bad keys; 10 failed dashboard sign-ins in 15 minutes |

Alerts close by themselves when the problem goes away. Under **Alerts → Where alerts go**, send them to a **webhook** (Slack, Discord, Microsoft Teams, Google Chat or your own endpoint), **Telegram** or **email** (any SMTP server), each with a minimum severity and a test button. Set reminders and quiet hours under Rules (critical alerts still go out during quiet hours).

For Grafana or Uptime Kuma, turn on **Settings → Backend → Metrics endpoint** and scrape `/metrics` with the token shown. Details: [docs/alerts.md](docs/alerts.md).

## Optional: https

Use https when an app requires it, or to encrypt traffic on your network. It needs a certificate your devices trust, made with [mkcert](https://github.com/FiloSottile/mkcert):

| OS | Install mkcert |
|---|---|
| macOS | `brew install mkcert` |
| Linux | `sudo apt install mkcert libnss3-tools` (or your distro's package; see the mkcert README) |
| Windows | `winget install FiloSottile.mkcert` or `choco install mkcert` |

Then, in the gateway folder:

```bash
mkcert -install        # trust a local certificate authority on this computer (asks for permission)
mkdir certs
mkcert -cert-file certs/gateway.pem -key-file certs/gateway-key.pem <your-computer-ip> localhost 127.0.0.1 ::1
node proxy/cli.mjs restart
```

After the restart, port **4100 serves https** and **4180 serves plain http** for clients that don't trust the certificate.

- **Node.js apps** don't read the system certificate store. Start them with `NODE_EXTRA_CA_CERTS=<mkcert -CAROOT>/rootCA.pem`.
- **Other devices** need `rootCA.pem` from `mkcert -CAROOT` installed as a trusted root. Never share `rootCA-key.pem`.

## Optional: a separate Claude sign-in for the gateway

By default the gateway uses the same Claude sign-in as your Claude Code CLI. To give it its own long-lived token and its own config folder, so its sessions never mix with yours and signing out of Claude Code doesn't affect it:

```bash
node proxy/cli.mjs login
```

It runs `claude setup-token`, which opens the browser. Paste the token it prints (`sk-ant-oat…`), and the gateway saves it to `.oauth-token` and restarts with its own home folder in `claude-home/`. Usage still counts against the same subscription quota.

## Commands

Run these in the gateway folder. `bin/gateway` (macOS and Linux) and `bin\gateway.cmd` (Windows) are shortcuts for `node proxy/cli.mjs`.

```bash
node proxy/cli.mjs install                 # install / reinstall and start (also: ./install.sh, install.cmd)
node proxy/cli.mjs uninstall               # stop and remove the login service (data kept)
node proxy/cli.mjs status                  # service, supervisor, backend, sign-in, dashboard address
node proxy/cli.mjs start | stop | restart
node proxy/cli.mjs logs                    # last lines of logs/gateway.log, proxy.log, meridian.log
node proxy/cli.mjs account add <name> [--token]   # add a Claude account (browser sign-in, or a setup token)
node proxy/cli.mjs account list | login <name> | rename <old> <new> | remove <name>
node proxy/cli.mjs login                   # give the gateway its own single Claude sign-in
node proxy/cli.mjs add-project <name>      # create a project key in the terminal
node proxy/cli.mjs set-password '<new>'    # reset the dashboard password
node proxy/cli.mjs run                     # run in the foreground (no service), Ctrl+C to stop
npm test                                   # run the test suite (no install needed)
```

**Updating:**
- **The gateway:** run `git pull`, then `node proxy/cli.mjs restart`.
- **Meridian:** run `cd meridian && npm install @rynfar/meridian@<version>`, then restart.

## Configuration

`config.json` is created on first start; most of it is editable in **Settings**.

| Key                          | Default            | Meaning                                             |
| ---------------------------- | ------------------ | --------------------------------------------------- |
| `port`                       | `4100`             | API and dashboard (https when a certificate exists) |
| `httpPort`                   | `4180`             | Plain http port when https is on                    |
| `host`                       | `0.0.0.0`          | Listen address. Use `127.0.0.1` for this Mac only   |
| `publicHost`                 | your LAN IP        | Address shown in connection details                 |
| `publicUrl`                  | empty              | Public address (tunnel), shown instead of the LAN one |
| `maxConcurrent` / `maxQueue` | `2` / `20`         | Requests run at once / waiting (also sets the backend's limit) |
| `queueTimeoutMs`             | `60000`            | Longest wait in the queue                           |
| `requestTimeoutMs`           | `180000`           | Cut off when the backend is silent this long        |
| `maxBodyMb`                  | `10`               | Largest request body                                |
| `timeZone`                   | this computer's    | When daily and monthly limits reset                 |
| `trustedProxy`               | `none`             | `cloudflare` or `forwarded` when behind a tunnel or proxy ([remote access](docs/remote-access.md)) |
| `enforceMaxTokens`           | `true`             | Backend stops replies at `max_tokens`               |
| `metricsEnabled`             | `false`            | Serve `/metrics` (Prometheus) with a bearer token   |
| `alerts`, `notify`           |                    | Alert rules and channels (edit under Alerts)        |
| `retentionDays`              | `30`               | Request history kept                                |
| `badKeyLimit`                | `20`               | Wrong keys per minute before a 10-minute block      |
| `defaultModel`               | `claude-haiku-5-5` | Used when a request names no model                  |
| `pricing`                    | per family         | $ per million tokens, for estimates only            |

Meridian's settings are in `proxy/gateway.mjs` (`backendEnv`); it is bound to `127.0.0.1:4101` and only the gateway talks to it. It runs in `~/.claude-gateway-work`, outside any git repository, so the model never sees your files.

**Files:**

| Path                           | Contents                                       | In git |
| ------------------------------ | ---------------------------------------------- | ------ |
| `config.json`                  | settings, internal secrets                     | no     |
| `ADMIN_PASSWORD.txt`           | first admin password                           | no     |
| `.internal-key`                | key between gateway and Meridian               | no     |
| `.oauth-token`, `claude-home/` | optional separate Claude sign-in               | no     |
| `gateway.db`                   | projects (key hashes), accounts, request log, samples, alerts, activity (SQLite) | no |
| `data/meridian-config/`        | named Claude accounts (backend profiles)       | no     |
| `certs/`                       | optional https certificate                     | no     |
| `logs/`, `data/`               | logs (rotated at 10 MB, 3 kept), Meridian telemetry | no |

## Troubleshooting

Start with `node proxy/cli.mjs status` and `node proxy/cli.mjs logs`.

| Symptom | Fix |
|---|---|
| Dashboard doesn't load | Check `status`. `EADDRINUSE` in `logs/proxy.log` means another app uses port 4100: stop it or change `port` in `config.json`, then restart |
| "Backend unreachable" / degraded | The backend can take about 10 seconds after a start. Then check `logs/meridian.log`, or use **Settings → Restart backend** |
| "Claude CLI is not signed in" | Run `claude` and sign in (or `node proxy/cli.mjs login` if you use a separate sign-in) |
| `Claude Code CLI was not found` during install | Install it with `npm install -g @anthropic-ai/claude-code` and make sure `claude` works in a new terminal |
| `401 Missing or invalid API key` | Wrong or rotated key. Create or rotate one under Projects |
| `429 … limit reached` / `Paused: 5-hour usage` | A project limit or the quota guard. Adjust it under Projects → Limits |
| `429 Too many invalid keys` | Your address is blocked for 10 minutes. Unblock it in Settings |
| `400 Unknown model` | Use an id from `GET /v1/models` or add an alias under Models |
| `404` from an app | The base URL format is wrong: Anthropic-style clients use the host only, OpenAI-style clients need `/v1` |
| Certificate errors | Run `mkcert -install` on that machine; for Node apps set `NODE_EXTRA_CA_CERTS`; or use `http://<host>:4180` |
| `429 All … accounts tried are rate limited` | Every account the project may use is paused. Add an account, wait for the reset time shown, or allow more accounts for the project |
| `503 The Claude account is signed out` | Run `node proxy/cli.mjs account login <name>` (or `claude login` for this computer's sign-in) |
| Alerts not arriving | Use **Send test** under Alerts → Where alerts go. Failed sends are listed in Activity |
| Requests show `127.0.0.1` through a tunnel | Set Settings → Network → "Behind a proxy or tunnel" |
| Forgot the dashboard password | `node proxy/cli.mjs set-password '<new>'` |
| Linux: `systemd user services are not available` | Run `node proxy/gateway.mjs` from your session startup, or use a process manager |
| Windows: not running after login | Check Task Scheduler → `ClaudeGateway`, or run `bin\gateway.cmd start` |

## Security notes

- **Project keys** are random (`cgw_` plus 32 characters) and stored only as SHA-256 hashes. A key is shown once.
- **Meridian is reachable only from this computer**, and only with the internal key. Only `/v1/messages`, `/v1/messages/count_tokens`, `/v1/chat/completions` and `/v1/models` reach it; `/health` and the dashboard are answered by the gateway.
- **The dashboard** uses a password (scrypt) and an HttpOnly, SameSite=Strict session cookie (Secure over https). Changes need a custom header, as CSRF protection. Sign-in attempts are limited per address and overall, and failures are logged. Changing the password or "Sign out everywhere" ends every session. The page runs under a strict Content-Security-Policy with no inline scripts.
- **Client addresses** come from the connection. Proxy headers are believed only when you choose a trusted proxy in Settings and the connection comes from this computer, so callers can't fake their address to get around blocking.
- **Alert channel secrets** (webhook URL, Telegram token, SMTP password) are stored in `config.json` (mode 600) and never sent back to the browser.
- **Prompts and replies are never stored.** Only metadata (tokens, timings, status, error text) is logged, and kept for `retentionDays`.
- **CSV exports** escape formula-like cells.
- **Network exposure:** the gateway listens on your network by default. Set `"host": "127.0.0.1"` in `config.json` if only this Mac should reach it. Don't expose it to the internet.

## How it works

```
login service (launchd / systemd / Task Scheduler)
  └─ proxy/gateway.mjs   supervisor: restarts children, writes logs, one per folder (data/gateway.pid)
       ├─ Meridian         127.0.0.1:4101, the Claude backend (Agent SDK + Claude Code CLI)
       └─ proxy/server.mjs 0.0.0.0:4100, keys, limits, accounts, usage log, monitoring, alerts, dashboard
```

The gateway's modules: `proxy.mjs` (checks, queue, account fallback, forwarding), `accounts.mjs` (account state and quota), `monitor.mjs` (one sample a minute and alert rules), `alerts.mjs` and `notify.mjs` with `smtp.mjs` (alerts and channels), `admin.mjs` (dashboard API), `public/` (the dashboard: `index.html`, `app.js`, `app.css`, no build step).

- **`proxy/server.mjs`** and its modules make up the gateway, written in plain Node 22 with no npm dependencies.
  - Built-in `node:sqlite` stores projects and the request log.
  - It checks the project key and every limit, forwards the request to Meridian with the internal key, and streams the reply back unchanged.
  - Along the way it reads token usage from the response or stream and writes one log row.
- **[Meridian](https://github.com/rynfar/meridian)** (MIT) translates the Anthropic and OpenAI APIs to the Claude Agent SDK and Claude Code CLI.
  - It runs in passthrough mode, so client tools are returned to the client instead of being run.
  - It keeps sessions warm and reports the subscription quota.
- **`proxy/gateway.mjs`** is the supervisor.
  - It starts both children and restarts either one with backoff.
  - It tells the gateway the backend's process id (for memory figures) and handles "Restart backend" from the dashboard over IPC.
- **`proxy/cli.mjs`** installs and controls the login service on each OS.
- **Why a user service:** the services run as you, not as a system service, because the Claude CLI's sign-in belongs to your user account. So they start when you log in. On Linux, lingering can keep them running while you're logged out.

## Tests

```bash
npm test      # or: node --test test/*.test.mjs
```

The tests start the gateway against a fake backend in a temporary folder. They cover keys, limits, token counting for both API formats, CORS, address trust, body size, account fallback (rate limit, sign-out, errors at the start of a stream, per-project accounts), the queue timeout, disconnects, time zones and the SMTP client. They never touch your real data or accounts.

## Uninstall

```bash
node proxy/cli.mjs uninstall   # stops the gateway and removes the login service
# then delete the folder to remove keys, history, logs and certificates
```

If you used https, also run `mkcert -uninstall` to remove the local certificate authority.

## Credits and license

- Built on **[Meridian](https://github.com/rynfar/meridian)** by rynfar (MIT).
- This project is released under the [MIT License](LICENSE).
- It isn't affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.
