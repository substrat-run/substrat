---
'@substrat-run/dashboard-web': patch
'@substrat-run/console': patch
---

Show the running build version in the dashboard and console.

Each SPA now stamps its own package.json version and the built commit SHA into the bundle
at build time (Vite `define`), rendered as a muted `v0.0.0 · <sha>` caption in the sidebar
footer — so you can tell at a glance which build a given surface is serving. The SHA comes
from `CF_PAGES_COMMIT_SHA`/`GITHUB_SHA` in CI, falling back to `git rev-parse` locally and
`dev` when neither is available; the stamp never fails a build.
