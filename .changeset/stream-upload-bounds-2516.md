---
"@substrat-run/contracts": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/vertical-host": minor
"@substrat-run/control-plane-api": minor
---

A streamed attachment upload is checked and bounded before it is read, not after it has landed (#2516):

- **Write gate first.** A streamed `AttachmentUploadInput.body` asks the target's write permission before the first byte is read, on both adapters (the Durable Object host through a new `attachmentCheckWriteReply` verb on the scope). A connection or principal that may not write stores no object and the stream is not pulled. The row's own check still runs when it is written, and a buffered body is unchanged: it is already in memory.
- **A size bound.** `CONNECTOR_ATTACHMENT_STREAM_MAX_BYTES` (95 MiB) is the most one streamed connector upload may declare. `POST /internal/connector-attachment-stream` refuses a larger declared size with a `413` before it reads the body, and the platform's client refuses it before sending. The bytes are held to the declared size while they flow, so the declaration is the bound on all of them.
- **A metadata bound on both routes.** `CONNECTOR_ATTACHMENT_META_MAX_BYTES` (8 KiB once encoded) now also applies to the multipart route, whose `meta` field was unbounded; both routes, and the client, refuse more with the same `400` and the same sentence (`connectorAttachmentMetaRefusal`), instead of a server's bare `431` on the stream route.

Rollout: a scope DO deployed before this change has no `attachmentCheckWriteReply`. A streamed upload to it fails closed with a retryable `unavailable` (503) saying to redeploy, never an unchecked read, until the vertical is re-pushed. The bound is under the lowest plan's Workers request-body limit of 100 MB decimal.

A multipart upload whose metadata is over 8 KiB, which the route accepted until now, is refused.
