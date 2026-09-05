# CLAUDE.md

Guidance for working in this repo.

## What this is

ClaudeNav — a local, dependency-free web app to navigate your Claude Code
sessions. Reads `~/.claude/projects/**/*.jsonl`, groups sessions by project,
shows live status, and lets you chat with / wrap up sessions from the browser.

## Layout

- `auth-classify.js` — the terminal-auth-failure classifier, split out of
  `server.js` (and pure/dependency-free) so it can be unit-tested against real
  recorded CLI output without booting the server. See **AUTH_FAILED** below.
- `test/` — `node --test`, no dependencies. `npm test`.
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
npm test                # node --test, no dependencies
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
0, so launchd won't relaunch). Because a kickstart is destructive (it kills the
running process), the probe **retries before concluding the server is dead** —
`CLAUDENAV_WATCHDOG_RETRIES` (default 3) probes `CLAUDENAV_WATCHDOG_RETRY_GAP`s
apart (default 3), each with a `CLAUDENAV_WATCHDOG_MAXTIME`s timeout (default 8),
and it only restarts when *every* probe fails. This stops a transient
event-loop stall (a big transcript reparse, a slow `lsof`) from being mistaken
for a hang and triggering a needless restart — the original single-5s-probe
behavior was silently killing healthy-but-busy servers. It also auto-applies **stale code**: when the
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
  Queued one-at-a-time per session; `cwd` is only used when creating. **Turns
  are spawned detached** (own process group, `child.unref()`) with stdout/stderr
  redirected to per-turn log files under `~/.claude/claudenav-turns-<PORT>/`, and
  the live preview + auth/usage detection are driven by *tailing those files*
  (poll, `CLAUDENAV_TAIL_MS`, default 400) rather than reading a pipe. This is
  the terminal-grade-reliability change: a turn keeps running (and keeps writing
  its transcript + logs) across a server restart — watchdog kickstart, exit-42
  update, crash — instead of being SIGTERM'd with it. In-flight turns and the
  queue are persisted (`claudenav-runs-<PORT>.json` / `claudenav-queue-<PORT>.json`,
  keyed by port so a second instance can't collide) and rediscovered on the next
  boot (`reconcileOnBoot`): a turn whose pid is still alive is **reattached**
  (tail its logs, watch its pid for completion); one that died in the gap is
  finalized from its logs. The LaunchAgent sets `AbandonProcessGroup` so a
  `launchctl kickstart -k` doesn't reap the detached turns. The
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
  authFailed, usageLimited, needsSetup, interrupted, partial}`. `partial` is the in-flight
  assistant output (`{text, tools}`, block-level — the CLI doesn't stream tokens)
  or `null`. `interrupted` is true when a turn was cut short by a server restart
  (its pid was gone on the next boot before it produced a terminal `result`); the
  UI shows the server's gentle "progress was saved — send again to continue"
  message with no scary "Turn error:" prefix (same treatment as `usageLimited`).
  `authFailed` mirrors the app-wide `AUTH_FAILED` state, and `needsLogin` is
  true when either this session's last turn failed on auth **or** the app-wide
  state is failed — one dead login makes every session unusable, including ones
  that have never failed a turn themselves. The UI adds a "Log in" button to the
  error toast (opens a terminal via `/api/open {login:true}`) and raises the
  banner; see **AUTH_FAILED** under Conventions.
  `usageLimited` is true when the turn hit a usage/rate limit; the UI shows the
  server's plain-language `error` (which names the reset time when known, and
  suggests switching to a lighter model) without the scary "Turn error:" prefix.
  `needsSetup` is true when the turn couldn't spawn the `claude` binary (ENOENT /
  EINVAL — mostly a Windows/PATH problem); the UI swaps the cryptic
  "spawn claude ENOENT" for the server's plain message plus a **"Fix setup"**
  button that opens a help dialog fed by `/api/setup-help`.
- `GET /api/auth-status` — app-wide auth state: `{state, ok, reason, detail,
  message, expiresAt, sessionExpiresAt, credentialSource, envOverride, probe,
  checkedAt}`. `state` is `ok` / `AUTH_FAILED` / `unknown`. Cheap and cached
  (never spawns anything), so it's also attached to `/api/sessions` as `auth`
  and rides the 5s poll. See **AUTH_FAILED** under Conventions.
- `POST /api/auth-recheck {force}` — re-run the preflight. The UI calls it on
  launch, on window focus, and on wake from sleep; `force` escalates from the
  credentials check to an actual `claude -p` probe.
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
  commit (only if dirty) + push. `$HOME`-bounded + must be a git repo with a
  GitHub remote. Invalidates the Pages cache and returns the fresh `siteStatus()`
  so the pill flips to `publishing` at once (then to `live` on the next poll once
  Pages rebuilds). For Pages sites, push *is* deploy — no separate deploy step.
  **It pushes `HEAD` to the branch GitHub serves** (`publishBranch()`: the Pages
  source branch, else the default branch), not to the branch the session happens
  to be on. That's what makes a **session worktree** a first-class way to work on
  a website: a worktree sits on `session/<leaf>`, which Pages never builds, so the
  old "push the current branch" landed nothing live, left the pill stuck at
  `publishing…` forever, and — because `main` never moved — meant the *next* new
  session branched off pre-change code and had to redo/rebase the work. If the
  published branch moved since the session was created, publish **rebases onto it
  first** (a conflict aborts cleanly and returns an error naming the clashing
  files, work intact — nothing is force-pushed). After a successful push it
  fast-forwards the project's own checkout (`-uno`, ff-only, never a dirty or
  diverged tree) so plain sessions in the project folder are current too. A repo
  that isn't a site keeps the old push-my-own-branch behavior (`pushCurrentBranch`).
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
  crash-cap hit). Powers the header "Update & relaunch" button. **Deferred while
  a turn is in flight**: if any turn is running it stores the request
  (`pendingRelaunch`) and returns `{deferred:true}` instead of exiting; the
  relaunch (and the pull) fires from `maybeRelaunch()` once the server goes idle,
  so a deploy never interrupts active work. Since turns are detached and
  reattached on boot anyway, the wait is purely to avoid the brief blank-preview
  gap, not to protect the turn.

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
- **AUTH_FAILED — auth is app-wide state, not a per-session error.** When the
  CLI's OAuth session has expired and can't be refreshed, `claude -p` does *not*
  crash: it exits **0** and hands back
  `"Failed to authenticate: OAuth session expired and could not be refreshed"`
  as its result, having also written that string into the transcript as an
  `assistant` message. ClaudeNav used to render it as ordinary Claude prose, so
  a permanently dead session looked alive and you could keep sending turns
  forever — each failing identically in milliseconds — with no sign anything was
  wrong. Re-auth needs an interactive browser flow, so a headless spawn can
  never recover on its own. The fix has four parts, and they only work together:
  - **Classify structurally, never by scanning text** (`auth-classify.js`).
    Precision is the whole ballgame here for the same reason as the usage
    checks: assistant prose quotes "Failed to authenticate" / "please run
    /login" constantly (a session *about* this bug is full of them). So the
    classifier only trusts the CLI's own error carriers — an `is_error` result,
    a result whose `terminal_reason` is `api_error` (the exit-0 case), a
    **synthetic** assistant record (`message.model === '<synthetic>'`,
    `isApiErrorMessage: true`, or a top-level `error` string), and stderr.
    Within those, `error: "authentication_failed"` is decisive on its own;
    otherwise the text is matched as a **substring**, because the failure can
    arrive appended to real output rather than as the whole result. Verified
    against the full local transcript corpus: 12 461 lines, 39 of them prose
    quoting the phrases, **0 false positives**, all 11 genuine records caught.
  - **One app-wide state**, not per-session (`authState`): a dead login breaks
    every session, so entering `AUTH_FAILED` stops the running turn (the CLI
    would otherwise keep retrying a 401 it can never satisfy), drops every
    queued turn across *all* sessions, and raises one banner. `/api/chat`
    refuses with **409** while in the state — the UI disables the composer, but
    the API is the real gate, since a stale tab or direct POST would otherwise
    sail straight through. It clears itself: any turn that produces a clean
    result is live proof the login works.
  - **Preflight before the user types**, at boot and on wake/focus. The cheap
    half reads the stored credentials and is conclusive for the common case —
    note that an expired *access* token is fine (the CLI refreshes it); the
    terminal condition is a dead **refresh** token, which is exactly "could not
    be refreshed". Only when that's inconclusive (or `force`) does it spend a
    tiny `claude -p "ok" --max-turns 1` probe.
  - **The environment can shadow the Keychain.** `CLAUDE_CODE_OAUTH_TOKEN` /
    `ANTHROPIC_API_KEY` in the process environment override stored credentials
    and **survive re-login**, so the banner would never clear. This is the
    Finder/launchd case: the app inherits a minimal environment holding whatever
    was exported when the LaunchAgent was installed, not your login shell's. A
    token that doesn't match the stored one makes the credential check
    inconclusive (forcing a real probe), logs a startup WARNING, and is called
    out by name in the banner.
  - Test it against **`-p`**, not the interactive CLI: a headless run can fail
    auth while `claude` in the same directory succeeds.
- **Usage/rate limits in headless turns**: hitting your token quota surfaces as
  a 429 / "usage limit reached" (`USAGE_ERR_RE`), often with exit 0 like auth.
  `drainQueue` sets a plain-language chat error via `usageErrorMessage` — with
  the reset time (parsed from the CLI's `…reached|<epoch>` form, else the
  soonest `resets_at` from the cached `/api/usage` bars) and a nudge to switch
  to a lighter model. Precedence in `finish()` is auth > usage > generic;
  surfaced as `usageLimited`/`needsLogin` on `/api/chat-status`.
- **Neither check ever matches streamed content.** Usage uses `errorSignalText`
  (below); auth uses `auth-classify.js` (above), which is stricter still because
  it must also catch the exit-0 case that `errorSignalText` deliberately hides.
  For usage: the sole stdout source is an **error `result`**'s own
  message (`type:"result"` + `is_error:true`, even on exit 0); the other is
  **stderr**. Assistant prose, `user` (tool_result) output, *successful* result
  echoes (whose `result` field just repeats the assistant's final text),
  `system` init lines, and stray non-JSON diagnostics are all ignored — they
  quote "usage limit reached"/"please run /login"/"429" constantly without being
  real failures (real transcripts show *every* historical match was discussion,
  zero were actual limits). This precision is the whole ballgame: earlier
  versions scanned the raw stream and cried wolf on any turn that merely
  *discussed* limits or auth.
- **Session worktrees must be invisible to git.** They live at
  `<repo>/.claude/worktrees/<leaf>`, so in any repo that doesn't ignore `.claude/`
  (ClaudeNav's own does — every wizard-created website does *not*) they show up as
  an untracked change. That one stray `?? .claude/` entry made the project folder
  read as permanently `draft`, made `gitWorktreeMerge` refuse with "main checkout
  has uncommitted changes" on every such repo, silently skipped publish's
  fast-forward sync, and would have let a `git add -A` commit the whole worktrees
  tree (including sessions' files) into the live site. Three defenses, keep all
  three: `excludeWorktrees()` writes `.claude/worktrees/` to `.git/info/exclude`
  (local, never touches a file the user owns) on worktree-add / publish / merge;
  `siteStatus` filters such paths out of `status --porcelain`; and the
  "is the tree clean enough" guards use `--porcelain -uno` (untracked files don't
  block a fast-forward — git refuses on its own if one would be clobbered).
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
- **Event-loop discipline — the server is single-threaded, and a stall past the
  watchdog's probe budget gets it killed.** `/api/sessions` is polled every 5s,
  so its hot path must stay cheap: liveness (`ps` + one `lsof` per live `claude`)
  is cached ~4s (`liveTerminals`, `CLAUDENAV_LIVE_TTL_MS`), and `parseSessionFile`
  parses transcripts **incrementally** — it folds a growing file's newly-appended
  bytes into a cached accumulator (keyed by mtime+size+offset) instead of
  re-reading the whole thing every poll (a 13 MB transcript: ~29 ms full vs
  ~0.4 ms append). Keep new synchronous work off that path; if you must shell
  out or read big files per-request, cache it. This, plus the watchdog retries,
  is what stopped the "interrupted, no error message" restart loop.

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
