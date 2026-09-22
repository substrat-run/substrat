---
'@substrat-run/contract-tests': patch
---

`vitest` moves from a regular dependency to a required peer dependency (plus a
matching `devDependency`), mirroring how `zod` is already declared. An external
consumer installing `@substrat-run/contract-tests` was getting its own copy of
`vitest` bundled in, separate from whatever `vitest` their own suite already
runs — the package's `describe`/`it` suites need to share the caller's instance,
not carry a second one. Every in-repo consumer (both adapters, every engine, every
demo) already declares its own `vitest` devDependency, so this changes nothing for
them.
