---
"@substrat-run/builder-generator": minor
"@substrat-run/builder-workspace": minor
---

The model phase (#680): a phase between interview and build whose only artifact is `spec/model.ts`.

The build was making design decisions and stabilising them through the gates at
the same time, which is what makes it thrash. Entities, operations, permissions
and returns are now decided **once**, in an artifact a human approves, before a
handler exists.

- `BuildPhase` gains `'model'`; `detectPhase` reads it off the workspace —
  concept approved, no `spec/model.ts` yet.
- `modelWriteGuard` restricts model turns to `spec/**`, as interview turns are.
- **`buildWriteGuard` is the mirror, and the direction rule made mechanical:**
  build turns cannot write `spec/model.*` at all. Downstream may *falsify* the
  model — a handler that cannot return what the model declares is real
  information — but it may not *author* it. Without this a failing build quietly
  redraws the contract at continuation 14 and everything agrees again, which is
  how 159 operations come to match a model that is wrong 51 times. A genuine
  modelling error stops the build instead.
- A `model` gate typechecks `spec/model.ts`. That typecheck **is** the check: the
  reference integrity lives in `defineEntities` / `defineOperations`, so a parent
  naming no entity, an `entityIdFrom` naming no output field, or a payload
  carrying an erasable field all fail here — before any module code exists.
- `skills/model.md` carries the vocabulary, and says what does **not** belong:
  behaviour stays prose, and there is no tenancy annotation because there is
  nothing to forget.

Also: `BuildPhase` was written out twice — once in `phase.ts`, once in the
`phase` build event — and the two drifted the moment a phase was added. One
definition now, in `builder-generator` because a package cannot import from an
app, re-exported by `phase.ts` where the ladder's semantics live.
