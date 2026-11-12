# Claude gateway (local)

This gateway lets apps on your Mac and your local network use your logged-in `claude` CLI subscription as an HTTP API. Each project gets its own key, and usage is tracked per project.

```
apps ──project key──▶ key proxy :4100 (0.0.0.0) ──internal key──▶ Meridian :4101 (127.0.0.1) ──▶ Claude
```

- **Meridian** ([rynfar/meridian](https://github.com/rynfar/meridian), npm `@rynfar/meridian`, pinned to 1.89.0) does the Claude side:
  - Anthropic `/v1/messages`, OpenAI `/v1/chat/completions` and `/v1/models`.
  - Client tools come back as `tool_use` blocks (passthrough mode).
  - Streaming.
- **The key proxy** (`proxy/`, plain Node 22, no npm dependencies, SQLite in `gateway.db`) handles everything per project:
  - keys, enable/disable, daily caps and allowed models
  - one usage row per request: tokens, estimated cost, latency, status and error; prompts are never stored
  - the dashboard.

## Use

- Dashboard: <http://localhost:4100> or <http://192.168.11.61:4100>. The admin password is in `ADMIN_PASSWORD.txt`.
- Base URL for clients: `http://192.168.11.61:4100`. Send the key as `x-api-key: <key>` or `Authorization: Bearer <key>`.
- Models: `claude-haiku-5-5` (fastest), `claude-sonnet-5-5`, `claude-opus-5-5`.
- Create, rotate and disable keys in the dashboard under **Projects**. A key is shown once.

### CRM assistant

1. In the CRM `.env`, set `WEBHOOKS_ALLOW_PRIVATE=true`, then restart `npm run dev`. Without it the CRM only accepts https and public addresses.
2. In Settings → Assistant → Provider, choose **Custom**:
   - Format: messages
   - Address: `http://192.168.11.61:4100`
   - API key: the CRM project key
   - Model: `claude-haiku-5-5`

## Commands

```
zsh install.sh                    # install / reinstall both LaunchAgents (start at login, restart if they stop)
zsh uninstall.sh                  # stop and remove from login (data kept)
zsh bin/run-proxy.sh add-project <name>     # create a project key from the terminal
zsh bin/run-proxy.sh set-password <new>     # change the dashboard password
launchctl kickstart -k gui/$UID/com.local.claude-gateway.proxy      # restart proxy
launchctl kickstart -k gui/$UID/com.local.claude-gateway.meridian   # restart Meridian
tail -f logs/proxy.log logs/meridian.log
```

- To update Meridian: `cd meridian && npm install @rynfar/meridian@<version>`, then restart it.
- Meridian's own telemetry page is at <http://127.0.0.1:4101/telemetry> and is reachable from this Mac only.

## Notes

- **Memory:** about 155 MB when idle (proxy about 80 MB, Meridian about 75 MB). The Claude processes add more while requests run. At most 2 requests run at once and the rest queue (`maxConcurrent` in `config.json`, `MERIDIAN_MAX_CONCURRENT` in `bin/run-meridian.sh`).
- **Login timing:** these are user LaunchAgents, because the CLI uses your keychain login. They start when you log in, not at boot.
- **Firewall:** the macOS firewall may ask once to allow incoming connections for `node`.
- **Secrets:** `config.json`, `.internal-key`, `ADMIN_PASSWORD.txt`, `CRM_KEY.txt` and `gateway.db` are git-ignored.
- **Personal use only:** the gateway runs on your personal Claude subscription. Keep it for your own testing, and check Anthropic's terms before sharing it with others.
- **Cost figures** in the dashboard estimate what the same tokens would cost on the paid API (prices are in `config.json`). They are not a bill.
