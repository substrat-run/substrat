---
"@substrat-run/control-plane-api": patch
---

fix(control-plane-api): reap and fork-delete strand storage on a script that never implemented delete-scope, instead of pinning the row forever

A scope bound to a script that answers 501 for `POST /internal/delete-scope`
(the standalone-app shape — the retired auth-server lineage is the canonical
case) could never be reaped: the vertical hop aborted every attempt, the scope
sat `archived` forever, and the lineage's delete stayed refused. Those bytes
are unreachable through every platform verb — export and delete alike — so
once the backup contract has resolved (a copy landed, or `backup: false` was
the explicit consent), the reap now strands them on the script (they die with
it at orphan cleanup, #248 — the same stranded-not-deleted posture as rebind's
`abandonData`) and tombstones the directory row, reporting
`storageStranded: true`. A real failure from an implemented wipe (5xx, timeout)
still aborts — 501 is the only shrug.
