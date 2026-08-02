---
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

A scope can be rebound onto a DIFFERENT vertical lineage's serving script, data
carried (#389) — the update-rebind behind retiring a platform-owned lineage in
favour of a tenant-owned one (`manyfold` → `substrat-9yjbbn/manyfold`). Staff-only
`POST /tenants/:t/scopes/:s/rebind-vertical` (a builder is 403'd by the allowlist's
default-deny: a lineage crossing re-homes data under a different registry owner) and
`substrat scope rebind <scopeId> --to <vertical>`. The same data-first shape as
adopt-serving — export from the script that holds the data today, restore into the
target's serving script, only then flip routing and cross the version pointer (which
rewrites the scope's `vertical` in the same audited act). The one new gate: the two
lineages' migration histories are independent, so the crossing is refused unless the
scope's bound version and the target's serving version carry the same migration
digest — or the operator passes `--ack-migrations` after reading both diffs. The
source script's copy is never deleted; it is the backout.
