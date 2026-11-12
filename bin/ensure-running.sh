#!/bin/zsh
# Makes sure both gateway LaunchAgents are loaded and running. Safe to run any time.
GW="$(cd "$(dirname "$0")/.." && pwd)"
for name in meridian proxy; do
  label="com.local.claude-gateway.$name"
  plist="$HOME/Library/LaunchAgents/$label.plist"
  if ! launchctl print "gui/$UID/$label" >/dev/null 2>&1; then
    [ -f "$plist" ] || { zsh "$GW/install.sh" >/dev/null 2>&1; exit 0; }
    launchctl bootstrap "gui/$UID" "$plist" 2>/dev/null
  elif ! launchctl print "gui/$UID/$label" | grep -q "state = running"; then
    launchctl kickstart "gui/$UID/$label" 2>/dev/null
  fi
done
exit 0
