---
'@substrat-run/builder-workspace': patch
'@substrat-run/builder': patch
---

The hosted builder's model gate runs the platform's TypeScript again instead of reporting `Command "tsc" not found` before the scaffold, and the model phase teaches `z` from `@substrat-run/contracts`, which resolves before a project has a `package.json`.
