---
"@substrat-run/contracts": minor
"@substrat-run/vertical-host": minor
"@substrat-run/control-plane-api": minor
---

The buffered connector upload is held to a size bound before it is buffered (#2538):

- **A buffered bound.** `CONNECTOR_ATTACHMENT_BUFFERED_MAX_BYTES` (16 MiB) is the most a buffered connector upload may carry. It is lower than the stream route's 95 MiB on purpose: that one is a request-size limit, this one a memory limit, since a buffered file is resident several times over at once. The 95 MiB bound stays for streamed uploads.
- **The multipart route.** `POST /internal/connector-attachment` refuses a `Content-Length` over 16 MiB plus a 16 KiB multipart envelope (`CONNECTOR_ATTACHMENT_MULTIPART_ENVELOPE_BYTES`) with a `413` before it buffers anything. A body with no `Content-Length`, or one that understates it, is cut off at the same count while it is read, and a file part over 16 MiB is refused once parsed. Until now the route read a body of any size into the worker's memory.
- **The client.** `VerticalClient.connectorUploadAttachment` refuses a buffer over 16 MiB with a `413` and sends nothing.
- **The sentences.** Each `413` says to use the streaming upload above 16 MiB. The body-level refusals name the request body, not the attachment (`connectorAttachmentBodyRefusal`); the file part and the client use `connectorAttachmentBufferedRefusal`; the stream route's sentence is unchanged.

A multipart upload over 16 MiB, which the route accepted until now, is refused. Use a streamed body for a file that large.
