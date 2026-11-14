# Reach the gateway from servers outside your network

By default the gateway answers only on your local network (LAN). This guide shows how apps running elsewhere, such as on shared hosting, a VPS or a cloud server, can call it.

The idea: the PC running the gateway opens an **outgoing** connection to a tunnel service. The service gives you a public https address and passes requests back to the gateway. You don't need a public IP, router port forwarding or firewall changes.

```
App on shared hosting ──https──▶ tunnel service (public address) ──▶ tunnel client on your PC ──▶ gateway :4180
```

> **Before you start**
> - **The PC must stay on and awake.** If it sleeps or shuts down, the API is down for every app.
> - **Personal use only.** A Claude subscription is for one person's own use. Point your own apps at it. Don't offer it to other people or as a service.
> - **Once it's public, anyone who finds the address can try keys.** Follow [Lock it down](#lock-it-down).

## Choose an option

| Option | Address | Needs | Best for |
|---|---|---|---|
| [Cloudflare named tunnel](#option-1-cloudflare-named-tunnel-recommended) | Fixed, e.g. `https://claude.example.com` | Free Cloudflare account, a domain whose DNS is on Cloudflare | Normal use (recommended) |
| [ngrok static domain](#option-2-ngrok-static-domain) | Fixed, e.g. `https://name.ngrok-free.app` | Free ngrok account | No domain on Cloudflare |
| [Cloudflare quick tunnel](#option-3-cloudflare-quick-tunnel-testing-only) | Random, **changes on every restart** | Nothing | A five-minute test |
| [Tailscale](#option-4-tailscale-servers-you-control) | Private, e.g. `http://100.x.y.z:4180` | Tailscale installed on each server | VPS or cloud servers you control (not shared hosting) |

Shared hosting can't run Tailscale or other software, so use option 1 or 2 there. Shared hosts almost always allow outgoing https on port 443, which is all these tunnels need.

All options point the tunnel at the gateway's **plain http port, `4180`**. The tunnel provides https on the public side. (Without local certificates, the gateway serves http on `4100` instead: use that port.)

---

## Option 1: Cloudflare named tunnel (recommended)

### 1. Install cloudflared

| OS | Command |
|---|---|
| macOS | `brew install cloudflared` |
| Linux (Debian/Ubuntu) | See the [Cloudflare downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), or install the `.deb` from the cloudflared GitHub releases |
| Windows | `winget install --id Cloudflare.cloudflared` |

### 2. Create the tunnel

```sh
cloudflared tunnel login                        # opens a browser; pick your domain
cloudflared tunnel create claude-gateway        # prints the tunnel ID and a credentials file
cloudflared tunnel route dns claude-gateway claude.example.com
```

### 3. Configure it

Create `~/.cloudflared/config.yml` (on Windows, `%USERPROFILE%\.cloudflared\config.yml`):

```yaml
tunnel: claude-gateway
credentials-file: /path/to/.cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: claude.example.com
    service: http://localhost:4180
    path: ^/(v1/|health$)
  - service: http_status:404
```

The `path` rule publishes only the API (`/v1/...` and `/health`). **The admin dashboard stays private**: open it on your LAN as before.

### 4. Test, then run it at startup

```sh
cloudflared tunnel run claude-gateway           # test in the foreground; Ctrl+C to stop
curl https://claude.example.com/health          # from any other machine: {"status":"ok",...}
```

To start it at boot:

| OS | Command |
|---|---|
| macOS | `sudo cloudflared service install` |
| Linux | `sudo cloudflared service install` |
| Windows (Administrator) | `cloudflared service install` |

The service reads the same `config.yml`. On macOS and Linux, if it can't find the file, copy `config.yml` and the credentials file to `/etc/cloudflared/` and fix `credentials-file` in it.

### 5. Tell the gateway about the tunnel

In the dashboard, open **Settings → Network and time**:

- **Behind a proxy or tunnel:** choose **Cloudflare tunnel**. The gateway then reads the caller's real address from Cloudflare's `cf-connecting-ip` header, so the request log shows your app server's address and blocking addresses that try bad keys keeps working. Without this, every caller shows as `127.0.0.1`.
- **Public URL:** `https://claude.example.com`. Connection details and code snippets then show this address.

Only choose a proxy when you really use one: the header is then believed for every connection from this computer.

---

## Option 2: ngrok static domain

1. Create a free account at ngrok.com, install the agent and run `ngrok config add-authtoken <token>`.
2. In the ngrok dashboard, claim your free static domain.
3. Run:

   ```sh
   ngrok http 4180 --url=https://your-name.ngrok-free.app
   ```

4. To start it at boot, add the tunnel to ngrok's config file and run `ngrok service install --config <path>`. See ngrok's "agent as a service" docs.

The free plan has request and bandwidth limits, which are fine for testing and light use. ngrok publishes the dashboard too, so rely on the dashboard password, or use Option 1 if you want it private.

Then in **Settings → Network and time**, set **Behind a proxy or tunnel** to **Other proxy or tunnel (X-Forwarded-For)** and **Public URL** to your ngrok address.

---

## Option 3: Cloudflare quick tunnel (testing only)

```sh
cloudflared tunnel --url http://localhost:4180
```

It prints a random `https://….trycloudflare.com` address. It needs no account, but the address changes every time the tunnel starts, and it publishes the dashboard too. Use it only to check that your app can reach the gateway.

---

## Option 4: Tailscale (servers you control)

For a VPS or cloud server where you can install software. Nothing becomes public.

1. Install Tailscale on the gateway PC and on each server, and sign in to the same account.
2. Find the PC's Tailscale address: `tailscale ip -4` (or its MagicDNS name).
3. On the server, use base URL `http://100.x.y.z:4180`.

---

## Call it from your app

Use the public address as the base URL and a project key from the dashboard. Keep the key in server-side config (`.env`, `config.php`), **never** in browser JavaScript.

**PHP (shared hosting):**

```php
$ch = curl_init('https://claude.example.com/v1/messages');
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_POST => true,
  CURLOPT_TIMEOUT => 120,
  CURLOPT_HTTPHEADER => [
    'content-type: application/json',
    'x-api-key: ' . getenv('CLAUDE_GATEWAY_KEY'),
    'anthropic-version: 2023-06-01',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'model' => 'claude-haiku-5-5',
    'max_tokens' => 500,
    'messages' => [['role' => 'user', 'content' => 'Hello']],
  ]),
]);
$data = json_decode(curl_exec($ch), true);
$text = end($data['content'])['text'] ?? null;
```

**Node:**

```js
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "https://claude.example.com", apiKey: process.env.CLAUDE_GATEWAY_KEY });
```

**OpenAI-style clients:** base URL `https://claude.example.com/v1`.

Set a generous timeout (60–120 s). Each request runs through the Claude CLI on your PC, so it's slower than the paid API.

---

## Lock it down

- **One project per app.** Rotate or disable one key without touching the others.
- **Set limits** on every public key: requests per minute, tokens per day and month, and "Pause above 5-hour quota %" so your own CLI use keeps headroom.
- **Allowed models:** limit public keys to the models they need (for example `haiku`).
- **Keep the dashboard private:** use the `path` rule in Option 1.
- **Optional extra wall:** with Cloudflare, add a WAF rule that allows only your hosting server's IP for `claude.example.com`. Find that IP in the dashboard's request log after the first call.
- **Watch the dashboard** for unknown IPs and 401 spikes. Repeated bad keys from one address get blocked automatically, and a Security alert opens.
- **Get told when it breaks:** set up an alert channel (Alerts → Where alerts go) so you hear when the backend is down or every account is rate limited. See [alerts.md](alerts.md).
- **Several accounts:** with two or more Claude accounts, apps keep working when one hits its limit. See [accounts.md](accounts.md).

## Troubleshooting

| Symptom | Check |
|---|---|
| `502` / `530` from Cloudflare | Gateway not running on this PC (`node proxy/cli.mjs status`), or the tunnel points to the wrong port |
| `curl: Could not resolve host` | DNS route not created (`cloudflared tunnel route dns …`) or not propagated yet |
| Timeouts from the app | PC asleep; app timeout too short; host blocks outgoing connections (ask the host, or test with `curl` over SSH) |
| `401 authentication_error` | Wrong or rotated key; the header must be `x-api-key` or `Authorization: Bearer …` |
| Every request shows `127.0.0.1` | Set Settings → Network → "Behind a proxy or tunnel" |
| `429` | A project limit was reached, or too many bad keys came from that address (unblock it in the dashboard) |
