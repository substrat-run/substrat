---
"@substrat-run/connector-microsoft365": patch
"@substrat-run/connector-scrive": patch
---

The Microsoft 365 and Scrive connectors read the files they send as streams (`conn.openAttachmentStream`), so a delivery never holds a whole file (#2514):

- **Microsoft 365, files into a channel folder**: a file of up to 4 MB is read to its end before the one request that sends it. A larger file goes into its upload session one chunk at a time, so a delivery holds one 3.2 MiB chunk instead of the file. The range that commits the file is sent only once the stream has ended at its length. So bytes that fail their integrity check while they are read are never saved: the session is cancelled, and the delivery retries as any failure does. A redelivery that meets its own earlier file checks the app and the size first, and reads the bytes again for the QuickXorHash only if both match. Nothing is adopted when that read is refused.
- **Scrive, the bound document**: the document streams into `setfile` inside the multipart body. Bytes that fail their integrity check part-way abort the request before its closing boundary, so Scrive never receives a file from them. No `start` and no ledger row follow. The draft document is left at Scrive, as on any failure after it is created.
