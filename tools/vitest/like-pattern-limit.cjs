/**
 * The repo's own preload for the LIKE/GLOB pattern limit (#1655) — now a thin re-export of the
 * PUBLISHED helper, `@substrat-run/adapter-sqlite/testing` (#1770). `packages/adapter-sqlite/src/testing.ts`
 * carries the implementation and its rationale; this file exists only because a `--require` target
 * must be CJS (Node 22 `require`s an ES module, same precedent as `sql-limits.cjs`) and because the
 * repo's own preload chain names this path in `package.json` and CI. Same shape as `sql-limits.cjs`:
 * read from the adapter's BUILT `dist`, so a checkout that has not built fails loudly on first use
 * rather than running unpatched.
 */
'use strict';

const { join } = require('node:path');

let impl;
try {
  impl = require(join(__dirname, '..', '..', 'packages', 'adapter-sqlite', 'dist', 'testing.js'));
} catch (cause) {
  throw new Error('tools/vitest/like-pattern-limit.cjs needs the built adapter (pnpm build): ' + cause.message);
}

module.exports = { LIMIT: impl.LIKE_PATTERN_LIMIT, liftLimit: impl.liftLimit };
