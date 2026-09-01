---
'@substrat-run/vertical-host': minor
---

`mountPublicSurface` — a surface anybody's browser may call, from a page the vertical never
served. It mounts a route group that runs as one service principal the vertical names, with
no authenticated caller anywhere in the path, and answers CORS in middleware from an async
resolver read per request — including the preflight, which is the first place a live
embedding allowlist has to be true. An unlisted origin is refused before the handler, so
withholding `access-control-allow-origin` is not the only thing standing between a leaked
session token and a write.
