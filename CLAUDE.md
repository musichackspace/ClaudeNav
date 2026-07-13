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
0, so launchd won't relaunch). It also auto-applies **stale code**: when the
reply shows `head != bootHead` (a new commit on disk that the running process
predates), it POSTs `/api/update {pull:false}` — the server's graceful exit-42
relaunch — so committing is enough to deploy; no UI click needed. A healthy
check is a silent no-op; a restart logs to `/tmp/claudenav.log`. `uninstall`
removes both agents.

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
  Queued one-at-a-time per session; `cwd` is only used when creating. The
  `images` array (legacy name) holds attachments as `{data, name}` — `data` is a
  base64 data URL, `name` the original filename. Type is decided by the filename
  extension (browser MIME is unreliable for source/Office files), giving four
  kinds: **images** (png/jpeg/gif/webp), **PDFs**, **text/source** (txt, md,
  csv, json, and code — py/js/ts/go/… , see `TEXT_EXTS`), and **Office docs**
  (docx/xlsx/pptx). Each is saved to `~/.claude/claudenav-uploads` as
  `<ts>-<rand>-<sanitized name>` and referenced by path in the prompt
  (`[Attached image|PDF|file: …]`) for the CLI's Read tool. Conversions happen
  server-side at save time: **HEIC/HEIF → JPEG** via `sips`; **Office → text**
  (docx via `textutil`; xlsx/pptx by pulling text nodes from the OOXML zip with
  `unzip -p` — best-effort, layout/formulas dropped). Both need the macOS
  built-ins; extraction failures fall back to a placeholder note. Unsupported
  types are rejected client-side with a warning toast.
- `GET /api/chat-status?session=<id>` — `{running, queued, error, needsLogin,
  usageLimited, needsSetup, partial}`. `partial` is the in-flight assistant output
  (`{text, tools}`, block-level — the CLI doesn't stream tokens) or `null`.
  `needsLogin` is true on an auth failure; the UI then adds a "Re-login" button
  to the error toast (opens a terminal via `/api/open {login:true}`).
  `usageLimited` is true when the turn hit a usage/rate limit; the UI shows the
  server's plain-language `error` (which names the reset time when known, and
  suggests switching to a lighter model) without the scary "Turn error:" prefix.
  `needsSetup` is true when the turn couldn't spawn the `claude` binary (ENOENT /
  EINVAL — mostly a Windows/PATH problem); the UI swaps the cryptic
  "spawn claude ENOENT" for the server's plain message plus a **"Fix setup"**
  button that opens a help dialog fed by `/api/setup-help`.
- `GET /api/setup-help` — `{platform, resolved, claudeBin, message, docs,
  steps:[{text, cmd?}]}`: platform-aware guidance for locating/pointing at the
  `claude` binary (Windows uses `where`/`setx CLAUDE_BIN`, Unix uses
  `command -v`/env var). `resolved` is false when the server fell through to a
  bare `claude` guess at startup. Drives the "Fix setup" dialog.
- `POST /api/chat-cancel {session}` — SIGTERM the running turn (marked so it
  isn't logged as an error) and drop anything queued behind it.
- `POST /api/session-mode {session, mode}` — pin the permission mode the next
  headless turn runs under (`default`/`plan`/`acceptEdits`/`auto`/
  `bypassPermissions`/`dontAsk`). Persisted to `~/.claude/claudenav-modes.json`.
  Each session in `/api/sessions` carries `permissionMode` (the mode of its last
  recorded turn), `modeOverride` (the pinned value, or null), and `mode` (the
  effective mode = override ?? last transcript mode ?? `bypassPermissions`).
- `POST /api/session-model {session, model}` — pin the model the next headless
  turn runs under. The value is an exact model id — `default` (clears the
  override → inherit the CLI/account default) or any id from `/api/models`
  (e.g. `claude-opus-4-8`) — passed to the CLI as `--model <id>`. Validated by
  format only (the live list is authoritative; the CLI rejects a bogus id).
  Persisted to `~/.claude/claudenav-models.json`. Each session in
  `/api/sessions` carries `modelOverride` (the pinned id, or null) and `model`
  (the effective choice = override ?? canonical id of the last-used transcript
  model ?? `default`).
- `GET /api/models` — the pickable model list (`{models:[{id,label},…], source,
  error, at}`, `models[0]` is always `{id:'default'}`). Fetched from the
  Anthropic Models API (`GET /v1/models`) using the stored OAuth token — same
  source as `/api/usage` — and **background-refreshed once a day** (retries
  ≤ every 30 min after a failure), so new releases appear and retired models
  drop without a code change. Keeps the last good list (seeded from a built-in
  fallback) when the API is unreachable; `source` is `api` or `default`. Also
  attached to `/api/sessions` as `models`, so the 5s poll keeps the picker
  current.
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
- `GET /api/gh-status` — `{installed, authed, user, platform}` for the **website
  wizard** (the guided "+ New project" path for non-devs). Uses the `gh` CLI as
  the engine — `resolveGhBin()` mirrors `resolveClaudeBin()` and is
  cross-platform: `GH_BIN`, then `where gh` (Windows) / `command -v gh` (POSIX),
  then known dirs — including Windows install locations (`%ProgramFiles%\GitHub
  CLI\gh.exe`, winget Links, scoop shims, choco). `installed` is false if `gh` is
  missing; `authed`/`user` come from `gh api user`. `platform` (`process.platform`)
  lets the wizard word install/sign-in hints per-OS (winget one-liner + "new
  terminal window" on Windows).
- `POST /api/site-create {name, parent?}` — provision a website end-to-end:
  make a `$HOME`-bounded folder (slug of `name`, defaults under `$HOME`), write
  a starter `index.html`/`README.md`, `git init` + first commit, `gh repo create
  <slug> --source <cwd> --public --push`, then enable **GitHub Pages** (main /
  root) via `gh api`. Returns `{cwd, slug, owner, repoUrl, pagesUrl}`. Pages
  enabling is best-effort (propagation lag / already-enabled are non-fatal; the
  `github.io` URL is deterministic). "Publish" for these sites is just the
  existing commit + push — Pages redeploys on every push to main. Signing in is
  interactive: `POST /api/open {ghLogin:true}` opens a terminal running
  `gh auth login` (same pattern as the Claude `/login` re-auth).
- `GET /api/gh-repos` — `{owner, repos:[{name, nameWithOwner, description,
  visibility, url, pushedAt, isFork}]}`, newest activity first — the picker for
  the wizard's **"edit a site I already have"** path. Lists every repo the user
  can *access* via `gh api user/repos?affiliation=owner,collaborator,organization_member`
  (`--paginate`), **not** `gh repo list` (which only returns the personal
  account's own repos and silently hides org/collaborator repos). Archived repos
  filtered out; the row shows the owner prefix when it isn't your own account.
- `POST /api/site-import {repo, parent?}` — `gh repo clone` an existing repo
  (`owner/name`) into a `$HOME`-bounded `<name>` folder, so it can be maintained
  + published from ClaudeNav. If that folder already IS this repo (same origin),
  reuses it (`reused:true`) instead of erroring; a *different* folder of the same
  name is refused. Returns `{cwd, slug, owner, repoUrl, pagesUrl, pagesEnabled}`
  — `pagesInfo()` reads `GET repos/{nwo}/pages` (404 → `pagesEnabled:false`; the
  live `html_url` is authoritative when on, handling custom domains / user-root
  sites; else a deterministic `github.io` fallback).
- `POST /api/site-enable-pages {repo}` — turn on Pages (default branch / root)
  for an imported site that isn't publishing yet; idempotent (already-enabled
  returns its URL). Returns `{pagesEnabled, pagesUrl}`.
- `GET /api/site-status?cwd=<dir>` — **"is what I made live?"** for a website.
  `siteStatus()` derives one plain-language `state` (+ `label`, `detail`) from
  git + Pages: `draft` (uncommitted or unpushed changes), `publishing` (pushed,
  Pages still building or built an older commit), `live` (pushed commit is built
  and serving), `failed` (build errored), `offline` (has a GitHub remote but
  Pages off), `local` (no remote), `repo` (GitHub remote but *not* a website —
  see `isSite`), `nonrepo`/`unknown`. `isSite` = Pages already enabled **or** the
  folder is in the wizard's sites registry (`~/.claude/claudenav-sites.json`,
  written by `site-create`/`site-import`); a non-site repo returns `repo` and the
  UI shows no pill, so ordinary code projects (ClaudeNav itself) don't get a
  misleading "Not online". The honest rule for
  `live`: working tree clean **and** the pushed commit (`@{u}`) equals the commit
  GitHub Pages last built (`GET repos/{nwo}/pages/builds/latest`) **and** that
  build succeeded. The networked (Pages) half is cached per-repo ~30s
  (`pagesCache`, invalidated on publish) so the UI can poll cheaply; the git half
  is recomputed each call. Also returns `dirty, changeCount, ahead, nwo,
  pagesEnabled, pagesUrl, buildStatus`. Drives the chat-header **Publish bar**
  and the compact per-row **pill** (both reuse the `.vbadge` colour palette).
- `POST /api/publish {cwd, message?}` — the one-button ship-it: `git add -A` +
  commit (only if dirty) + push (`-u origin <branch>` on the first push).
  `$HOME`-bounded + must be a git repo with a GitHub remote. Invalidates the
  Pages cache and returns the fresh `siteStatus()` so the pill flips to
  `publishing` at once (then to `live` on the next poll once Pages rebuilds).
  For Pages sites, push *is* deploy — no separate deploy step.
- `GET /api/housekeeping` — per-repo wrap verdict (busy/dirty/unpushed/clean).
- `POST /api/assess {session}` — AI "is it safe to wrap?" (adds a turn).
- `POST /api/handover {session}` — for a context-heavy session: have it write a
  handoff brief (one added turn), then seed a brand-new session with it and return
  `{newSession, brief}`. Carries the thread forward with clean context (unlike the
  blank "+ New session"). Compaction in place is just `/compact` sent via `/api/chat`.
- `POST /api/close {session}` — SIGTERM the live `claude` process(es) in the
  session's cwd (graceful; transcript persists, resumable).
- `POST /api/open` — open Terminal/iTerm (resume or new). With `{login:true}`
  it instead opens the terminal running `claude /login` (from `$HOME`, no cwd
  needed) — the re-auth path for expired OAuth credentials, which is
  interactive-only and can't be run headlessly. `{ghLogin:true}` is the same for
  `gh auth login` (GitHub-account onboarding for the website wizard).
  **Cross-platform**: macOS uses AppleScript (`osascript`), Windows opens a new
  console window (`cmd /c start … cmd /k <cmd>` — the login flows run the bare
  `gh`/`claude` binary via the fresh shell's PATH, and session-resume sets the
  window cwd via the spawn option, so nothing needs quoting or is injectable),
  and Linux tries the common emulators in order (`x-terminal-emulator`,
  `gnome-terminal`, `konsole`, `xfce4-terminal`, `xterm`), running the same bash
  command with `; exec bash` to keep the window open. If none of those launch
  (or the platform is unknown) it returns an actionable error naming the command
  to run by hand. `/uploads/<name>` — serves pasted attachments (images and PDFs).
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
  PATH (`command -v claude` on Unix, `where claude` on Windows), else probes
  known install dirs — Unix: `~/.local/bin`, `~/.claude/local`,
  `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`; Windows: the native
  installer's `claude.exe` and the npm-global (`%APPDATA%\npm`) / `~/.local\bin`
  shims. This is why headless turns work under launchd even though `claude` is
  off its minimal PATH. On Windows it **prefers a `.exe`** because Node can't
  spawn a `.cmd`/`.ps1` shim directly (that throws ENOENT/EINVAL). If none
  resolve it sets `CLAUDE_BIN_OK=false`, logs a WARNING at startup, and turns
  fail — but that failure is now caught (`err.code` ENOENT/EINVAL → chat error
  kind `missing`, `needsSetup:true`) and shown as the "Fix setup" dialog rather
  than a bare `spawn claude ENOENT`. Set `CLAUDE_BIN` to fix. The startup log
  prints the resolved path (`[claudenav] using claude binary: …`, with
  `(NOT FOUND — set CLAUDE_BIN)` appended when unresolved).
- **Auth failures in headless turns**: an expired/revoked OAuth token surfaces
  as API 401 text (`AUTH_ERR_RE`), sometimes with exit 0 (the failure lands in
  an error `result`). `drainQueue` matches it and sets a "re-login via `/login`"
  chat error instead of a bare exit code; the auth message wins even when the
  CLI exits clean. Fix is user-side: `claude` → `/login` in a terminal, retry.
- **Usage/rate limits in headless turns**: hitting your token quota surfaces as
  a 429 / "usage limit reached" (`USAGE_ERR_RE`), often with exit 0 like auth.
  `drainQueue` sets a plain-language chat error via `usageErrorMessage` — with
  the reset time (parsed from the CLI's `…reached|<epoch>` form, else the
  soonest `resets_at` from the cached `/api/usage` bars) and a nudge to switch
  to a lighter model. Precedence in `finish()` is auth > usage > generic;
  surfaced as `usageLimited`/`needsLogin` on `/api/chat-status`.
- **Both checks match ONLY an error signal, never streamed content** (see
  `errorSignalText`): the sole stdout source is an **error `result`**'s own
  message (`type:"result"` + `is_error:true`, even on exit 0); the other is
  **stderr**. Assistant prose, `user` (tool_result) output, *successful* result
  echoes (whose `result` field just repeats the assistant's final text),
  `system` init lines, and stray non-JSON diagnostics are all ignored — they
  quote "usage limit reached"/"please run /login"/"429" constantly without being
  real failures (real transcripts show *every* historical match was discussion,
  zero were actual limits). This precision is the whole ballgame: earlier
  versions scanned the raw stream and cried wolf on any turn that merely
  *discussed* limits or auth.
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
- [ ] **Cross-platform**: terminal-opening works on macOS (AppleScript),
      Windows (`cmd /k` console), and Linux (first of x-terminal-emulator /
      gnome-terminal / konsole / xfce4-terminal / xterm that launches) — covers
      the `gh`/`claude` login onboarding and session-resume. A headless Linux box
      with no emulator (or an unknown platform) still gets the read-only
      dashboard + headless chat, with an actionable "run this yourself" error
      when it tries to open a terminal.
- [ ] **LICENSE holder** is "JB"; adjust if it should be the org.
