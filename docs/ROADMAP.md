# ClaudeNav roadmap

Prioritized plan from the September 2026 review. Each item is sized for one
session in its own worktree. Order matters: 1 is done, 2 unblocks 3, 3 makes
everything after it cheaper.

## 1. CSRF guard — done

`csrfReject` in `server.js`: loopback `Host`, same-origin `Origin` /
`Sec-Fetch-Site`, `X-ClaudeNav` header on every non-GET, preflight answered
without CORS. The UI adds the header through a `window.fetch` wrapper so no
call site can forget it. See the CLAUDE.md gotcha.

## 2. Tests — done

`npm test` → `node --test`, 34 tests in `test/`, CI in `.github/workflows/test.yml`.
Writing the worktree test found and fixed a real bug (collapsed `?? .claude/`
status line defeating the worktree filter). Original plan kept below for the
parts still open (pre-commit hook).

### Original plan

Zero tests today for a tool that pushes code to the internet. Use `node --test`
(Node 18+, no dependencies), `npm test` runs `node --test test/`.

Order of work:

1. **Make the pure functions importable.** `server.js` runs `server.listen` at
   load, so it can't be `require`d. Guard the listen with
   `if (require.main === module)` and export the pure helpers. No behavior
   change. (Full module split is item 3; this is the minimum.)
2. **Regression tests for the three bugs the gotchas describe**, with fixture
   transcripts under `test/fixtures/` and any temp files in `/tmp`:
   - `errorSignalText` / `AUTH_ERR_RE` / `USAGE_ERR_RE`: a transcript that
     *discusses* "usage limit reached" and "/login" in assistant text, tool
     results, and a successful `result` echo must produce **no** error; an
     error `result` with `is_error:true` and stderr text must.
   - Markdown renderer: a document with three code blocks and two images
     round-trips with no `\0` and no leaked ` CB0 ` placeholders. (Renderer is
     inline in `index.html`, so first move it to `public/markdown.js` and load
     it with a `<script src>`; same for the test.)
   - `siteStatus` git half: a `/tmp` repo with a `.claude/worktrees/x` untracked
     dir reads as clean; a real untracked file reads as `draft`.
3. **Parser tests** for `parseSessionFile`: full parse equals incremental parse
   after appending; truncated last line is tolerated; `AskUserQuestion`
   tool_use + tool_result pair is detected as the terminal block.
4. **HTTP tests** for `csrfReject` (the curl matrix from the guard session:
   evil Host, cross-site Origin, `Origin: null`, missing header, OPTIONS has no
   CORS headers) and for the `$HOME` bounding of `browse` / `mkdir` / `publish`.
5. Wire `npm test` into a pre-commit hook or a GitHub Action (the repo is
   public, so Actions are free).

## 3. Split the two big files — done

`lib/` (13 modules, no cycles) + `public/app.css` / `app.js` / `markdown.js`.
See CLAUDE.md → Layout. Original plan:

Keep zero dependencies and no build step; "one file" was never the goal.

`server.js` (3.2k lines) →
- `lib/transcripts.js` — `parseSessionFile`, incremental cache, session/project
  grouping.
- `lib/turns.js` — spawn/detach/tail/reconcile, queue persistence, error
  classification (`errorSignalText`, auth/usage regexes).
- `lib/git.js` — `git()` helpers, worktrees, `excludeWorktrees`, publish,
  fast-forward sync.
- `lib/sites.js` — gh wrapper, Pages, `siteStatus`, `pagesCache`.
- `lib/live.js` — `ps`/`lsof` liveness cache, terminal opening per platform.
- `lib/state.js` — see item 6 (one state file).
- `server.js` — routes only, plus `csrfReject`, static serving, boot.

`public/index.html` (3.1k lines) → `index.html` (markup) + `app.css` +
`app.js` + `markdown.js`. `serveStatic` already handles `.js`/`.css` with
`no-store`, so nothing else changes.

Do this in several small commits (one module at a time, `node --check` + tests
green after each) so worktree merges stay conflict-free.

## 4. Repo hygiene — mostly done

`github-history/` extracted (with history) to `~/Docs/github-history` (push it to
GitHub yourself when ready). `package.json` is 1.1.0 and `/api/version` reports
it; tag `v1.1.0` on main after merging. LICENSE holder still your call.

Original plan:

- Move `github-history/` to its own repo. It shares nothing with ClaudeNav and
  the `bin`/`npm start` entry doesn't know about it.
- Bump `package.json` version and tag releases (`v1.1.0` for the CSRF guard).
  `/api/version` could then report the tag, and the desktop app can say "app
  is older than server".
- Decide the LICENSE holder.

## 5. Product

Roughly in order of value:

- **Search inside transcripts.** The search box matches title, first prompt,
  path, branch. Add message text: `parseSessionFile` already holds the
  messages, so build a lowercase blob per session lazily (first search only)
  and cache it with the parse. Show a match snippet in the row.
- **Headless Resume button.** Oldest open TODO. Clicking a row already opens
  chat; add an explicit affordance next to `Resume ▸` and make the terminal
  version the secondary action.
- **Native notifications.** Turn finished, `AskUserQuestion` waiting, turn
  interrupted by a restart. Web `Notification` API works in the Tauri webview
  with a permission prompt; poll already knows the transitions.
- **"While you were away" panel.** Sessions whose status changed since the
  last visible poll (turn done, error, interrupted, question pending). One
  list at the top, dismissable.
- **Cost per session/project.** Tokens are shown; `/api/models` could carry
  per-model prices (hand-maintained table with a "last checked" date) and the
  row shows an approximate spend.

## 6. Robustness

- **One state file.** `claudenav-modes.json`, `-models.json`, `-archived.json`,
  `-sites.json`, plus the per-port runs/queue files, become one
  `claudenav-state-<PORT>.json` written with write-to-temp + `rename` so a
  crash mid-write can't truncate it. Migrate on first boot, leave the old
  files in place for one release.
- **Exercise `/api/close`** against a throwaway session in `/tmp` and have the
  UI list the pids it will signal before confirming.
- **Request log.** Log method, path, status, and ms for every request over
  ~200ms (tunable, `CLAUDENAV_SLOW_MS`). This is the tool that would have
  shortened the watchdog investigation.
- **Bulk "commit all unsaved"** in the wrap panel (reuses `/api/commit` per
  repo; skips busy repos exactly as "wrap all safe" does).
