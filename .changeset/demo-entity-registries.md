---
"@substrat-run/demo-meridian": patch
"@substrat-run/demo-rally": patch
"@substrat-run/demo-shop": patch
"@substrat-run/demo-manyfold": patch
---

The four demos that predate the model phase declare their entities.

Every demo now has a registry and a checked-in `model.json`; `lint:model` covers
six models instead of two. Entity names in `attachmentTargets` and relation edges
are checked, and local `entityRelations` are DERIVED from the entities' own
`parents` rather than written twice — shop's `variant → product` and
`order → customer` both fall out of the declaration.

Cross-engine edges are checked too, now that every engine exports a registry:
meridian's `protocol → employee` against engine-protocol, rally's
`reservation → member` against engine-booking.

This is the entity half only. Declaring each demo's operations is a much larger
piece — meridian alone has ~20 — and its main payoff (declared returns for a
lane fork) is not needed yet.

Two things worth recording, both found by doing this rather than assuming:

**Meridian emits about an entity with no table.** `payroll-run` is an entity type
with an id minted at emit time and no row anywhere — an event about an
occurrence, not a stored thing. `EntityDef` requires a table, so the registry
cannot describe it. Harmless for the entity half; it will bite when operations
are declared, because `emits.entity` is checked against the registry.

**Manyfold creates tables at runtime.** A content type builds its own `ct_<key>`
table when it is defined, so those names do not exist at build time and a
registry keyed by static table names has nothing to say about them. They are also
not entities: the ENTRY is the thing, and its typed fields live in its `ct_` row.
