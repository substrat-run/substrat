---
"@substrat-run/contracts": minor
---

The operation surface of the model — `defineOperations` (#707).

#697 declared the entities. This declares what can be *done* to them, and checks
the joins that are unchecked strings today. Thirteen compile-time checks, each
with a failing case in `test/operations.test.ts`:

**Authority** — `permission` names a *declared* key (a typo becomes a
suggestion); an operation carries `permission` **XOR** `narrows`, never both and
never neither; `narrows` must state a reason.

**Surface** — `input` is the Zod object the handler already parses, so there is
no transcription step; every `{var}` in an `http` path names a real input field;
`gates` name a field of the output and a declared permission.

**`output` is #695 Ask 2**, and it arrives here rather than as separate work.
Inference documents accidents — one inferred return carried `contacts?:
undefined`, an artefact of an early return, which generation would have cemented
into the published API. It is also the prerequisite for the API/UI lane split
(#682/#683): Wasp gets away without declared returns *because it has no lanes*.

**Events** — the marquee defects:

- `entityIdFrom` names a field of the **output**. The #695 defect: 18 operations
  emitted `entityId: String(result.id)` on objects answering with `contractId` /
  `runId` / `instanceId`, because for a mutation writing a child the event is
  about the parent.
- `piiClass` is mandatory, and `subjectId` is required whenever it is not
  `'none'` — the same invariant `events.ts` enforces with a `superRefine` at
  runtime, moved to compile time.
- a `payload` field marked `erasable` on **the entity the event is about** is
  refused (§12). Resolving through `emits.entity` makes this exact: a `name`
  erasable on `customer` does not stop an event about an `office` carrying its
  own. A check that refuses correct code trains people to route around it.

`permissionsUsedBy` and `eventsEmittedBy` derive the manifest's `permissions` and
`events.emits` from the operations rather than having them written twice.

**A composer, not a second `defineModel`.** `defineOperations` sits beside
`defineEntities`, so each half stays independently adoptable — which is what let
the entity half ship and be taken up by two verticals before this existed.

Additive: nothing declares operations yet, no manifest changes shape, the whole
monorepo builds and typechecks unaltered.
