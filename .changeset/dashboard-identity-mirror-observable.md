---
'@substrat-run/dashboard': patch
---

The identity mirror stops being unobservable (#1343, step 1). The dashboard
keeps its own identity directory and best-effort mirrors links into the shared
one on every `/api/me` (#265) — two sources of truth healed by polling, where
the healing could not be checked: the mirror wrote and never read back, and its
`catch` swallowed every failure, including the 503 a missing `CONTROL_PLANE`
binding throws.

Three changes, none of which move data. `TenantNarrowedControlPlane` gains
`listIdentityLinks` — the read half of a seam that only ever had a write half.
`deriveIdentityDivergence` compares the two directories keyed on
`(provider, externalId)`, the pair a login actually resolves by, so it reports
not just links the mirror never landed and links a local unlink left behind,
but the case a count cannot see: the same user present in both, resolving to
DIFFERENT principals. And the mirror's failure path now emits one structured
log line instead of nothing — still best-effort, still never failing the
request it rides on.

Retiring the local directory is a live-data move, and a move cannot be planned
against a belief about whether the mirror is complete.
