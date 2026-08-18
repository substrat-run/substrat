---
'@substrat-run/builder-generator': minor
---

A `scenario` phase: the tests are written before the code they judge.

The ladder was interview → model → scaffold → iterate, so the suite arrived in
the same turns as the handlers it was meant to check. A test written after the
handler is a mirror of the handler; it passes, it looks thorough, and it ratifies
a wrong model perfectly and forever. Once the code is derived from the model, the
code can no longer contradict the model — the tests are the only independent
description left, and they are only independent if they were written first, from
the concept.

`BuildPhase` gains `'scenario'`; `detectPhase` keys on `test/scenario.test.ts`;
scenario turns write only `test/**`; and `buildWriteGuard` now refuses
`test/scenario.test.*` — a build that may rewrite its own oracle has none. Suites
the build ADDS (the server smoke) stay writable.

Two supporting changes:

- `pnpm lint:tests` refuses any scenario suite that imports `spec/`. A test that
  builds its inputs from the model cannot disagree with the model, which is the
  whole reason it exists. Mutation-checked.
- The local dev server now applies the same write-guard dispatch as the hosted
  agent. It previously guarded only the interview, so a local run could write
  code during the model phase while a hosted one could not.
