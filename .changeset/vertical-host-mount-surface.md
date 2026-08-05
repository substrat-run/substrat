---
"@substrat-run/vertical-host": minor
"create-substrat": minor
---

Add `@substrat-run/vertical-host` — the platform's `/internal/*` management contract
(provision, reconcile, introspection, the read-only SQL console, platform-request drain,
snapshot/delete/export/restore, bookmarks/rewind, configure) plus the guaranteed `{ error }`
response envelope, authored once and mounted with `mountPlatformSurface(app, deps)`.

Verticals no longer hand-copy these routes and a Hono `onError` into their own `worker.ts` —
copies that had already drifted (route sets disagreed; some workers shipped without the error
handler, so a failing `/internal/restore` reached the control plane as the runtime's bare
`Internal Server Error` with no diagnosis, issue #510). Meridian, Manyfold and the
`create-substrat` template now mount the shared surface; a repo-wide `hono` override pins a
single version so the mounted `Hono` app type matches its consumers.
