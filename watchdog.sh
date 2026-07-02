#!/usr/bin/env bash
#
# Watchdog: polls the running ClaudeNav and kickstarts the LaunchAgent if it's
# unreachable. Covers the cases the crash-restart loop can't:
#   - the server is hung (process alive, not serving requests), and
#   - run-server.sh hit its crash cap and exited 0, so launchd won't relaunch it.
#
# Meant to be run on an interval by its own LaunchAgent (see
# install-launchagent.sh). Safe to run by hand too. Logs to the same file as the
# server so a restart leaves a trace.
LABEL="com.claudenav.server"
PORT="${PORT:-4317}"
HOST="127.0.0.1"
LOG="${CLAUDENAV_LOG:-/tmp/claudenav.log}"

# Probe the cheapest real endpoint. --max-time guards against a hung socket that
# accepts the connection but never responds; -f makes non-2xx a failure.
if v=$(curl -fsS --max-time 5 "http://$HOST:$PORT/api/version" 2>/dev/null); then
  # Reachable — but is it stale? A commit on disk that the running process
  # predates shows up as head != bootHead (the UI's manual "relaunch" case).
  # Auto-apply it via the server's own graceful relaunch (/api/update, exit 42)
  # so committing is enough to deploy; in-flight turns are the same casualty
  # they'd be with the UI button. grep is case-sensitive, so '"head"' does not
  # match '"bootHead"'; a null/absent hash yields "" and skips the restart.
  head=$(printf '%s' "$v" | grep -o '"head":"[^"]*"' | cut -d'"' -f4)
  boot=$(printf '%s' "$v" | grep -o '"bootHead":"[^"]*"' | cut -d'"' -f4)
  if [ -n "$head" ] && [ -n "$boot" ] && [ "$head" != "$boot" ]; then
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') watchdog: stale code (running $boot, disk at $head) — relaunching ===" >> "$LOG"
    curl -fsS --max-time 10 -X POST -H 'Content-Type: application/json' \
      -d '{"pull":false}' "http://$HOST:$PORT/api/update" >/dev/null 2>>"$LOG"
  fi
  exit 0
fi

echo "=== $(date '+%Y-%m-%d %H:%M:%S') watchdog: $HOST:$PORT unreachable — kickstarting $LABEL ===" >> "$LOG"
# -k kills any existing (possibly hung) instance first, then (re)starts it.
# This forces a restart even after run-server.sh's crash cap, which deliberately
# exits 0 so launchd's KeepAlive won't relaunch on its own.
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>>"$LOG"
