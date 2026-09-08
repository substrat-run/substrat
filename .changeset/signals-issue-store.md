---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

Failures group into issues (#1233, the store). Every ops-failure insert now
also bumps a row in `_substrat_issues`, keyed by `opsFailureFingerprint` —
operation + stage + taxonomy code, deliberately never the message — with a
count, first/last seen, the newest exemplar's message, and a lifecycle:
`new` on first sight, `resolved`/`ignored` as staff verdicts
(`HostAdmin.setIssueStatus`, audited with the before/after diff), and
`regressed` written only by ingest when a fresh arrival lands on a resolved
issue. An ignored issue stays ignored. The issue row OWNS its counters — the
evidence beneath it self-prunes at 90 days, and a count must survive its own
exemplars — and outlives its last occurrence by 180 days, long enough for a
regression to be recognizable. Failure rows carry their `fingerprint` too,
so `listOpsFailures({ fingerprint })` walks one issue's exemplars.
`HostAdmin.listIssues` reads the groups newest-last-seen first; no cursor by
design, because grouping IS the compression. The 577-attempt intent of #570
would have been one issue with a rising count from attempt 2.
