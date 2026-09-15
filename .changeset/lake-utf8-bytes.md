---
'@substrat-run/control-plane-api': minor
---

The Tier-2 sink measures UTF-8 bytes, and ships each row's size so per-tenant volume is answerable.

`JSON.stringify(row).length` counts UTF-16 code units, not bytes. Ordinary Swedish text measures about 13% under its real UTF-8 size and a three-byte character measures at a third of it — while Cloudflare's 5 MB ingestion ceiling is in bytes. Measuring a byte budget with a code-unit ruler means a batch can pass the check locally and be rejected remotely, and a rejected batch is a scope that never drains: the next pass rebuilds exactly the same one. `TextEncoder` is the web-standard UTF-8 encoder and works identically in Workers and Node.

The same ruler now produces a `bytes` column. Every tenant's events share one parquet file — a Data Catalog sink cannot partition — so R2 reports no per-tenant storage, and `SUM(bytes) GROUP BY tenant_id` is the only honest per-tenant measure the lake can offer. It counts the row **as shipped**, not as stored: parquet is columnar and zstd-compressed, and a tenant's share of a shared compressed file is not attributable to them anyway. Billing on logical volume is the more defensible basis for exactly that reason — it does not move when compaction runs, or when an unrelated tenant's data happens to compress well.

The column measures the event's data and excludes itself, because the alternative is a fixpoint: writing the number changes the length that produced it.

`tools/lake-schema-emit.mjs` gains a third category for this. The two it had are about which outbox columns travel; `SINK_COMPUTED` is for facts about the shipment that only the shipper knows, appended after the derived fields and exempt from the drift check — since the whole point is that the outbox does not have them.

`scripts/lake-provision.mjs` gains `--discard-history=<namespace>.<table>`, the deliberate override of the snapshot gate. The gate exists because dropping a table with snapshots destroys exact history, but there is a legitimate case — a lake days old whose schema needs a column — and Cloudflare offers no other route, since a stream's schema cannot be updated and a sink refuses to write to an existing table. It takes the table's own name as its value rather than being a bare `--force`: it cannot be typed from muscle memory, cannot be copied between lakes, and a reviewer reading it in a runbook sees exactly what was destroyed. An unreadable snapshot count still refuses — it accepts a known loss, not an unknown one.

The provisioning output now also spells out the three steps a new stream id requires, because a stale id means the control plane ships to a stream that no longer exists, silently.
