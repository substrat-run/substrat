// The node suite sees the LIKE/GLOB pattern limit a Durable Object enforces (50 bytes), so a
// pattern that passes here passes deployed too — see apps/docs/concepts/scope-host.md, "SQL
// limits on ctx.sql". Side-effect import: patches better-sqlite3's Database.prototype.
import '@substrat-run/adapter-sqlite/testing';

declare global {
  var __substratLikeLimitSetup: true | undefined;
}

// A marker test/sql-limits.test.ts asserts before trusting a pattern to throw — so a suite
// that stops running this file (vitest.config.ts's setupFiles edited or removed, or this file
// emptied) fails on "setup did not run" instead of silently accepting a pattern a Durable
// Object would refuse.
globalThis.__substratLikeLimitSetup = true;
