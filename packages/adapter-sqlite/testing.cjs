/**
 * A node SQLite that refuses what a Durable Object refuses: a LIKE or GLOB pattern longer
 * than 50 bytes (#1655, #1770).
 *
 * workerd's SQLite sets `SQLITE_LIMIT_LIKE_PATTERN_LENGTH` to 50. Stock SQLite allows 50000,
 * and `better-sqlite3` exposes no `sqlite3_limit` to the JS side, so a vertical's own test
 * suite runs a pattern hosted production would refuse — the incident class of #1646. The one
 * hook a connection does give is `db.function()`, and SQLite documents that an
 * application-defined `like()` / `glob()` REPLACES the built-in one the operators call. So
 * this installs both: refuse a pattern over the limit with the message a Durable Object gives,
 * otherwise hand the very same arguments to a pristine built-in on a scratch connection, so the
 * matching semantics stay SQLite's own.
 *
 * This is test-only and opt-in — importing it (for its side effect) patches
 * `Database.prototype`, so it reaches a connection however it was opened and whichever module
 * opened it, for the lifetime of the process. It costs a JavaScript call per row of every
 * `LIKE`/`GLOB` plus a second query on a scratch connection, and turns off SQLite's `LIKE`
 * prefix-index optimisation — affordable in a test process, not in what self-hosters and escrow
 * users run in production, which is why `packages/adapter-sqlite`'s own runtime code never
 * imports this module. Pull it into a vitest `setupFiles` entry:
 *
 * ```ts
 * // vitest.config.ts
 * export default defineConfig({ test: { setupFiles: ['@substrat-run/adapter-sqlite/testing'] } });
 * ```
 *
 * It patches the SAME `better-sqlite3` copy `@substrat-run/adapter-sqlite` itself resolves,
 * because it is required from inside this package rather than resolved by path from somewhere
 * else — the open question the issue that asked for this left for its placement.
 *
 * PLAIN, HAND-WRITTEN COMMONJS — DELIBERATELY, NOT COMPILED FROM TYPESCRIPT (#1770 review).
 * A build-time dependency (`tsc` emitting a `dist/testing.js` this file was compiled from once)
 * meant every process this repo's own preload (`tools/vitest/like-pattern-limit.cjs`) is
 * `--require`d into needed `packages/adapter-sqlite` BUILT — including CI shards and bare
 * `pnpm --filter <pkg> test` runs that never touch this package at all. `apps/social-relay`
 * found the gap concretely: it opens its own, unrelated `better-sqlite3` connections (an OAuth
 * client store) with no workspace dependency on `@substrat-run/adapter-sqlite`, so
 * `tools/ci-scope.mjs`'s build filter never built it for a social-relay-only PR, and the whole
 * preload chain — needed by EVERY process regardless of scope — broke. This file ships AS-IS,
 * `require`-able the moment `pnpm install` has run, needing no build step at all. Its shape
 * (a `.cjs` extension, unambiguous CommonJS regardless of this package's own `"type": "module"`)
 * is `require`-able directly and `import`-able from ESM (Node reads a CommonJS module either
 * way), so one file serves both `./testing`'s `import` and `require` paths — see `testing.d.cts`
 * for its hand-written types, and `package.json`'s `exports` map for the subpath itself.
 */
'use strict';

const Database = require('better-sqlite3');

const LIMIT = 50;
const MESSAGE = 'LIKE or GLOB pattern too complex';

// Node's module cache does NOT guarantee this file is evaluated once. vitest's own SSR loader
// "inlines" a workspace file — evaluates a dynamic `import()` of this file in ITS OWN transform
// pipeline — while `createRequire(...)(...)` bypasses that pipeline and goes through Node's
// NATIVE `require`; the two keep separate registries, so `import()` and `require()` of the
// SAME resolved path give two distinct evaluations, each with its own closure (proven in
// `test/testing-shared-state.test.ts`, which asserts the two `liftLimit` exports differ before
// trusting anything else). `better-sqlite3` is an external dependency, not something vitest
// inlines, so both evaluations still resolve the SAME native `Database` class and therefore the
// SAME `Database.prototype` — a `seen` WeakSet scoped to each evaluation's own closure would
// desync there: `liftLimit` called on one instance marks a connection nobody else's `install()`
// ever reads, and whichever instance is active re-limits it on the very next `prepare()`. A
// well-known `Symbol.for` key on the shared prototype is what makes every evaluation agree.
const SEEN = Symbol.for('substrat.adapter-sqlite.testing.seen');
const protoRegistry = Database.prototype;
const seen = protoRegistry[SEEN] || (protoRegistry[SEEN] = new WeakSet());
const scratch = new Database(':memory:');
seen.add(scratch);
const pristine = {
  like: scratch.prepare('SELECT like(?, ?) AS r').pluck(),
  like3: scratch.prepare('SELECT like(?, ?, ?) AS r').pluck(),
  glob: scratch.prepare('SELECT glob(?, ?) AS r').pluck(),
};

const tooLong = (pattern) => typeof pattern === 'string' && Buffer.byteLength(pattern, 'utf8') > LIMIT;

const register = (db, limited) => {
  const guard = (pattern) => {
    if (limited && tooLong(pattern)) throw new Error(MESSAGE);
  };
  // Two registrations, not one `varargs`: SQLite keys a function on its name AND arity, so a
  // call with any other number of arguments still fails "wrong number of arguments" as it does
  // on a real connection, instead of being answered by a callback that ignores the extras.
  db.function('like', { deterministic: true }, (pattern, value) => {
    guard(pattern);
    return pristine.like.get(pattern, value);
  });
  db.function('like', { deterministic: true }, (pattern, value, escape) => {
    guard(pattern);
    return pristine.like3.get(pattern, value, escape);
  });
  db.function('glob', { deterministic: true }, (pattern, value) => {
    guard(pattern);
    return pristine.glob.get(pattern, value);
  });
};

const install = (db) => {
  if (seen.has(db)) return;
  seen.add(db);
  register(db, true);
};

/** Take the limit off one connection — for a test whose ORACLE is a pattern a Durable Object
 * would refuse (a split guard compared with the whole pattern it replaced). Say so where it is
 * called: a suite that lifts the limit is a suite that no longer sees what production sees. */
const liftLimit = (db) => {
  seen.add(db);
  register(db, false);
  return db;
};

if (!Database.prototype.__likePatternLimit) {
  Database.prototype.__likePatternLimit = LIMIT;
  // A connection is patched the first time anything is asked of it: the constructor is a
  // native one that cannot be wrapped from here, and no statement can run before this.
  for (const method of ['prepare', 'exec', 'pragma', 'transaction']) {
    const original = Database.prototype[method];
    Database.prototype[method] = function patched(...args) {
      install(this);
      return original.apply(this, args);
    };
  }
}

module.exports = {
  /** The limit this module enforces — a Durable Object's own `SQLITE_LIMIT_LIKE_PATTERN_LENGTH`. */
  LIKE_PATTERN_LIMIT: LIMIT,
  liftLimit,
};
