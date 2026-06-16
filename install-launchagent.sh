#!/usr/bin/env bash
#
# Installs ClaudeNav as a macOS LaunchAgent so it survives logout, restarts on
# crash, and runs at login. Generates the plist from the current machine's paths
# — no values are hardcoded, so it works on a fresh clone.
#
#   ./install-launchagent.sh           # install + load
#   ./install-launchagent.sh uninstall # stop + remove
#
set -euo pipefail

LABEL="com.claudenav.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="${CLAUDENAV_LOG:-/tmp/claudenav.log}"

if [ "${1:-}" = "uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Uninstalled $LABEL and removed $PLIST"
  exit 0
fi

# Locate node and claude on THIS machine (fall back gracefully).
NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && { echo "error: node not found on PATH" >&2; exit 1; }
CLAUDE_BIN="$(command -v claude || true)"   # may be empty; server.js also probes

# Build a PATH that includes node's and claude's dirs plus the usual suspects.
EXTRA_PATHS="$(dirname "$NODE_BIN")"
[ -n "$CLAUDE_BIN" ] && EXTRA_PATHS="$(dirname "$CLAUDE_BIN"):$EXTRA_PATHS"
FULL_PATH="$EXTRA_PATHS:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# CLAUDE_BIN block is only emitted when we actually found one.
CLAUDE_ENV=""
[ -n "$CLAUDE_BIN" ] && CLAUDE_ENV="        <key>CLAUDE_BIN</key>
        <string>$CLAUDE_BIN</string>"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$REPO_DIR/run-server.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>
    <!-- Restart only on unexpected (non-zero) death; run-server.sh exits 0 on a
         clean stop or after its own crash-cap, so launchd defers to it. -->
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$FULL_PATH</string>
$CLAUDE_ENV
    </dict>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Installed $LABEL"
echo "  plist: $PLIST"
echo "  repo:  $REPO_DIR"
echo "  node:  $NODE_BIN"
echo "  claude: ${CLAUDE_BIN:-<not found — server.js will probe known locations>}"
echo "  log:   $LOG"
echo
echo "Manage:  launchctl list | grep claudenav"
echo "Stop:    ./install-launchagent.sh uninstall"
