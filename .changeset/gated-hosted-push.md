---
'@substrat-run/contracts': minor
---

The generated deploy workflow now gates the push. Between the build and `substrat push` it
runs whichever of `typecheck`, `test` and `lint:boundaries` the deployed package declares — the
three a scaffolded project ships with — from that package's own directory. A non-zero exit
fails the job before anything is uploaded.

Only the package's own scripts, never the repo root's: the build step ahead of it builds the
vertical's dependency closure and nothing more, so a root script is free to need a tool the job
never built. A monorepo package that wants the layer rules gated declares them itself,
`"lint:boundaries": "substrat-boundary-lint"` beside a devDependency on
`@substrat-run/boundary-lint`.

Outside the Substrat monorepo the hosted push path is the only path there is, so this is the
first place the layer rules, the type checker and the suite actually run for a project. A repo
that declares none of the three still deploys — the workflow is regenerated into projects that
predate the gate — but the run reports itself as ungated rather than passing quietly.
