# CLAUDE.md

Guidance for working in this repo.

## What this is

ClaudeNav — a local, dependency-free web app to navigate your Claude Code
sessions. Reads `~/.claude/projects/**/*.jsonl`, groups sessions by project,
shows live status, and lets you chat with / wrap up sessions from the browser.

## Layout

- `server.js` — the whole backend. Node, no dependencies, binds `127.0.0.1:4317`.
  Parses session transcripts (mtime-cached), detects live terminals via
  `ps`+`lsof`, and exposes the API below.
- `public/index.html` — the entire frontend (HTML + CSS + JS in one file,
  including a small hand-rolled Markdown renderer).
- No build step. Node 18+. Terminal-opening features are macOS-only (AppleScript).

## Run

```bash
node server.js          # http://127.0.0.1:4317
PORT=5000 node server.js
```

For day-to-day use, run it as a **LaunchAgent** so it survives logout, restarts
on crash, and runs at login:

```bash
./install-launchagent.sh            # generates the plist from THIS machine's paths, loads it
./install-launchagent.sh uninstall  # stop + remove
```

This is the canonical run method. It wraps `run-server.sh` (crash-restart loop
with a 3-crashes-in-60s cap; appends timestamped start/exit lines to
`/tmp/claudenav.log`) and pins `PATH` + `CLAUDE_BIN` so headless turns work
under launchd's minimal environment.

The installer also loads a second LaunchAgent (`com.claudenav.watchdog`) that
runs `watchdog.sh` every 60s (`CLAUDENAV_WATCHDOG_INTERVAL` to change). It pings
`/api/version`; if the server is unreachable it `launchctl kickstart -k`s the
main agent. This covers the two cases `KeepAlive` can't: a **hung** server
(process alive, not serving) and a **crash-cap give-up** (`run-server.sh` exits
0, so launchd won't relaunch). A healthy check is a silent no-op; a restart logs
to `/tmp/claudenav.log`. `uninstall` removes both agents.

> **Do NOT rely on `nohup … & disown` when launched from inside a tool wrapper.**
> Processes spawned by a tool call (incl. via `nohup`/`disown`/`setsid`) get
> SIGTERM'd after ~90s — the server's shutdown handler then exits 0, so it looks
> like a clean stop, not a crash. Only a launcher that owns the process
> independently (launchd) escapes this. A normal terminal run is fine.

## API

- `GET /api/sessions` — projects + sessions (status, tokens, live flags).
- `GET /api/transcript?session=<id>&after=<n>` — conversation messages.
- `POST /api/chat {session, text, images, cwd}` — run a headless turn
  (`--resume`, or `--session-id` to create a new one), via
  `--output-format stream-json --verbose` so blocks can be previewed live.
  Queued one-at-a-time per session; `cwd` is only used when creating.
- `GET /api/chat-status?session=<id>` — `{running, queued, error, partial}`.
  `partial` is the in-flight assistant output (`{text, tools}`, block-level —
  the CLI doesn't stream tokens) or `null`.
- `POST /api/chat-cancel {session}` — SIGTERM the running turn (marked so it
  isn't logged as an error) and drop anything queued behind it.
- `POST /api/session-mode {session, mode}` — pin the permission mode the next
  headless turn runs under (`default`/`plan`/`acceptEdits`/`auto`/
  `bypassPermissions`/`dontAsk`). Persisted to `~/.claude/claudenav-modes.json`.
  Each session in `/api/sessions` carries `permissionMode` (the mode of its last
  recorded turn), `modeOverride` (the pinned value, or null), and `mode` (the
  effective mode = override ?? last transcript mode ?? `bypassPermissions`).
- `POST /api/commit {cwd, message}` / `POST /api/push {cwd}` — git, restricted
  to known-session directories.
- `POST /api/archive {session, archived}` — tuck a session away (or restore it
  with `archived:false`). Hidden from the default list regardless of
  recency/status, but stays searchable and resumable. Persisted to
  `~/.claude/claudenav-archived.json` (a flat array of session IDs); each session
  in `/api/sessions` carries an `archived` boolean. The UI's "Show archived"
  toggle reveals them so you can unarchive.
- `GET /api/browse?path=<dir>` — list a folder's immediate sub-directories
  (dotfiles hidden) plus `{path, parent, home, isRepo}`. Bounded to `$HOME`
  (escapes via `..`/symlink return 403). Powers the **+ New project** folder
  picker; defaults to `$HOME` when `path` is empty.
- `POST /api/mkdir {parent, name}` — create a folder under `parent` (single path
  segment, `$HOME`-bounded). Used by the picker's "+ New folder".
- `POST /api/git-init {cwd}` — `git init` a folder (idempotent; `$HOME`-bounded),
  so a brand-new project gets commit/push/wrap-up from day one. New projects
  start as a plain session in the chosen folder (no worktree — there's no HEAD
  to branch from yet); the per-project "+ New session" worktree flow stays for
  established repos.
- `GET /api/housekeeping` — per-repo wrap verdict (busy/dirty/unpushed/clean).
- `POST /api/assess {session}` — AI "is it safe to wrap?" (adds a turn).
- `POST /api/handover {session}` — for a context-heavy session: have it write a
  handoff brief (one added turn), then seed a brand-new session with it and return
  `{newSession, brief}`. Carries the thread forward with clean context (unlike the
  blank "+ New session"). Compaction in place is just `/compact` sent via `/api/chat`.
- `POST /api/close {session}` — SIGTERM the live `claude` process(es) in the
  session's cwd (graceful; transcript persists, resumable).
- `POST /api/open` — open Terminal/iTerm (resume or new). `/uploads/<name>` —
  serves pasted images.
- `GET /api/version` — `{bootId, bootHead, head, branch, dirty, behind, hasRemote,
  canUpdate}`. `bootId`/`bootHead` describe the running process; `head`/`behind`
  reflect on-disk + upstream (background `git fetch`, ≤ every 5 min). Also attached
  to `/api/sessions` as `version`, so the 5s poll surfaces updates for free.
- `GET /api/usage` — usage limits mirroring Claude Code's `/usage` menu
  (`{session, weeklyAll, weeklyScoped}`, each `{label, percent, severity,
  resets_at}`). Proxies the same source the CLI uses — `GET
  https://api.anthropic.com/api/oauth/usage` with the stored OAuth access token
  (`~/.claude/.credentials.json`, else the macOS Keychain
  `Claude Code-credentials`) — background-refreshed (≤ every 60s). Also attached
  to `/api/sessions` as `usage`, so the 5s poll keeps the header bars current.
- `POST /api/update {pull}` — `git pull --ff-only` (when `pull`) then relaunch via
  `process.exit(42)`; `run-server.sh` treats 42 as an intentional restart (no
  crash-cap hit). Powers the header "Update & relaunch" button.

## Conventions / gotchas

- Headless turns default to the `bypassPermissions` mode, spawned with
  `--dangerously-skip-permissions` (set `CLAUDE_SAFE=1` to drop it — bypass then
  degrades to `--permission-mode default`). Any other per-session mode (see
  `/api/session-mode`) is passed through as `--permission-mode <mode>`; `plan`
  is read-only (Claude proposes a plan without making changes). `CLAUDE_BIN`
  overrides the `claude` path.
- **Finding `claude`**: `resolveClaudeBin()` honors `CLAUDE_BIN`, else trusts
  `command -v claude`, else probes known install dirs (`~/.local/bin`,
  `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`). This is
  why headless turns work under launchd even though `claude` is off its minimal
  PATH. If none resolve, it logs a WARNING at startup and turns fail with
  `spawn claude ENOENT` — set `CLAUDE_BIN` to fix. The startup log prints the
  resolved path (`[claudenav] using claude binary: …`).
- The Markdown renderer uses **space-delimited** placeholders (` CB0 `, ` IMG… `);
  an earlier edit corrupted these to null bytes and made the file read as binary —
  keep them spaces.
- Tests should use throwaway sessions in `/tmp/<dir>` and clean up the matching
  `~/.claude/projects/-private-tmp-<dir>` afterwards. Don't create/kill real
  sessions when testing.
- `pkill -f "server.js"` is too broad (matches any `server.js`, e.g. editor
  helpers). Target the port or exact path instead.
- **Headless `AskUserQuestion`**: a `-p` turn can't pause for input — the tool
  returns `is_error: "Answer questions?"` and the model barrels ahead on an
  assumption. So `ingestStreamLine` SIGTERMs the turn the instant an
  `AskUserQuestion` tool_use streams in (`pauseForQuestion`). Claude Code still
  flushes the auto-dismiss tool_result before exiting, so the transcript holds a
  clean tool_use+tool_result pair (no dangling tool → resume is clean) and the
  question is its terminal block. The UI renders the clickable card from the
  transcript only (not the live partial — that raced the poll); a click resumes
  the session with `"<question>"="<answer>"`. Verified end-to-end: resume after a
  mid-question kill returns rc=0 and Claude acts on the pick.

## Outstanding / TODO

- [ ] **Headless Resume**: `Resume ▸` still opens a Terminal. Clicking a row
      opens the in-browser chat, but there's no explicit headless-resume button.
- [ ] **Screenshot**: `README.md` references `docs/screenshot.png`, which does
      not exist — add it or drop the reference.
- [ ] **`/api/close` untested live**: the graceful-exit path is implemented but
      never exercised against a real session. Also it kills *all* `claude`
      processes in a folder (fine for safe, non-busy folders; confirm in UI).
- [ ] **Per-row AI deep-check**: `assess` is wired into the wrap panel per
      folder; add an explicit per-session "is this mid-task?" button if wanted.
- [x] **Chat optimistic echo**: sent messages render immediately (`.optimistic`
      bubble) and are retracted once the transcript poll confirms them.
- [x] **Streaming + stop**: turns run with `stream-json`; assistant blocks are
      previewed live via `chat-status.partial`, and a Stop button cancels the
      running turn + queue (`/api/chat-cancel`). Note: block-level only — the
      CLI's `stream-json` doesn't emit token deltas, so a single text block
      still appears all at once when it completes.
- [ ] **Bulk commit**: wrap has per-folder commit/push and a "wrap all safe"
      orchestrator, but no standalone "commit all unsaved".
- [ ] **Cross-platform**: terminal-opening is macOS/AppleScript only; other
      platforms get the read-only dashboard + headless chat.
- [ ] **LICENSE holder** is "JB"; adjust if it should be the org.
