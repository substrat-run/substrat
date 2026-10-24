---
"@substrat-run/contracts": minor
"@substrat-run/vertical-host": minor
"@substrat-run/control-plane-api": minor
---

The buffered connector upload is held to the same size bound as the streamed one (#2538):

- **The multipart route.** `POST /internal/connector-attachment` refuses a body over `CONNECTOR_ATTACHMENT_STREAM_MAX_BYTES` (95 MiB) plus a 16 KiB multipart envelope (`CONNECTOR_ATTACHMENT_MULTIPART_ENVELOPE_BYTES`) with a `413`, before it buffers anything when `Content-Length` says so. A body with no `Content-Length`, or one that understates it, is cut off at the same count while it is read, and a file part over the bound is refused once parsed. Until now the route read a body of any size into the worker's memory.
- **The client.** `VerticalClient.connectorUploadAttachment` refuses a buffer over the bound with a `413` and sends nothing, as it already did for a stream.
- **One sentence.** `connectorAttachmentSizeRefusal` now reads "bound on a connector upload", since it names both routes' bound.

A multipart upload over 95 MiB, which the route accepted until now, is refused. Use a streamed body for a file that large.
