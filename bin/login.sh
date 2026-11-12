#!/bin/zsh
# Gives the gateway its own Claude sign-in: creates a long-lived token with `claude setup-token`
# (opens the browser), stores it in .oauth-token and restarts the backend with its own Claude home.
set -e
GW="$(cd "$(dirname "$0")/.." && pwd)"
echo "Step 1: a browser window opens. Sign in and approve."
echo "Step 2: copy the token it prints (starts with sk-ant-oat) and paste it below."
echo
CLAUDE_CONFIG_DIR="$GW/claude-home" claude setup-token || true
echo
read -rs "TOKEN?Paste the token (hidden), then Enter: "
echo
TOKEN="${TOKEN//[[:space:]]/}"
if [[ "$TOKEN" != sk-ant-* ]]; then echo "That does not look like a token. Nothing changed."; exit 1; fi
umask 077
printf '%s\n' "$TOKEN" > "$GW/.oauth-token"
chmod 600 "$GW/.oauth-token"
launchctl kickstart -k "gui/$UID/com.local.claude-gateway.meridian"
echo "Saved. The backend restarted with its own Claude home ($GW/claude-home)."
echo "Check the dashboard: Settings → Backend should say 'Signed in'."
