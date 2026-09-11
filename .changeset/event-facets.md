---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

The outbox can be faceted (#1239 stage 1, the reader). `facetEvents` narrows a
scope's own events by type and window, groups them by one envelope column
(`type`, `actor`, `operation`, `version`, `entityType`, `piiClass`) or one
payload field, and counts — "which currency do the failing pushes carry",
answered on what the spine already holds, with no new storage.

**An erased payload is not a missing value, and this is the whole reason it is a
helper.** A shred keeps the row and drops the content (§5.3), so
`json_extract(payload, '$.x')` over a shredded event yields exactly the NULL an
event that never carried `x` yields. Grouped naively, redacted history vanishes
into a "no value" bucket and a reader sees a clean distribution with no hint
that part of it was erased. So erased rows are counted in their own total, kept
out of the buckets, and still counted in the denominator — the event happened,
whatever it said. A contract test on both adapters shreds a subject mid-test and
asserts the null bucket does not grow.

The group-by is a fixed shape rather than interpolated SQL: an envelope grouping
selects from a known column map, and a payload grouping binds its JSON path as a
parameter with the field's pattern enforced by the contract.
