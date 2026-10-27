#!/usr/bin/env bash
# Launches ClaudeNav and records every exit (timestamp + code) so crashes
# leave a trace. Auto-restarts on non-zero exit; a clean stop (code 0) ends.
LOG=/tmp/claudenav.log
cd "$(dirname "$0")" || exit 1
# Give up after this many crashes within the rapid-crash window (seconds).
MAX_CRASHES=3
WINDOW=60
fails=0
window_start=$SECONDS
# Take the server down with us. The LaunchAgent sets AbandonProcessGroup (so
# detached headless turns survive a restart), which also means launchd does NOT
# kill node when it stops this script — a `kickstart -k` used to orphan the
# running server.js, which kept the port forever while every fresh launch
# crash-looped on EADDRINUSE. Run node in the background and forward the signal.
child=""
trap '[ -n "$child" ] && kill -TERM "$child" 2>/dev/null && wait "$child"; echo "=== $(date '"'"'+%Y-%m-%d %H:%M:%S'"'"') run-server.sh stopped (signal) ===" >> "$LOG"; exit 0' TERM INT HUP
while true; do
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') starting server.js ===" >> "$LOG"
  node server.js >> "$LOG" 2>&1 &
  child=$!
  wait "$child"
  code=$?
  child=""
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') server.js exited (code $code) ===" >> "$LOG"
  [ "$code" -eq 0 ] && break
  # Code 42 = the server asked to relaunch (in-app update). Restart immediately
  # and don't count it against the crash cap.
  if [ "$code" -eq 42 ]; then
    echo "=== relaunch requested (code 42) — restarting now ===" >> "$LOG"
    fails=0
    window_start=$SECONDS
    continue
  fi
  # Reset the counter if the last crash was outside the rapid-crash window.
  if [ $(( SECONDS - window_start )) -gt "$WINDOW" ]; then
    fails=0
    window_start=$SECONDS
  fi
  fails=$(( fails + 1 ))
  if [ "$fails" -ge "$MAX_CRASHES" ]; then
    # Exit 0 so launchd (KeepAlive: SuccessfulExit=false) treats this as an
    # intentional stop and does NOT relaunch us — the crash cause is logged above.
    echo "=== gave up after $fails crashes within ${WINDOW}s — not restarting (last code $code) ===" >> "$LOG"
    exit 0
  fi
  echo "=== restarting in 2s after crash ($fails/$MAX_CRASHES) ===" >> "$LOG"
  sleep 2
done
