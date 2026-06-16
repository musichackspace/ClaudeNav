# GitHub History

A local, zero-dependency visualizer for the commit history of any **public** GitHub repository.

Enter `owner/name` (or paste a `github.com` URL) and see, in one page:

- **Repo overview** — stars, forks, watchers, open issues, primary language, license, created / last-push dates, topics.
- **Commits per week** — a 52-week bar chart of commit volume.
- **Top contributors** — ranked by total commits, with avatars.
- **Languages** — byte-share breakdown across the codebase.
- **When commits happen** — a weekday × hour punch-card heatmap.
- **Recent commits** — the latest commits on the default branch, linked to GitHub.

All charts are hand-rolled SVG/HTML — no chart libraries, no build step, no `npm install`.

## Run

```sh
node server.js
# → http://127.0.0.1:4318
```

Set a different port with `PORT=5000 node server.js`.

## Rate limits

Unauthenticated, the GitHub API allows **60 requests/hour**. Each repo view uses
~6 calls. To raise the limit to **5000/hour**, export a token (a classic token
with no scopes, or a fine-grained read-only token, is enough):

```sh
export GITHUB_TOKEN=ghp_xxx
node server.js
```

The token stays server-side — the browser never sees it.

## How it works

`server.js` is a small Node `http` server bound to `127.0.0.1`. It proxies the
GitHub REST API (avoiding browser CORS and keeping the token private), caches
responses for 5 minutes, and serves the static page from `public/`. The
`stats/*` endpoints can return `202` while GitHub computes them, so the server
polls briefly before giving up gracefully.

Deep links work: `http://127.0.0.1:4318/#facebook/react` auto-loads that repo.
