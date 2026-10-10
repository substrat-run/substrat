---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

An attachment refusal keeps its code on Cloudflare (part of #113). The attachment verbs used to throw a refusal raised inside the scope's Durable Object across the RPC hop, which kept only the sentence. Those verbs are `upload`, `list`, `open` and `remove` on `host.attachments()` and `getConnectorAttachments()`, plus `open` on `getSystemAttachments()`. The ScopeDO now answers that refusal as data through new `…Reply` methods (`attachmentAddReply`, `attachmentListReply`, `attachmentAuthorizeReply`, `attachmentRemoveReply`, `systemAttachmentAuthorizeReply`), so it reaches the caller as a `permission_denied` with its `permission` extension, as it already did on `adapter-sqlite`. The sentence is unchanged. A vertical that served one of these refusals answered 403 only because `vertical-host` read the words "permission denied", and logged `vertical-host.untyped-refusal` for a throw the vertical never made. It now answers the same 403 from the code. One refusal's status does change: a connector's dispatch-time read of an attachment its delivery does not name was refused with a sentence that names no permission, so it answered 400; it now answers 403, as on `adapter-sqlite`.

The throwing methods (`attachmentAdd`, `attachmentList`, `attachmentAuthorize`, `attachmentRemove`, `systemAttachmentAuthorize`) stay for a coordinator from before this release during a deploy, and still throw the bare sentence. `@substrat-run/contract-tests` adds `attachmentRefusalContractSuite`.
