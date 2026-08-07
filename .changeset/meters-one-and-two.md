---
"@substrat-run/contracts": minor
---

feat(control-plane): render meters 1–2, and say why 3–4 have no number (#38)

§5 has said "meter, do not bill" since it was written, and then metered nothing. Two of
§9's four meters were always free — a `COUNT` over the directory and a `GROUP BY` over the
entitlement store — and neither was surfaced anywhere. `readMeters(actor, { tenantId? })`
is both, as one stamped reading: fleet-wide, or narrowed to one tenant.

What made this worth an aggregate rather than arithmetic over `listScopes` is that the
billable rule is a **commercial** definition, and it now has exactly one home
(`foldMeterReading` in the kernel; each adapter supplies three projections):

- **Billable means effective, not stored.** Suspending a tenant leaves every scope row
  `active` while `getScope` fails closed for all of them — so those scopes count as
  suspended. A meter over stored status would invoice a tenant-wide outage. The same rule
  keeps meter 2 in step with meter 1: a SKU held by a suspended tenant is still held, and
  is still not revenue.
- **Expiry is decided at the reading's instant.** A lapsed grant bills nothing but reports
  as `expired` rather than vanishing — a lapsed trial is a renewal, not an absence.

Meter 2 groups by `(entitlementKey, plan)`, because the flags *are* the SKUs and `plan` is
what makes a tier data instead of operator convention.

`GET /meters[?tenantId=]` is staff-only (absent from `BUILDER_ROUTES`) and audited like
every directory read — the K-24 row's `resultCount` is the tenants covered, so "read one
tenant's meter" and "metered the whole fleet" are distinguishable acts. Nothing is stored:
a reading is recomputed per call, because a persisted running total is the first half of
the billing ledger D-30 declined to build.

Meters 3 and 4 get no field, no route and no placeholder. They are uncomputable **by
construction** — the outbox is per-scope-database with no cross-tenant fan-in, reads emit
nothing, and the cross-tenant order flow does not exist — and the console now says that
where someone would go looking for a usage number, instead of leaving it to be re-proposed.
