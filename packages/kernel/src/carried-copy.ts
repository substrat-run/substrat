import type { ScopeDumpTable } from '@substrat-run/contracts';
import { MARK_COPY_ORIGIN_SQL } from './scope-copy.js';

/**
 * The copy a carry leaves behind (#1722), as two `_substrat_meta` keys.
 *
 * A hosted scope's versions are separate scripts, and a carry moves the scope's data from the
 * script it is served from into the one a version bind is about to route it to. The copy in
 * the old script is then wiped, never reaped: a later bind back to that version (a rollback)
 * carries the data into the same Durable Object again, and a reaped DO drops the restore's
 * role projection (#321). The wipe is a load, the same drop-then-replay a restore runs, of a
 * dump that holds only the tombstone below.
 *
 * - `LOAD_STAMP_KEY` says "nothing has been loaded here since". Every load into a scope DO
 *   replaces it, with the stamp a carry names for the copy it lands or with none; a carry's
 *   export reads it and stamps a store that has none, in the same call. It never leaves in a
 *   dump: the export hands it over beside one (the `LOAD_STAMP_HEADER` on `/internal/export`).
 *   The scope DO's conditional wipe compares it inside the wipe's own transaction, so a rollback
 *   that restored into the old script in the meantime replaced or cleared it, and the wipe is
 *   refused instead of destroying that restore. Kept by a scope DO built with #1722; an older
 *   one keeps none, and cannot fence.
 * - `CARRIED_AWAY_KEY` marks a store whose data was carried to another script and wiped. A
 *   carry refuses a dump that carries it (its export reached a wiped copy), and a carry that
 *   finds it on the store it just bound to knows a wipe overtook its restore. Written by the
 *   wipe on every script, old ones included, because it arrives as a row of the dump.
 */
export const LOAD_STAMP_KEY = 'load_stamp';
/**
 * The store's write revision (#1722, Codex #2008 r2 and r4): a counter every write to the store
 * advances inside the transaction that commits it (once per run and per transaction, not per
 * statement), so "nothing changed here since" covers every mutation and not only the ones that
 * append an event (a drain receipt is an UPDATE in place).
 * A load carries it forward and advances it too, so it never goes back. Like the load stamp it
 * describes this store and never leaves in a dump.
 */
export const WRITE_REVISION_KEY = 'write_revision';
/**
 * A copy the carry's fenced wipe refused because it changed after the export (#1722, Codex #2008
 * r7): a write reached it from a request still routed there before the bind, and the carry never
 * copied that write. The marker protects the copy, in the store itself: every load into it is
 * refused (409) until a staff resolution discards it or restores it forward. Its value is the
 * `KeptCopy` below, as JSON.
 */
export const KEPT_DIVERGENT_KEY = 'kept_divergent';
/** The `_substrat_meta` keys that describe the store rather than the scope's data: never dumped. */
export const STORE_LOCAL_META_KEYS: readonly string[] = [LOAD_STAMP_KEY, WRITE_REVISION_KEY, KEPT_DIVERGENT_KEY];

/** What a kept copy records about itself: where the scope's data went, when, and its revision then. */
export interface KeptCopy {
  /** The script the carry moved the scope to. */
  carriedTo: string;
  /** When the carry's wipe found the copy changed and kept it. */
  keptAt: string;
  /** The copy's write revision when it was kept. */
  revision: string | null;
  /** The latest carry away from the copy after it was kept (#1722 r9), when there was one. */
  leftAgain?: { to: string; at: string };
}

/** The refusal a load into a kept copy answers (409). */
export const KEPT_COPY_REFUSAL =
  'this copy of the scope holds writes that were not carried to where the scope now runs (#1722); ' +
  'resolve it first: discard it, or restore it forward, through the staff kept-copy route';
export const CARRIED_AWAY_KEY = 'carried_away';

/**
 * What a carry expects to find unchanged in the store it is about to restore into (#1722): the
 * load stamp and the write revision, which every load and every write advances. A store the
 * winning carry has loaded, or that has changed in any way since it went live, no longer
 * matches, and the restore is refused before its first drop.
 */
export interface LoadMarker {
  loadStamp: string | null;
  revision: string | null;
}


/**
 * The pragmas the scope DO runs that change no data, by name. Only these are exempt: a pragma
 * not listed here counts as a write, so one added later (or one that does change data) is
 * counted until someone decides otherwise, rather than slipping past the fence.
 */
const NON_WRITING_PRAGMAS: ReadonlySet<string> = new Set(['defer_foreign_keys']);

/**
 * Whether one SQL string can change the store (#1722): what advances the write revision. Reads
 * are `SELECT`, `VALUES`, `EXPLAIN`, a `WITH` that names no write verb, and the pragmas in
 * `NON_WRITING_PRAGMAS`. Anything else counts, so an unknown statement over-counts rather than
 * slipping past the fence. A string carrying several statements counts if any of them is a write.
 */
export function isWriteStatement(sql: string): boolean {
  for (const raw of sql.split(';')) {
    const stmt = raw.replace(/^(\s|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/, '');
    if (!stmt) continue;
    const verb = /^[A-Za-z]+/.exec(stmt)?.[0]?.toUpperCase();
    if (verb === 'SELECT' || verb === 'VALUES' || verb === 'EXPLAIN') continue;
    if (verb === 'PRAGMA') {
      const name = /^PRAGMA\s+(?:"?\w+"?\.)?"?(\w+)/i.exec(stmt)?.[1]?.toLowerCase();
      if (name !== undefined && NON_WRITING_PRAGMAS.has(name)) continue;
      return true;
    }
    if (verb === 'WITH') {
      if (/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(stmt)) return true;
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Whether one SQL string is the copy-marker insert and nothing else (#2005 × #1722, Codex #2008
 * r10–r11): `MARK_COPY_ORIGIN_SQL`, whitespace aside. That statement only ever makes a store more
 * restricted (a copy holds its executors inert) and changes no data, so a backfill marking a
 * carry's source between its export and its wipe must not read as a write the carry missed. It is
 * the whole of what the scope DO's bookkeeping path takes. Anything else that touches the origin
 * row — an UPDATE, a DELETE, a REPLACE, an insert of another shape — can loosen what the store
 * may run, so it is a write like any other and advances the revision.
 */
export function isCopyMarkInsert(sql: string): boolean {
  return sql.trim().replace(/\s+/g, ' ') === MARK_COPY_ORIGIN_SQL;
}

/** Where a carried copy went, and when — the tombstone's value, as JSON. */
export interface CarriedAway {
  to: string;
  at: string;
}

/** The `_substrat_meta` value under `key` in a dump or a table page's rows, or null. */
export function metaValueIn(rows: readonly (readonly unknown[])[], columns: readonly string[], key: string): string | null {
  const k = columns.indexOf('key');
  const v = columns.indexOf('value');
  if (k < 0 || v < 0) return null;
  const row = rows.find((r) => r[k] === key);
  return row && typeof row[v] === 'string' ? row[v] : null;
}

/** The `_substrat_meta` value under `key` in a scope dump, or null. */
export function dumpMetaValue(tables: readonly ScopeDumpTable[], key: string): string | null {
  const meta = tables.find((t) => t.name.toLowerCase() === '_substrat_meta');
  return meta ? metaValueIn(meta.rows, meta.columns, key) : null;
}

/** The dump a wipe loads: an empty store holding only the tombstone. */
export function carriedAwayDump(record: CarriedAway): ScopeDumpTable[] {
  return [
    {
      name: '_substrat_meta',
      ddl: 'CREATE TABLE _substrat_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      columns: ['key', 'value'],
      rows: [[CARRIED_AWAY_KEY, JSON.stringify({ to: record.to, at: record.at })]],
    },
  ];
}
