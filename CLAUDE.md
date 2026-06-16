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

Run it **detached** so it survives the tool wrapper: `nohup node server.js > /tmp/claudenav.log 2>&1 & disown`.
A foreground `run_in_background` wrapper does **not** keep the long-lived server
alive (caused stale duplicate instances during development).

## API

- `GET /api/sessions` — projects + sessions (status, tokens, live flags).
- `GET /api/transcript?session=<id>&after=<n>` — conversation messages.
- `POST /api/chat {session, text, images, cwd}` — run a headless turn
  (`--resume`, or `--session-id` to create a new one). Queued one-at-a-time
  per session; `cwd` is only used when creating.
- `GET /api/chat-status?session=<id>` — `{running, queued, error}`.
- `POST /api/commit {cwd, message}` / `POST /api/push {cwd}` — git, restricted
  to known-session directories.
- `GET /api/housekeeping` — per-repo wrap verdict (busy/dirty/unpushed/clean).
- `POST /api/assess {session}` — AI "is it safe to wrap?" (adds a turn).
- `POST /api/close {session}` — SIGTERM the live `claude` process(es) in the
  session's cwd (graceful; transcript persists, resumable).
- `POST /api/open` — open Terminal/iTerm (resume or new). `/uploads/<name>` —
  serves pasted images.

## Conventions / gotchas

- Headless turns run with `--dangerously-skip-permissions` (set `CLAUDE_SAFE=1`
  to drop). `CLAUDE_BIN` overrides the `claude` path.
- The Markdown renderer uses **space-delimited** placeholders (` CB0 `, ` IMG… `);
  an earlier edit corrupted these to null bytes and made the file read as binary —
  keep them spaces.
- Tests should use throwaway sessions in `/tmp/<dir>` and clean up the matching
  `~/.claude/projects/-private-tmp-<dir>` afterwards. Don't create/kill real
  sessions when testing.
- `pkill -f "server.js"` is too broad (matches any `server.js`, e.g. editor
  helpers). Target the port or exact path instead.

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
- [ ] **Chat optimistic echo**: the user's sent message only appears after the
      transcript poll (~1–2s); consider echoing it immediately.
- [ ] **Streaming + stop**: replies arrive in poll-sized chunks, not token by
      token; there's no cancel button for a running/queued turn.
- [ ] **Bulk commit**: wrap has per-folder commit/push and a "wrap all safe"
      orchestrator, but no standalone "commit all unsaved".
- [ ] **Cross-platform**: terminal-opening is macOS/AppleScript only; other
      platforms get the read-only dashboard + headless chat.
- [ ] **LICENSE holder** is "JB"; adjust if it should be the org.
