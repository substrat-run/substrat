---
'@substrat-run/demo-manyfold': minor
'@substrat-run/demo-meridian': minor
---

The demos' `package.json` `substrat` blocks now declare `entitlements` and
`ownerGrants`, mirroring their builtin catalog entries exactly (#389). A push
copies these onto the registry row only when present, and nothing derives them
from `entitlementKey` — so the tenant-owned lineages' rows were landing with
empty install-spec fields. Production installs were saved by each vertical's
own `/internal/provision` (which grants the owner and the entitlement itself);
embedded-mode installs would have left the owner with zero grants. With the
declarations in place, an install of the pushed lineage carries the same SKU
flags and day-one owner permissions as the builtin it is replacing.
