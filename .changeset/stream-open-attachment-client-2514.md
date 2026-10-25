---
"@substrat-run/control-plane-api": minor
"@substrat-run/kernel": minor
"@substrat-run/adapter-cloudflare": patch
---

The platform reads an attachment back from a vertical's deployment as a stream, so a hosted connector never holds the whole file (#2514, the platform side):

- **`VerticalClient.connectorOpenAttachmentStream`**: `connectorOpenAttachment` on the same route, with the bytes handed on as they come off the response. They are held to the record in the response header: its size, and its sha256 checked as they pass, with the last chunk held back until the digest matches. A body that breaks off, runs short or long, or does not match errors the stream with a `ControlPlaneError` 502 (`code: 'internal'`), the refusal the buffered read gives. A deployment built before streamed reads answers the same route in full, and the stream is held to the same checks.
- **What a stream error means**: such a refusal can land after every chunk but the held-back last one, so it ends in `STREAMED_ATTACHMENT_UNVERIFIED` ("the bytes delivered before this error are a prefix of an unverified file: discard them…"), never "nothing was read".
- **Time**: `deadlineFetch`'s bounds. The call's timeout runs until the caller's first read of the stream; from then, the body errors after `STREAM_IDLE_TIMEOUT_MS` without a byte, or `STREAM_MAX_DURATION_MS` in all. A deployment too slow to answer at all, or to keep sending, is a `ControlPlaneError` 504 (`code: 'unavailable'`). The bounds are set with `VerticalClientOptions.attachmentStream`; each must be a whole number of milliseconds up to an hour, and anything else is refused in words before a request is sent.
- **The control plane's connector delegation** has `openAttachmentStream`, so `conn.openAttachmentStream` in a hosted dispatch streams end to end.
- **`runtimeSha256()`** (kernel): what makes the runtime's own running SHA-256 where it has one (workerd's `crypto.DigestStream`), `undefined` elsewhere. The client checks streams with it by default, and makes a digest only once there is a body to check. `VerticalClientOptions.attachmentStream.sha256` supplies one where the runtime has none. The Cloudflare adapter's `workerdSha256` is now built on it.
