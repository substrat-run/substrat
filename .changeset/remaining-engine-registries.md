---
"@substrat-run/engine-absence": minor
"@substrat-run/engine-booking": minor
"@substrat-run/engine-invites": minor
---

The last three engines declare their entities. All seven now have registries.

A vertical composing any of them can name its entity types in a checked relation
edge, and declare an operation's `output` against a real schema instead of
retyping the engine's shape.

Each surfaced a different shape, which is why they were worth doing rather than
assuming:

**booking has TWO entities and the first parent edge INSIDE an engine.** Everywhere
else the parent is the vertical's noun, so engine registries declare none — but a
reservation cannot exist without the resource it reserves, and that is true in
every vertical. `booking_participants` stays out: a join row, not an entity.

**invites has a row-versus-published split, for privacy.** `identifier_hash` is
stored and deliberately never published — hashing the invitee's identifier is
pointless if the row is returned. So the registry describes the row (what the
journal comparison checks), `invitationRow` is that, and `invitation` is the
projection an operation may return. It is also declared `erasable`: destroying
the hash is what unlinks an invitation from the person.

**absence has the same split for a duller reason** — SQLite has no boolean, so the
row stores `active` as 0/1 while `LeaveType` publishes a boolean in camelCase.
Its ledger and requests are rows the engine owns; only the leave TYPE is
something the platform points at.

That is three engines in a row where the stored row and the published type differ,
after `engine-workorder` made the same distinction. A vertical wants the published
one for an operation's `output`, and each engine now says which is which.
