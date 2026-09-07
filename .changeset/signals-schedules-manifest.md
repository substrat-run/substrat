---
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
'@substrat-run/control-plane-api': minor
---

Declared schedules travel with a push (#1232). The deploy manifest gains an
optional `schedules` field — every module's `scheduleSpec` flattened with its
owning module id, derived at push from the same `definePermissions(...)` import
that already yields the permission surface, so it costs zero extra reads.
Metadata, not code, and in no digest, exactly as the entity model rides;
versions pushed by an older CLI stay readable and answer null. The control
plane serves it back per version (`GET /verticals/:slug/versions/:id/schedules`,
owner-narrowed like the registry and model reads beside it), which is what the
dashboard's schedule-health view needs: `everyMinutes` exists nowhere off the
manifest, and next-due and missed-run detection are both derived from it.
