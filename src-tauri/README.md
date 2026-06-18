# ClaudeNav desktop wrapper (Tauri v2)

A thin native shell around the existing `server.js`. It opens a real app window
(dock icon, own window, menu) instead of a browser tab. **No backend logic is
duplicated here** — the wrapper just makes sure the Node server is running and
points a WebView at `http://127.0.0.1:4317`.

## How it works

On launch (`src/main.rs`):

1. **Probe** `127.0.0.1:4317`.
   - If something already answers (e.g. the `com.claudenav.server` LaunchAgent,
     or another copy of the app), **attach** to it and leave it running on quit.
   - Otherwise **spawn** `node server.js` ourselves and stop it on quit.
2. Wait (≤15s) for the port to come up, then open the window.

This makes the app safe to run alongside the LaunchAgent — it won't double-bind
the port or kill a server it didn't start.

## Develop

```bash
npm install            # once, installs @tauri-apps/cli
npm run app:dev        # compile + launch the app with live reload
```

## Install (macOS)

The canonical path — builds the release bundle and installs exactly one copy
into `/Applications` so it's launchable by name from Spotlight:

```bash
./install-app.sh            # from the repo root
./install-app.sh uninstall
```

Re-running rebuilds and replaces the installed copy in place (never more than
one ClaudeNav.app in /Applications).

## Build a distributable (any platform)

```bash
npm run app:build      # .app/.dmg (macOS), .msi/.exe (Windows), .deb/.AppImage (Linux)
```

Bundled artifacts land in `src-tauri/target/release/bundle/`. `install-app.sh`
is macOS-only (it installs a `.app`); on Windows/Linux use the installer output
here directly.

## Icons

`gen-icon.js` writes a dependency-free 1024² source PNG; `cargo tauri icon`
(via `npm run tauri icon src-tauri/app-icon.png`) expands it into the platform
icon set under `icons/` (incl. android/ios for future mobile targets).

## Cross-platform notes

The wrapper itself is platform-agnostic:

- **Node resolution** (`resolve_node`) tries PATH first, then per-OS fallback
  dirs — important because GUI-launched apps get a minimal PATH. Override with
  `CLAUDENAV_NODE=/path/to/node`.
- Paths use `std::path`; the child process is managed via `std::process` on all
  platforms.

Outstanding for true Windows/Linux distribution:

- **Bundle Node as a sidecar.** Today we spawn the system `node` (every Claude
  Code user already has one). To ship to machines without Node, add a
  per-platform `node` sidecar binary in `tauri.conf.json` → `bundle.externalBin`
  and point `resolve_node` at it.
- The **server's terminal-opening features are macOS-only** (AppleScript). On
  Windows/Linux the app still gives the read-only dashboard + headless chat;
  porting those actions is a `server.js` task, not a wrapper task.
