---
---

Both of the builder studio's file-READ routes — the local server and the hosted studio — are confined to the current project the same way its writes are, so `GET /api/file?path=.dev.vars` no longer serves a file from elsewhere in the checkout (#1225).
