// Hand-written declarations for testing.cjs (#1770 review) — that file is plain, uncompiled
// CommonJS on purpose (see its own header), so nothing emits this. `.d.cts` is the extension
// TypeScript's Node16/NodeNext resolution matches against a `.cjs` implementation file.
// `better-sqlite3`'s own types are `export =`, so a `.d.cts` (CommonJS-implied) file imports it
// the CommonJS way rather than `import type … from`. A consumer typechecking against this
// subpath needs `@types/better-sqlite3` itself as a (dev)dependency for `Database.Database` to
// resolve — the scaffold from `npm create substrat` already carries it.
import Database = require('better-sqlite3');

/** The limit this module enforces — a Durable Object's own `SQLITE_LIMIT_LIKE_PATTERN_LENGTH`. */
export const LIKE_PATTERN_LIMIT: number;

/**
 * Take the limit off one connection — for a test whose ORACLE is a pattern a Durable Object
 * would refuse (a split guard compared with the whole pattern it replaced). Say so where it is
 * called: a suite that lifts the limit is a suite that no longer sees what production sees.
 */
export function liftLimit(db: Database.Database): Database.Database;
