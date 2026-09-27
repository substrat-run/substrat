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
 * because it is imported from inside this package rather than resolved by path from
 * somewhere else — the open question the issue that asked for this left for its placement.
 */
import Database from 'better-sqlite3';

// Not imported from `@substrat-run/kernel`'s `DO_SQL_LIMITS.likePatternBytes` (the value this
// mirrors — `testing-export.test.ts` asserts the two agree): this module is required on the
// FIRST real SQLite use in every process that has this repo's own preload wired in
// (`tools/vitest/like-pattern-limit.cjs`), and pulling in the whole kernel package there costs
// real time across every one of those processes for a single number `sql-limits.cjs` already
// avoids the same way.
const LIMIT = 50;
const MESSAGE = 'LIKE or GLOB pattern too complex';

// A repo test file sometimes imports this module from SOURCE (`../src/testing.js`, vitest
// transforms it on the fly) while a consumer's setupFiles reaches it from the exports map,
// which resolves the BUILT `dist/testing.js` — two distinct module evaluations, each with its
// own closure, patching the SAME native `Database.prototype`. Only the first one to run wins
// the `__likePatternLimit` guard below and becomes the active `prepare`/`exec` patcher; a
// `seen` WeakSet scoped to this module's own closure would then desync from whichever instance
// is active — `liftLimit` called on the non-active instance would mark a connection in a
// WeakSet nobody's `install()` ever reads, and the active instance's own `install()` would
// re-limit it on the very next `prepare()`. A well-known `Symbol.for` key on the shared
// prototype object is what makes the two instances agree regardless of which one is active.
const SEEN = Symbol.for('substrat.adapter-sqlite.testing.seen');
const protoRegistry = Database.prototype as unknown as { [SEEN]?: WeakSet<Database.Database> };
const seen = protoRegistry[SEEN] ?? (protoRegistry[SEEN] = new WeakSet<Database.Database>());
const scratch = new Database(':memory:');
seen.add(scratch);
const pristine = {
  like: scratch.prepare('SELECT like(?, ?) AS r').pluck(),
  like3: scratch.prepare('SELECT like(?, ?, ?) AS r').pluck(),
  glob: scratch.prepare('SELECT glob(?, ?) AS r').pluck(),
};

const tooLong = (pattern: unknown): boolean =>
  typeof pattern === 'string' && Buffer.byteLength(pattern, 'utf8') > LIMIT;

const register = (db: Database.Database, limited: boolean): void => {
  const guard = (pattern: unknown): void => {
    if (limited && tooLong(pattern)) throw new Error(MESSAGE);
  };
  // Two registrations, not one `varargs`: SQLite keys a function on its name AND arity, so a
  // call with any other number of arguments still fails "wrong number of arguments" as it does
  // on a real connection, instead of being answered by a callback that ignores the extras.
  db.function('like', { deterministic: true }, (pattern: unknown, value: unknown) => {
    guard(pattern);
    return pristine.like.get(pattern, value);
  });
  db.function('like', { deterministic: true }, (pattern: unknown, value: unknown, escape: unknown) => {
    guard(pattern);
    return pristine.like3.get(pattern, value, escape);
  });
  db.function('glob', { deterministic: true }, (pattern: unknown, value: unknown) => {
    guard(pattern);
    return pristine.glob.get(pattern, value);
  });
};

const install = (db: Database.Database): void => {
  if (seen.has(db)) return;
  seen.add(db);
  register(db, true);
};

/** The limit this module enforces — a Durable Object's own `SQLITE_LIMIT_LIKE_PATTERN_LENGTH`. */
export const LIKE_PATTERN_LIMIT = LIMIT;

/**
 * Take the limit off one connection — for a test whose ORACLE is a pattern a Durable Object
 * would refuse (a split guard compared with the whole pattern it replaced). Say so where it is
 * called: a suite that lifts the limit is a suite that no longer sees what production sees.
 */
export const liftLimit = (db: Database.Database): Database.Database => {
  seen.add(db);
  register(db, false);
  return db;
};

type PatchableMethod = 'prepare' | 'exec' | 'pragma' | 'transaction';

// A monkey-patch over native methods of four different real signatures has no honest
// type-safe shape, so this is cast once to the one shape every call site here needs,
// rather than pretending precision with an intersection against `Database.Database`.
const proto = Database.prototype as unknown as Record<PatchableMethod, (...args: unknown[]) => unknown> & {
  __likePatternLimit?: number;
};
if (!proto.__likePatternLimit) {
  proto.__likePatternLimit = LIMIT;
  // A connection is patched the first time anything is asked of it: the constructor is a
  // native one that cannot be wrapped from here, and no statement can run before this.
  const methods: PatchableMethod[] = ['prepare', 'exec', 'pragma', 'transaction'];
  for (const method of methods) {
    const original = proto[method];
    proto[method] = function patched(this: Database.Database, ...args: unknown[]) {
      install(this);
      return original.apply(this, args);
    };
  }
}
