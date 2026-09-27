---
"create-substrat": minor
---

A scaffolded project's own test suite now sees the 50-byte `LIKE`/`GLOB` pattern limit a
Durable Object enforces, by default. `npm create substrat` writes a new `test/setup.ts` that
imports `@substrat-run/adapter-sqlite/testing` and wires it into `vitest.config.ts`'s
`setupFiles`, so a pattern over 50 bytes throws `LIKE or GLOB pattern too complex` locally
instead of only failing once deployed.
