/**
 * The repo's own preload for the LIKE/GLOB pattern limit (#1655) — a LAZY re-export of the
 * published helper, `@substrat-run/adapter-sqlite/testing` (#1770).
 *
 * A trampoline wraps `Database.prototype`'s `prepare`/`exec`/`pragma`/`transaction` at load
 * time, and only the FIRST REAL use of any of them pulls in the adapter's BUILT `dist` and
 * hands control to its real patch. An earlier version of this file required the dist eagerly,
 * at MODULE LOAD — which crashed every process this preload is `--require`d into that never
 * builds `packages/adapter-sqlite` and never opens a `better-sqlite3` connection at all: several
 * of `tools/ci-scope.mjs`'s shard slices (a PR touching only `apps/social-relay`, say), and a
 * bare `pnpm --filter <pkg> test` on an unbuilt tree, for ANY package, since `NODE_OPTIONS`
 * applies to every node process the shard's test step spawns. `better-sqlite3` itself needs no
 * build (a dependency with prebuilt binaries), so resolving IT eagerly is fine and unchanged
 * from before this file was a re-export; only the compiled `dist/testing.js` waits.
 *
 * `sql-limits.cjs` is `--require`d right after this file, both in `package.json` and in CI, and
 * wraps `prepare`/`exec` a SECOND time — on TOP of this file's trampoline, capturing it as ITS
 * own "original". The published module's own patch, once loaded, does the same kind of capture
 * for all four methods: whatever is CURRENTLY on the prototype becomes its "original". So this
 * cannot simply reset all four methods to the true native and let the published module re-patch
 * from there — that would silently orphan `sql-limits.cjs`'s wrapper (still a live function
 * object, but no longer reachable from the prototype for anything but a stale reference), and
 * the very next `db.exec(...)` would skip its bound-parameter/compound-term/statement-length
 * judging with no error at all. Found by running with both preloads together and watching
 * `sql-limits-preload.test.ts`'s `judges exec too` go quietly green-then-red once a `prepare`
 * elsewhere in the same process had already triggered the lazy load.
 *
 * The fix: capture what is on the prototype for each method right before presenting the true
 * natives to the published module (`before`), and once it has patched, pull ITS four functions
 * out into `resolved` and put `before` straight back. The trampoline itself never leaves the
 * prototype — whichever function object `sql-limits.cjs` (or the true native, if nothing else
 * wrapped us) captured as its own delegate keeps being that exact object, and that object's body
 * now calls `resolved[method]` directly (a stable, already-loaded reference) instead of doing a
 * fresh prototype lookup — which would otherwise recurse back into the very wrapper that just
 * called it. `resolved[method]` is what actually applies the LIKE/GLOB patch and delegates
 * further down to the true native `sql-limits.cjs` captured as ITS OWN "original" at ITS own
 * load time, so that judging survives the swap intact.
 *
 * `packages/adapter-sqlite/src/testing.ts` carries the actual implementation and its rationale.
 * This file exists only because a `--require` target must be CJS (Node 22 `require`s an ES
 * module) and because the repo's own preload chain names this path in `package.json`/CI.
 */
'use strict';

const { createRequire } = require('node:module');
const { join } = require('node:path');

const LIMIT = 50;
const METHODS = ['prepare', 'exec', 'pragma', 'transaction'];

/** better-sqlite3 as the adapter resolves it — a dependency with prebuilt binaries, no build
 * of `packages/adapter-sqlite` itself required to load it. */
const resolveDatabase = () => {
  const from = createRequire(join(__dirname, '..', '..', 'packages', 'adapter-sqlite', 'package.json'));
  return from('better-sqlite3');
};

const Database = resolveDatabase();

/** The TRUE natives, captured once, before anything ever patches the prototype. */
const natives = {};
for (const method of METHODS) natives[method] = Database.prototype[method];

/** The published module's own patched functions, once loaded — a stable reference each
 * trampoline calls directly, never a fresh prototype lookup (see the file header). */
const resolved = {};

const installTrampoline = () => {
  for (const method of METHODS) {
    Database.prototype[method] = function trampoline(...args) {
      ensureImpl();
      return resolved[method].apply(this, args);
    };
  }
};

let impl;

/** Loads the published helper on demand. Idempotent once it succeeds. */
const ensureImpl = () => {
  if (impl) return impl;
  const before = {};
  for (const method of METHODS) before[method] = Database.prototype[method];
  // Present the TRUE natives to the published module, so its own capture of "original" is
  // never our trampoline or a later preload's wrapper.
  for (const method of METHODS) Database.prototype[method] = natives[method];
  try {
    impl = require(join(__dirname, '..', '..', 'packages', 'adapter-sqlite', 'dist', 'testing.js'));
  } catch (cause) {
    // Put back exactly what was there — including a later preload's wrapper, if any — so
    // every LATER real use retries the same lazy load, and keeps failing loudly, instead of
    // silently running unpatched SQLite.
    for (const method of METHODS) Database.prototype[method] = before[method];
    throw new Error('tools/vitest/like-pattern-limit.cjs needs the built adapter (pnpm build): ' + cause.message);
  }
  // Pull the published module's own four patched functions out, then restore exactly what was
  // there before — a later preload's wrapper stays exactly where it was, now forwarding
  // (through this file's trampoline, still the same object it captured) to `resolved` instead
  // of recursing back into itself.
  for (const method of METHODS) {
    resolved[method] = Database.prototype[method];
    Database.prototype[method] = before[method];
  }
  return impl;
};

installTrampoline();

module.exports = {
  LIMIT,
  liftLimit: (db) => ensureImpl().liftLimit(db),
};
