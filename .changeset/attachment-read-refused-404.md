---
'@substrat-run/vertical-host': patch
---

`serveAttachment`, and so `GET /api/attachments/:attachmentId`, answers a file the caller may not read with the 404 of an unknown id instead of a 403.
