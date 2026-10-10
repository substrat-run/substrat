---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

An attachment refusal keeps its code on Cloudflare (part of #113). A refused `upload`, `list`, `open` or `remove`, whether on `host.attachments()`, `getConnectorAttachments()` or `getSystemAttachments()`, used to reach the caller as a bare `Error` carrying only its sentence. It now arrives as the `permission_denied` it is, with its `permission` extension and the same sentence, as it already did on `adapter-sqlite`. A vertical serving one of these refusals keeps its 403, now read from the code, and stops logging `vertical-host.untyped-refusal` for a throw it never made. One status moves to match `adapter-sqlite`: a connector's dispatch-time read of an attachment its delivery does not name answered 400, because its sentence names no permission. It now answers 403. And on a copy of a scope that a carry moved to another script and wiped, a stale upload or list of a vertical whose modules declare no migrations is refused as a `conflict` with the copy's own sentence, a 409 like an operation on the same copy, where it answered 400. (With migrations, the first call on such a copy fails closed re-applying them, unchanged.)

The ScopeDO answers these refusals through new `…Reply` methods. Its throwing methods stay for a coordinator from before this release during a deploy. `@substrat-run/contract-tests` adds `attachmentRefusalContractSuite`.
