---
'@substrat-run/engine-absence': patch
'@substrat-run/engine-invites': patch
'@substrat-run/engine-metering': patch
'@substrat-run/engine-protocol': patch
---

absence, invites, metering and protocol now emit a checked-in `model.json`, so
`lint:model --check` covers all seven engines instead of three — a changed table or a
renamed field on any of them has to appear in a PR diff. Three declarations gained a
constraint the shipped DDL already had, so the artifact records it rather than freezing
the omission: `absence-leave-type` and `metering-meter` declare the primary key they are
keyed by, and `metering-entry` declares the `(meter_key, dedupe_key)` unique key its
dedupe replay relies on. No migration, no DDL change, no runtime behaviour changes.
