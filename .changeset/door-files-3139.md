---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/vertical-host': minor
'create-substrat': minor
---

kernel: `ScopeAttachments.openStream(id, { range })` reads one byte range, and a blob store may read it as a slice (`getRangeStream`).
adapter-sqlite: the file store reads a byte range as a slice.
adapter-cloudflare: R2 reads a byte range as a slice.
vertical-host: `door.attachments(c)` is the signed-in person's files; `workerDoor({ attachments: true })` serves and removes a file at `/api/attachments/:attachmentId`, streamed and seekable; `serveAttachment` answers a file request the same way, and the link-share download now streams and answers ranges.
create-substrat: a generated app serves its files through the door.
