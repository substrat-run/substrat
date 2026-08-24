---
'@substrat-run/contract-tests': minor
---

The conformance receipt: a package's entity-check claim moves where a tool can read it

`entityCheckConformanceSuite` proves a handler honours the check its operation declared,
and that proof runs inside vitest and vanishes with the process. `CONFORMANCE.md` (#866,
kernel-design §11.2) needs the same facts at emit time, and a tool cannot import a test
file — its top-level `describe` throws outside a runner.

So the claim leaves the test file. `test/conformance.ts` exports a declaration, the test
imports it and passes it straight through as the suite's options, and the emitter reads
the same object. There is no second copy of `inputs` or `uncovered` to drift, which is the
property `PERMISSIONS.md` is built on: an artifact rendered from a second copy is an
artifact that can disagree with what runs.

- **`@substrat-run/contract-tests/conformance`** — `declareEntityChecks`, `declareNodeOnly`
  and `assertNodeOnly`, on a subpath that imports no runner. A `declareEntityChecks` result
  *is* an `EntityCheckSuiteOptions`, so it is passed through unchanged.
- **`@substrat-run/contract-tests/plan`** — `planEntityCheckCoverage` split into
  `entity-check-plan.ts`, importing no runner. Its own note already argued for this
  ("exported and pure so the classification is testable on its own"); the emitter is the
  call site that made it necessary. The main entry re-exports it, so existing imports are
  unchanged.
- **`declaredNodeOnlySuite`** — the third assessment shape, generalised out of
  `engines/invoicing`, which was the only package doing it by hand and was consequently
  read as unassessed by two fleet censuses. Stronger than `nodeOnlySuite`: it reads the
  declaration rather than grepping source, so it is exact rather than lexical. Carries the
  zero guard the hand-written version lacked, plus the assertion that distinguishes "checks
  at the node" from "checks nothing" — an operation with no check at all also produces an
  empty plan.
- **`NodeOnlyOptions.because`** — optional, and printed into the test name. Required by
  `assertNodeOnly`, because an assessment with no reasoning is indistinguishable from
  nobody having thought about it, and the receipt prints it to a reader outside the repo.

Additive throughout: no existing export changed shape.
