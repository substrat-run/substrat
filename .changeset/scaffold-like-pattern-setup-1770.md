---
"create-substrat": minor
---

A scaffolded project's own test suite now sees the 50-byte `LIKE`/`GLOB` pattern limit a
Durable Object enforces, by default. `npm create substrat` writes a new `test/setup.ts` that
imports `@substrat-run/adapter-sqlite/testing` and wires it into `vitest.config.ts`'s
`setupFiles`, so a pattern over 50 bytes throws `LIKE or GLOB pattern too complex` locally
instead of only failing once deployed. A new `test/sql-limits.test.ts` proves the wiring
itself, not just the helper — it fails if `setupFiles` or `test/setup.ts` is ever removed.
