---
"@substrat-run/engine-invites": minor
---

feat(engine-invites): the invites engine declares its `ui` block (#35)

Every other engine declares the K-15 `ui` contribution — routes, nav, entity
views a vertical's shell composes at build time — and invites shipped without
one, an inconsistency #35's reframing called out. The engine now contributes
an `invitations` route + nav entry (both keyed on `invites:read`) and an
`invitation` entity view, matching its peers' shape.

Deliberately absent: an accept route. Accepting checks no permission — the
invitation itself is the authority (membership.md §6) — so an accept screen
belongs in the host app's unauthenticated routing, outside the
permission-keyed shell (as the dashboard's `/invite/<token>` already does).
