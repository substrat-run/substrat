---
'@substrat-run/contracts': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

A regression names its versions (#1236, unlocking what #1233 parked). Issues
gain `lastVersion` (the newest version-stamped occurrence, kept through
unstamped arrivals) and `resolvedVersion` (what `lastVersion` was when the
resolve verdict landed). Together they are the sentence Sentry's release
tracking is famous for: "resolved under X, seen again under Y" — the ingest
already flipped a resolved issue to `regressed` on a fresh arrival, and now
the flip carries the pair. A reopen or ignore clears the resolution's version
with its timestamp; the console's issue detail renders the pair on a
regressed row.
