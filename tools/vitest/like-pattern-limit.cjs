/**
 * A node SQLite that refuses what a Durable Object refuses: a LIKE or GLOB pattern
 * longer than 50 bytes (#1655).
 *
 * workerd's SQLite sets `SQLITE_LIMIT_LIKE_PATTERN_LENGTH` to 50. Stock SQLite allows
 * 50000, and `better-sqlite3` exposes no `sqlite3_limit` to the JS side, so every node
 * suite ran a 92-byte GLOB happily while the hosted scope failed
 * `LIKE or GLOB pattern too complex` on every call (#1646).
 *
 * The one hook a connection does give is `db.function()`, and SQLite documents that
 * an application-defined `like()` / `glob()` REPLACES the built-in one the operators
 * call. So this installs both: refuse a pattern over the limit with the message the
 * Durable Object gives, otherwise hand the very same arguments to a pristine built-in
 * on a scratch connection, so the matching semantics stay SQLite's own.
 *
 * `--require`d (or a vitest `setupFiles` entry), it patches `Database.prototype`, so it
 * reaches a connection however it was opened and whichever module opened it.
 */
'use strict';

const { createRequire } = require('node:module');
const { join } = require('node:path');

const LIMIT = 50;
const MESSAGE = 'LIKE or GLOB pattern too complex';

/** better-sqlite3 as the adapter resolves it — the package that holds the connection class. */
const resolveDatabase = () => {
  const from = createRequire(join(__dirname, '..', '..', 'packages', 'adapter-sqlite', 'package.json'));
  return from('better-sqlite3');
};

const Database = resolveDatabase();

const seen = new WeakSet();
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
  db.function('like', { deterministic: true, varargs: true }, (pattern, value, escape) => {
    guard(pattern);
    return escape === undefined ? pristine.like.get(pattern, value) : pristine.like3.get(pattern, value, escape);
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

/**
 * Take the limit off one connection — for a test whose ORACLE is a pattern a Durable Object
 * would refuse (a split guard compared with the whole pattern it replaced). Say so where it
 * is called: a suite that lifts the limit is a suite that no longer sees what production sees.
 */
const liftLimit = (db) => {
  seen.add(db);
  register(db, false);
  return db;
};

if (!Database.prototype.__likePatternLimit) {
  Database.prototype.__likePatternLimit = LIMIT;
  // A connection is patched the first time anything is asked of it: the constructor is
  // a native one that cannot be wrapped from here, and no statement can run before this.
  for (const method of ['prepare', 'exec', 'pragma', 'transaction']) {
    const original = Database.prototype[method];
    Database.prototype[method] = function patched(...args) {
      install(this);
      return original.apply(this, args);
    };
  }
}

module.exports = { LIMIT, liftLimit };
