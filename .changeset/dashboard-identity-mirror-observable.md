---
'@substrat-run/dashboard': patch
---

The identity mirror stops being unobservable (#1343, step 1). The dashboard
keeps its own identity directory and best-effort mirrors links into the shared
one on every `/api/me` (#265) — two sources of truth healed by polling, where
the healing could not be checked: the mirror wrote and never read back, and its
`catch` swallowed every failure, including the 503 a missing `CONTROL_PLANE`
binding throws.

`GET /api/identity-mirror` is the answer, for the caller's own team: both
directories read and compared, with the links the mirror never landed, the
links a local unlink left behind, and the case a count cannot see — the same
user present in both, resolving to DIFFERENT principals. The comparison is
keyed on `(provider, externalId)`, the pair a login actually resolves by, and
that key is encoded structurally, because both halves accept any string and a
delimiter is only a convention the data can break.

The mirror's own failure path now leaves one structured line behind — still
best-effort, still never failing the request it rides on, and no longer
swallowing the missing-binding 503, which used to be thrown before the `catch`
could see it. That line is for a platform operator: the tenant-facing
Observability tab answers only for services the tenant owns, and this one comes
from the shared dashboard worker. The endpoint above is the tenant's own view of
the same fact.

No data moves, and no screen reads the endpoint yet. Retiring the local
directory stays a human's move, with the checkpoint — but it can now be planned
against a reading instead of a belief.
