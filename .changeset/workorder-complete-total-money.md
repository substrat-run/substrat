---
'@substrat-run/engine-workorder': patch
---

`workorder/complete` declares its `total` as the `Money` it has always returned.

The operation's declared output said `total: z.string()` while the handler
returned `{ amount, currency }` — the shape `completeWorkOrder` parses through
the engine seam and the shape `workorder.completed` carries. A vertical binding
the operation to a URL would have generated a client typed on a string and read
`[object Object]`. The declaration is now `money`, and a test parses a real
completion result through the declared schema so the two cannot part company
again.
