---
'@substrat-run/boundary-lint': minor
'@substrat-run/cli': minor
'@substrat-run/dashboard': patch
---

boundary-lint R10: a deployable vertical's worker must mount `invocationLog` as the first registration on its app, with a `routerSecret`. Without it the vertical writes no verified per-request stamp, and the dashboard's Logs (Lines, Requests, Patterns) stay empty for it, silently and through any number of redeploys. `substrat-boundary-lint` fails on it. `substrat push` reports it as a warning and still deploys. The dashboard's empty Logs state now names both causes: a version deployed before per-request logging, or a worker that doesn't mount the middleware.
