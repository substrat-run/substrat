---
'@substrat-run/control-plane-api': minor
---

The `EventSink` seam gets its Pipelines implementation, and both implementations get exported.

`createPipelinesEventSink` binds the drain to a Workers `[[pipelines]]` stream — kernel-design §5.3's Cloudflare row for event transport, "Pipelines → Iceberg/R2". A binding rather than the stream's HTTP endpoint: the endpoint needs a Workers Pipeline Send token, and a credential that ships the audit spine is one more thing to store, rotate and leak.

Three shape changes at the seam, each forced by the stream's declared schema rather than chosen. `entity` flattens to `entity_type`/`entity_id`, because the envelope holds one ref while the outbox has always held two columns. `occurredAt` becomes epoch milliseconds, because the spine stores ISO 8601 text and the column is a millisecond timestamp. And absent optional fields are stated as `null` rather than omitted, because JSON drops an `undefined` value entirely and a row missing a declared column is a rejected row, not a tolerant one.

Batches are packed by **bytes**, not by row count. Cloudflare's ceiling is 5 MB per ingestion request while the drain's budget is a row count, so a scope emitting fat payloads reaches the limit in far fewer rows than one emitting thin ones — a count-based split would work right up until a vertical started attaching documents. The budget is set deliberately under the ceiling, because `JSON.stringify` here and the encoder on Cloudflare's side need not agree byte for byte, and a batch rejected for being a kilobyte over is a scope that never drains again.

A single event larger than a whole request throws rather than being skipped: skipping would drain the scope past a row the lake never received, and `drainedAt` would then claim exact history with a hole in it.

`createR2EventSink` is now exported too. It has been written and tested since the seam landed and was never on the package's surface, which is why nothing could bind it — the drain phase has been complete on both adapters and unreachable from any deployment.
