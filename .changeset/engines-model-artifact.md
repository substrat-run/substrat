---
'@substrat-run/engine-absence': patch
'@substrat-run/engine-invites': patch
'@substrat-run/engine-metering': patch
'@substrat-run/engine-protocol': patch
---

absence, invites, metering and protocol now emit a checked-in `model.json`, so
`lint:model --check` covers all seven engines instead of three — a changed table or a
renamed field on any of them has to appear in a PR diff. The two rows keyed by
something other than `id` (`absence-leave-type`, `metering-meter`) now declare the
primary key the shipped DDL already had; no runtime behaviour changes.
