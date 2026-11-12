#!/bin/zsh
# Stops both services and removes them from login startup. Data, keys and logs are kept.
for name in meridian proxy; do
  label="com.local.claude-gateway.$name"
  launchctl bootout "gui/$UID/$label" 2>/dev/null && echo "Stopped $label"
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
done
