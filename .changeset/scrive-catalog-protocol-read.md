---
"@substrat-run/dashboard": patch
---

fix: the dashboard's Scrive catalog could not grant `protocol:read`, so no rotation could repair a connection

**Permission diff.** A Scrive connection written through the dashboard is now granted
`protocol:read` alongside `protocol:record-signature` and `protocol:attach`.

`connector-scrive` 0.9.0 (#711) made `protocol:read` load-bearing: the connector opens the
document the vertical bound to the instance and sends those bytes, and a bound-but-unreadable
document is a deliberate hard failure — the dispatch dead-letters rather than quietly posting the
attestation sheet instead. The dashboard's `PROVIDERS` catalog was not updated with it, so the
dashboard door could not grant the permission to any tenant, and a rotation — the only repair a
connection has — could not add it either.

This is the same class as the `protocol:attach` gap #716 found on the demo connection: a
connector's requirement and the catalog that grants it are two lists with nothing checking that
they agree. #726 tracks the shape that would make this mechanical — deriving the granted list from
the connecting vertical's declared `requires:` rather than restating it per provider — plus the
prior question of whether a per-dispatch read should be a standing scope-wide grant at all. This
change is the stopgap that unblocks the door in the meantime, and it widens every Scrive
connection written through the dashboard, not only the verticals that bind documents.
