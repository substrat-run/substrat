---
'@substrat-run/adapter-sqlite': minor
---

A vertical's own test suite can now see the 50-byte `LIKE`/`GLOB` pattern limit a Durable
Object enforces — the one SQL limit the adapter itself cannot judge, because a pattern is
often built at run time and `better-sqlite3` exposes no `sqlite3_limit`. Add
`@substrat-run/adapter-sqlite/testing` to your `vitest.config.ts`'s `setupFiles` and a pattern
over 50 bytes throws `LIKE or GLOB pattern too complex` the same way a deployed scope would,
instead of only failing once hosted. `npm create substrat` wires this in by default for a new
project. See "SQL limits on `ctx.sql`" in the scope-host docs.
