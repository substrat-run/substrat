---
'@substrat-run/control-plane-api': patch
---

Fix the in-place serve failing with "held no modules" on promote (#308). The WfP content
reader (`createWfpModulesFetcher`) read the bundle back from a version's archive script and
kept only parts where `value instanceof File`, with no `else`. But Cloudflare's `GET /content`
is not an echo of the upload: a multipart module part whose `Content-Disposition` carries no
`filename=` is exposed by the web-standard `FormData` parser (workerd and undici alike) as a
**string**, not a `File`. Every such part was silently dropped, `modules` came back empty, and
promote failed the in-place serve — the version was admitted but never served, leaving scopes
pinned to the previous code.

The reader now accepts both shapes: a string part becomes a module (`TextEncoder`-encoded),
a `metadata` part (if present) is skipped, and the "held no modules" error reports the
content-type and received part names so a future read-back that yields nothing is diagnosable
from one log line. Regression test added with a hand-built multipart body that omits
`filename=` — the shape the prior fixture, which passed filenames explicitly, could never
reproduce. Introduced by the in-place deploy path (#286 / #287).
