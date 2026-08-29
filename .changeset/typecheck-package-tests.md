---
'@substrat-run/cli': patch
'@substrat-run/psl': patch
'@substrat-run/boundary-lint': patch
'@substrat-run/dev-issuer': patch
'@substrat-run/vertical-host': patch
---

These packages' `test/` directories are now typechecked. Nothing they ship changes — the
build tsconfig already emitted from `src` alone — but their `typecheck` script now compiles
the tests too, which caught a `vertical-host` test fixture that had drifted from
`VerticalScopeHost` and stayed green for months.
