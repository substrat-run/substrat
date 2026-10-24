---
"@substrat-run/kernel": minor
"@substrat-run/contracts": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/vertical-host": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/contract-tests": patch
---

Connectors can now move a file into an attachment without holding it in memory (#2498): memory stays bounded whatever the file's size. A streamed body is bounded by an idle window rather than a total deadline (#2518): a transfer that keeps flowing completes, and one that stalls errors the stream, and the upload lands no object and no row. Every byte seam on the way in also takes a `SizedByteStream`, which is a stream plus the length its producer declares:

- `ConnectorResponse.body` is the provider's response as a stream. It is optional, like `headers`, so a hand-built stand-in keeps compiling. It carries the body decoded: for a response sent with a `Content-Encoding`, `Content-Length` counts the compressed bytes, so take the length from the provider's own record of the file.
- `ConnectorRequestInit.body` accepts a sized stream. `globalFetch` sends it at its declared length: on workerd as a `FixedLengthStream`, on Node with a `Content-Length` header and `duplex: 'half'`. `fetchLikeOf` turns any runtime `fetch` (a bound global, a service binding, a stand-in) into a `FetchLike` that does the same; `globalFetch` is built from it, and both hosts and `runPlatformSweep` pass the `fetch` they are given through it, so a sized body never reaches a runtime `fetch` as `"[object Object]"`.
- `AttachmentUploadInput.body` and `TenantBlobStore.put` accept a sized stream. The bytes reach the blob store as they are read. Their sha256 and size are taken on the way through, with workerd's `DigestStream` or Node's `createHash`. The row is still written after the object, and a refusal still deletes the object. A stream that carries a different number of bytes than it declared lands nothing.
- A streamed connector upload into a hosted vertical goes to the new `POST /internal/connector-attachment-stream`. The body is the request stream and the metadata travels in `x-substrat-attachment-meta`. It sits behind the same gate as the other `/internal/connector-*` routes. A buffered upload still uses the multipart route, so older deployments keep working. A streamed upload to a deployment that predates the route is refused with a 501 that says to re-push it.

Buffered callers are unchanged. Reading an attachment back out as a stream is not part of this change.
