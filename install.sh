#!/bin/zsh
# Installs both services as user LaunchAgents: they start at login and restart if they stop.
set -e
GW="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null || { echo "node not found in PATH"; exit 1; }
command -v node > "$GW/.node-path"
[ -f "$GW/.internal-key" ] || { openssl rand -hex 24 > "$GW/.internal-key"; }
chmod 600 "$GW/.internal-key"
chmod +x "$GW/bin/"*.sh
mkdir -p "$GW/logs" "$HOME/Library/LaunchAgents"

for name in meridian proxy; do
  label="com.local.claude-gateway.$name"
  plist="$HOME/Library/LaunchAgents/$label.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>$GW/bin/run-$name.sh</string></array>
  <key>WorkingDirectory</key><string>$GW</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$GW/logs/$name.log</string>
  <key>StandardErrorPath</key><string>$GW/logs/$name.log</string>
</dict></plist>
EOF
  cp "$plist" "$GW/launchd/$label.plist"
  launchctl bootout "gui/$UID/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$plist"
  echo "Started $label"
done
echo "Dashboard: http://localhost:4100  (password in $GW/ADMIN_PASSWORD.txt once the proxy has started)"
