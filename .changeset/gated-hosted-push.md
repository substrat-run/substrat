---
'@substrat-run/contracts': minor
---

The generated deploy workflow now gates the push. Between the build and `substrat push` it
runs whichever of `typecheck`, `test` and `lint:boundaries` your package.json declares — the
three a scaffolded project ships with — from the package's own directory, falling back to the
repo root in a monorepo for one the package does not declare. A non-zero exit fails the job
before anything is uploaded.

Outside the Substrat monorepo the hosted push path is the only path there is, so this is the
first place the layer rules, the type checker and the suite actually run for a project. A repo
that declares none of the three still deploys — the workflow is regenerated into projects that
predate the gate — but the run reports itself as ungated rather than passing quietly.
