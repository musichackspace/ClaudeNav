# ClaudeNav

A local navigator for your Claude Code sessions. See every session grouped by
project, spot which terminals are **live right now**, read a one-line summary of
each, and jump back in — or start a fresh session — with one click.

![overview](docs/screenshot.png)

## Why

If you keep many terminals open running Claude Code, it's easy to lose track of
which one is doing what. ClaudeNav reads the session transcripts Claude Code
already writes to `~/.claude/projects/` and turns them into a browsable
dashboard.

## Run

```bash
node server.js
# then open http://127.0.0.1:4317
```

No dependencies, no build step. Requires Node 18+ and macOS (for opening
terminals via AppleScript). Binds to `127.0.0.1` only.

Change the port with `PORT=5000 node server.js`.

## Desktop app (macOS)

Prefer launching ClaudeNav by name from Spotlight/Launchpad instead of a browser
tab? Build and install the native app — one canonical command, and it installs
exactly one copy into `/Applications`:

```bash
./install-app.sh            # build the release bundle + install to /Applications
./install-app.sh uninstall  # quit + remove it
```

Then ⌘-Space → "ClaudeNav". The app is a thin [Tauri](https://tauri.app) shell
(`src-tauri/`) around the same `server.js` — it doesn't duplicate any backend
logic. On launch it reuses an already-running server (e.g. the LaunchAgent
below) if one is up, otherwise it starts `node server.js` itself and stops it on
quit.

Re-running `./install-app.sh` rebuilds from your clone and replaces the
installed copy in place, so everyone ends up with the same artifact and there's
never more than one in `/Applications`. First run installs the build toolchain
prerequisites (Rust must be present — `curl --proto '=https' --tlsv1.2 -sSf
https://sh.rustup.rs | sh` once if not). See `src-tauri/README.md` for the
internals and the Windows/Linux build path.

## Windows

**One-click start:** double-click **`start-claudenav.cmd`** in the repo. It finds
Node, starts the server, and opens the dashboard in your browser — no build step.
Keep the window open while you use ClaudeNav; close it to stop the server. If a
copy is already running it just opens the dashboard. (Only Node 18+ is required;
the script also probes the usual install dirs if `node` isn't on `PATH`.)

**Run at login:** press `Win+R`, run `shell:startup`, and drop a shortcut to
`start-claudenav.cmd` in that folder. Unlike macOS there's no LaunchAgent, so a
dedicated crash-restart service (the launchd/watchdog equivalent) isn't shipped.

### Native app (optional)

Prefer a real installed app that launches by name from the Start menu? The same
Tauri wrapper builds a native Windows installer. There's no `install-app.sh` on
Windows (it installs a macOS `.app`) — instead build the installer and run it:

```powershell
npm install            # once
npm run app:build      # emits the installer under src-tauri\target\release\bundle\
```

Double-click the resulting `ClaudeNav_*.msi` (or the NSIS `.exe`) to install.
ClaudeNav then launches by name from the **Start menu**, opens its own window,
and manages the server itself — on launch it attaches to an already-running
server on `127.0.0.1:4317` or starts `node server.js` and stops it on quit.

Prerequisites: **Node 18+** (every Claude Code user already has it) and the
[Rust toolchain](https://rustup.rs) + the WebView2 runtime (preinstalled on
Windows 11) to *build*. Installed machines only need Node on `PATH`; the wrapper
also probes the usual install dirs (`%ProgramFiles%\nodejs`, npm-global,
nvm-windows, scoop) and honours `CLAUDENAV_NODE` if Node lives somewhere else.
To start it at login, put a shortcut to the installed app in `shell:startup`
(same as above).

Note: the server's **terminal-opening** actions (resume in a terminal, `/login`
re-auth) work on Windows via `cmd`, but some conveniences are still macOS-first —
see the cross-platform notes in `src-tauri/README.md`.

## What it shows

- **Projects** grouped by working directory, live ones first.
- **Live terminals** — detected from running `claude` CLI processes and their
  working directories. A green dot marks sessions likely open in a terminal now.
- For each session: the auto-generated **title**, the **last prompt**, git
  branch, message count, and time since last activity.
- A **search** box that filters across title, last prompt, path, and branch.

- **Active-folder cards** at the top — one per folder that has a live terminal,
  as quick jump links to that project's sessions.

### Traffic-light status

Every session shows a colored light at a glance:

- 🟡 **amber, pulsing** — working (a turn is in progress)
- 🟢 **green** — ready / your turn (waiting for input)
- 🔴 **red** — interrupted (stopped mid-work, stale)
- ⚪ **grey** — idle (dormant)

The header shows running totals. In the chat panel a large light flips amber
while Claude works and green when it's ready — and when a turn finishes the
browser tab title flashes "🟢 Ready" and the favicon turns green, so you notice
even with the tab in the background (it stops flashing when you focus the tab).

## Actions

- **Resume ▸** — opens a new Terminal (or iTerm) window running
  `claude --resume <session-id>` in that project's directory.
- **+ New terminal** — opens a new Terminal (or iTerm) window running `claude`
  in that project's directory, ready for a fresh interactive session.
- **+ New in browser** — starts a fresh session **headlessly** in that directory
  and drops you into the in-browser chat (no terminal). The session id is chosen
  up front, so the first message creates it (`claude --session-id … -p`) and
  later messages continue it. It shows up in the session list once started.
- **⧉** — copies the `claude --resume …` command to your clipboard instead of
  opening a window.

Pick **Terminal** or **iTerm** from the dropdown in the header.

## Wrap-up (housekeeping)

The **🧹 Wrap-up** button in the header opens an end-of-session triage across
every session's working directory. For each repo it runs `git status` and
ahead/behind and assigns a verdict:

- 🔴 **Busy** — a session there is still working; never wrap a busy one.
- 🟡 **Unsaved changes** — uncommitted work. **Commit** button (you set the
  message); commits locally, never auto-pushes.
- 🔵 **Unpushed commits** — committed but not pushed. **Push** button.
- 🟢 **Safe to close** — clean (or not a repo); nothing to do.

It's conservative on purpose: anything busy or dirty is flagged, not closed, so
no work-in-progress is lost. Git writes are limited to directories that belong
to a known session.

### The wrap command

**▶ Wrap up safe-candidate folders** runs the full flow across every non-busy
folder:

1. **Enquire** — asks the session itself, headlessly, *"is it safe to wrap?"*
   (`POST /api/assess`) and gets back `{safe, reason, commitMessage}`.
2. **Save** — if the verdict is safe and the repo is dirty, commits (using the
   session's suggested message) and pushes when there's a remote.
3. **Gracefully exit** — SIGTERMs the live Claude process(es) for that folder
   (the transcript is already on disk, so the session stays resumable).
4. **Leave WIP open** — anything the session flags as work-in-progress (or any
   busy folder) is reported and left completely untouched.

Per-folder buttons do the same steps individually: **Enquire (AI)**,
**Commit**, **Push**, **Close terminals**. Closing asks for confirmation.

## Chat with a session from the browser

Click any session row to open a conversation panel that **live-tails the
transcript** and lets you **chat with that session without leaving the browser**.

When you send a message, the server runs `claude --resume <id> -p "<text>"` in
the session's working directory. That continues the *same* session — it keeps
the full context and appends to the same transcript file — and the reply shows
up in the panel as it's written. No terminal involved.

Replies render as **Markdown** (code blocks, lists, inline code, links).

### Pasting images

Paste an image into the composer (⌘V), drag-drop a file, or click 📎. Thumbnails
appear above the box; send and they're written to `~/.claude/claudenav-uploads/`
and referenced in the prompt by path, so Claude reads them with its Read tool.
Attached images render inline in the transcript.

- Works for **any** session, live or not.
- A "⏳ Claude is working…" indicator shows while a turn runs, with a queued
  count if you've lined up more.
- **Send as many as you like** — turns for one session run one-at-a-time in the
  order you sent them, so the transcript never gets two browser writers at once.
- A hung turn is stopped after a timeout (`CLAUDE_TURN_TIMEOUT_MS`, default 15
  min) and in-flight turns are killed when the server stops.

### Using the browser and a terminal together

This is safe. Each browser turn re-reads the session from disk before
continuing, so it always picks up anything you typed in the terminal. Partial
lines from a concurrent write are skipped and re-read on the next poll. The one
thing the browser can't do is update the terminal's *in-memory* view — the
terminal won't show turns you ran from the browser until you reopen the session
there. The panel notes when a session is also open in a terminal.

> **Permissions:** turns run with `--dangerously-skip-permissions` so the
> assistant can actually use tools, matching how these sessions were started.
> Set `CLAUDE_SAFE=1` to drop that flag. Set `CLAUDE_BIN` if `claude` isn't on
> the server's PATH.

## How it works

Each session is a `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` file.
The server parses each file for the `ai-title`, `last-prompt`, `cwd`,
`gitBranch`, and timestamps, caches results by file mtime, and detects live
terminals with `ps` + `lsof`. The page auto-refreshes every 5 seconds.

## Notes / limitations

- Live detection maps a running `claude` process to its working directory. When
  several terminals share one directory, ClaudeNav marks the *N* most recently
  active sessions in that directory as live (where *N* = number of live
  terminals there) — it can't always pin a process to one exact session.
- Opening terminals uses AppleScript, so it's macOS-only. Other platforms still
  get the full read-only dashboard and the copy-command button.
