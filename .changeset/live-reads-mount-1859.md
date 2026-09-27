---
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/vertical-host': minor
---

`mountLiveReads(app, { live, subscriber })` in `@substrat-run/vertical-host` mounts a vertical's live-read route, `GET /api/live` (#1859). A request that is not a WebSocket upgrade gets `426` with `x-substrat-live: not-an-upgrade`. It refuses a handshake whose `Origin` is not the request's own origin with `403`, before the host is asked or `subscriber` is called. A handshake with no `Origin` goes through. On a host with no `liveReads` (the pure SQLite host) it answers `501` with `x-substrat-live: poll`. `subscriber` resolves the caller from the vertical's own session, and `null` is `401`. `path` moves the route. `LIVE_MODE_HEADER`, the `LiveRefusal` type and `isUpgradeRequest` are now exported from `@substrat-run/kernel`; `@substrat-run/adapter-cloudflare` takes them from there, and its own names and values are unchanged.
