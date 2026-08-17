---
"@substrat-run/contracts": minor
---

`defineOperations` learns the composed engines, so an event can be about an engine's entity.

`emits.entity` was checked against the vertical's own entities only. But a vertical
that drives an engine emits about the thing the ENGINE owns — that is the normal
shape of composition, not an edge case. A production vertical's
`contract/checklist-toggle` emits `fsk.contract-checklist-toggled` about
`protocol`, which belongs to engine-protocol, and it could not be declared at all.

```ts
defineOperations(entities, PERMISSIONS, [protocolEntities, workorderEntities])({ … })
```

`emits.entity` now resolves against local ∪ engine names, and a name that is
neither still fails with both sets listed. The engine's `erasable` declaration
governs a payload about the engine's entity, which is the only correct reading —
it is the engine's field, so it is the engine's classification.

Additive: the third parameter defaults to `[]`, and both existing adopters
compile unchanged.

**Why it took a production app to find.** `manifestEntities` got its `engines`
parameter when Handlebar needed a foreign relation edge; `defineOperations` never
did, because **neither reference demo emits any event at all** — `emits: []` in
both manifests, zero `emits:` across both operations files. So `emits.entity` had
only ever been exercised in test fixtures, where the entity was always local.
Emitting a fat event on every mutation is a platform rule, which makes the two
demos the unusual ones.
