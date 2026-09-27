// The node suite sees the LIKE/GLOB pattern limit a Durable Object enforces (50 bytes), so a
// pattern that passes here passes deployed too — see apps/docs/concepts/scope-host.md, "SQL
// limits on ctx.sql". The import's side effect patches better-sqlite3's Database.prototype.
import { LIKE_PATTERN_LIMIT } from '@substrat-run/adapter-sqlite/testing';

declare global {
  var __substratLikeLimitSetup: number | undefined;
}

// A marker test/sql-limits.test.ts asserts before trusting a pattern to throw — so a suite
// that stops running this file (vitest.config.ts's setupFiles edited or removed, or this file
// emptied) fails on "setup did not run" instead of silently accepting a pattern a Durable
// Object would refuse. Derived from the import itself (not a bare `true`), so the assertion
// also catches an import that resolves to something other than the real helper.
globalThis.__substratLikeLimitSetup = LIKE_PATTERN_LIMIT;
