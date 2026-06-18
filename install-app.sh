#!/usr/bin/env bash
#
# Builds the ClaudeNav desktop app (Tauri) from this clone and installs exactly
# ONE copy into /Applications, so it's launchable by name from Spotlight /
# Launchpad. Re-running rebuilds and replaces the installed copy in place —
# there is never more than one ClaudeNav.app in /Applications.
#
#   ./install-app.sh            # build release bundle + install to /Applications
#   ./install-app.sh uninstall  # quit + remove /Applications/ClaudeNav.app
#
# macOS only (the .app bundle is a macOS artifact). The wrapper itself is
# cross-platform; on Windows/Linux use `npm run app:build` and the platform's
# own installer output under src-tauri/target/release/bundle/.
set -euo pipefail

APP_NAME="ClaudeNav"
DEST="/Applications/$APP_NAME.app"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BUNDLE="$REPO_DIR/src-tauri/target/release/bundle/macos/$APP_NAME.app"

quit_running() {
  osascript -e "tell application \"$APP_NAME\" to quit" 2>/dev/null || true
  pkill -f "$APP_NAME.app/Contents/MacOS/claudenav-desktop" 2>/dev/null || true
}

if [ "${1:-}" = "uninstall" ]; then
  quit_running
  sleep 1
  rm -rf "$DEST"
  echo "Uninstalled — removed $DEST"
  echo "(The server LaunchAgent, if any, is untouched: ./install-launchagent.sh uninstall)"
  exit 0
fi

if [ "$(uname)" != "Darwin" ]; then
  echo "error: install-app.sh installs a macOS .app. On this platform run" >&2
  echo "       'npm run app:build' and use the output under" >&2
  echo "       src-tauri/target/release/bundle/." >&2
  exit 1
fi

# --- Toolchain: Rust + the Tauri CLI (a devDependency) -----------------------
# Pick up a rustup install that isn't on the login PATH yet.
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
if ! command -v cargo >/dev/null 2>&1; then
  echo "error: Rust toolchain not found. Install it once with:" >&2
  echo "       curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "error: node not found on PATH" >&2; exit 1; }

# Install JS deps (Tauri CLI) on first run / fresh clone.
if [ ! -d "$REPO_DIR/node_modules/@tauri-apps/cli" ]; then
  echo "==> installing build dependencies (npm install)…"
  (cd "$REPO_DIR" && npm install)
fi

# --- Build -------------------------------------------------------------------
echo "==> building release bundle (this can take a few minutes the first time)…"
(cd "$REPO_DIR" && npm run app:build -- --bundles app)
[ -d "$BUNDLE" ] || { echo "error: build did not produce $BUNDLE" >&2; exit 1; }

# --- Install exactly one copy ------------------------------------------------
echo "==> installing to $DEST"
quit_running
sleep 1
rm -rf "$DEST"               # guarantees a single, current copy
cp -R "$BUNDLE" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true  # locally built; no Gatekeeper prompt
mdimport "$DEST" 2>/dev/null || true                        # nudge Spotlight to index it now

echo
echo "Installed $APP_NAME → $DEST"
echo "Launch it: ⌘-Space, type \"$APP_NAME\", Enter  (or: open -a $APP_NAME)"
echo "Remove it: ./install-app.sh uninstall"
