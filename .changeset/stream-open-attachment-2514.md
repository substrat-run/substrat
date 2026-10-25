---
"@substrat-run/kernel": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/vertical-host": minor
---

An attachment can be read back as a stream, so a file is never held whole on its way out (#2514, the deployment side):

- **`ScopeAttachments.openStream(id)`** and **`ScopedConnectorConnection.openAttachmentStream(id)`**, on both adapters: `open` and `openAttachment` with the bytes as a `SizedByteStream` read from the blob store as the consumer reads it. The read permission is checked first, before the store is touched, and an unknown id is `null`, as before. The buffered methods are unchanged.
- **The integrity check moves to the stream.** The length is the record's `size`; a stored object of another size is refused before a byte is read. The sha256 is checked as the bytes pass, and the chunk that completes the file is held back until the digest matches: a mismatch, a short object or a long one errors the stream instead, so a consumer that has received all `size` bytes has received bytes that matched the record. The held-back chunk is at most 1 MiB (`VERIFIED_STREAM_CHUNK_MAX_BYTES`). New kernel exports: `verifiedStream`, `openAttachmentByteStream`, `bytesStream`, `OpenedAttachmentStream`.
- **`TenantBlobStore.getStream?`**, optional: R2 hands back the object's own body, the pure adapter reads the file 64 KiB at a time. A store without it is read with `get` and handed on as a stream.
- **`GET /internal/connector-attachment/:id` streams** when the host has `connectorAttachmentOpenStreamLocal` (the Cloudflare host does): same path, same shape, sent at the record's size, so a body cut short by a mismatch is an error at the reader, never a shorter file. A reader that buffers, the platform's client as it stands, reads it unchanged, and a host without the method is answered from the buffered read.
- **`ConnectorDelegation.openAttachmentStream?`**, optional for older embedders: without it a streamed open falls back to `openAttachment` and hands the buffer on as a stream.

No new route, so a deployment built before this keeps answering the read in full; nothing has to be re-pushed for it to keep working. The request is a GET with no body, so the wire signer binds it whole and it is not on the `signed-only` flip gate's list.
