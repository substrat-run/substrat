/**
 * The repo's own preload for the LIKE/GLOB pattern limit (#1655) — a thin re-export of the
 * published helper, `@substrat-run/adapter-sqlite/testing` (#1770).
 *
 * `packages/adapter-sqlite/testing.cjs` is plain, hand-written CommonJS — never compiled — so
 * requiring it here needs no build of `packages/adapter-sqlite` at all, only `pnpm install`
 * (an earlier version compiled it from TypeScript into `dist/testing.js`, and requiring a BUILT
 * artifact eagerly crashed every process this preload is `--require`d into that never builds
 * that package: several of `tools/ci-scope.mjs`'s shard slices, and `apps/social-relay`
 * concretely — it opens its own, unrelated `better-sqlite3` connections with no workspace
 * dependency on `@substrat-run/adapter-sqlite`, so its shard never built it at all).
 *
 * Eager and unconditional, same as `packages/adapter-sqlite/testing.cjs`'s own patch, and
 * deliberately NOT lazy: a lazy trampoline here would need the same careful "capture what a
 * later preload wrapped, hand it back after loading" dance that file's patch itself needs
 * against `sql-limits.cjs` (`--require`d right after this file, wrapping `prepare`/`exec` a
 * second time on top of whatever this one installs) — real complexity, for `require`ing a
 * roughly 4ms native addon load that is going to happen in this same process the moment
 * anything opens a `better-sqlite3` connection regardless. Requiring it eagerly, in `--require`
 * order, is also exactly how two preloads that each patch the same prototype methods are
 * SUPPOSED to compose: whichever loads second captures whatever the first already installed as
 * its own delegate, with no restoring or re-patching needed by either side.
 */
'use strict';

const { join } = require('node:path');

const impl = require(join(__dirname, '..', '..', 'packages', 'adapter-sqlite', 'testing.cjs'));

module.exports = { LIMIT: impl.LIKE_PATTERN_LIMIT, liftLimit: impl.liftLimit };
