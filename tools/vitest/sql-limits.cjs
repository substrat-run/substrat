/**
 * A node SQLite that refuses what a Durable Object refuses in ALL the SQL the node adapter
 * runs, platform-internal statements included (#1786).
 *
 * `guardSqlLimits` (kernel) wraps only the module-facing `ctx.sql`, so the adapter's own
 * statements — the spine, the grant walk, the outbox drain — reached `better-sqlite3` unjudged.
 * Node allows 32 766 bound parameters where a DO allows 100, so a platform `IN (?, ?, …)` with
 * one parameter per element passed every node suite and failed on a deployed scope (#1776,
 * found by #1741's measuring). Same gap and same remedy as `like-pattern-limit.cjs` (#1655):
 * `better-sqlite3` exposes no `sqlite3_limit`, so a test-time preload patches the driver.
 *
 * It runs the kernel's own `assertWithinSqlLimits` — the one the module-facing guard runs, so
 * the two cannot disagree — on the text of every `prepare` and `exec`: bound parameters,
 * compound `SELECT` terms, statement bytes, and the columns a select list writes out. (The
 * width of a table and of a `*` result is the adapter's own check, #1811.)
 *
 * `--require`d beside the LIKE preload, and test-only: it never ships, so self-host and
 * production behaviour are unchanged. The kernel is read from its BUILT `dist`, which is what
 * `pnpm test` and CI's test step have; a checkout that has not built fails loudly on the first
 * statement rather than passing unjudged.
 */
'use strict';

const { createRequire } = require('node:module');
const { join } = require('node:path');

const root = join(__dirname, '..', '..');

const Database = createRequire(join(root, 'packages', 'adapter-sqlite', 'package.json'))('better-sqlite3');

let assertWithinSqlLimits;
const judge = (sql) => {
  if (assertWithinSqlLimits === undefined) {
    // By file path: the kernel's `exports` map names only its index, and loading that would pull
    // the whole kernel into every node process this preload is `--require`d into (pnpm's included).
    // `sql-limits.js` imports only types, so this is the pure half. Node 22 `require`s an ES module.
    try {
      assertWithinSqlLimits = require(join(root, 'packages', 'kernel', 'dist', 'sql-limits.js')).assertWithinSqlLimits;
    } catch (cause) {
      throw new Error('tools/vitest/sql-limits.cjs needs the built kernel (pnpm build): ' + cause.message);
    }
  }
  assertWithinSqlLimits(sql);
};

const exempt = new WeakSet();
// Statements already judged clean: the adapter re-prepares the same few hundred texts.
const clean = new Set();
const CLEAN_MAX = 5000;

const check = (db, sql) => {
  if (typeof sql !== 'string' || exempt.has(db) || clean.has(sql)) return;
  judge(sql);
  if (clean.size >= CLEAN_MAX) clean.clear();
  clean.add(sql);
};

/**
 * Take the limits off ONE connection — for SQL that is legitimately over a limit on node and
 * never runs on a Durable Object. Say why where it is called: a connection that is lifted is a
 * connection this preload no longer judges.
 */
const liftSqlLimits = (db) => {
  exempt.add(db);
  return db;
};

if (!Database.prototype.__sqlLimits) {
  Database.prototype.__sqlLimits = true;
  for (const method of ['prepare', 'exec']) {
    const original = Database.prototype[method];
    Database.prototype[method] = function patched(sql, ...rest) {
      check(this, sql);
      return original.call(this, sql, ...rest);
    };
  }
}

module.exports = { liftSqlLimits };
