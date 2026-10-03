import type { ScopeDumpTable } from '@substrat-run/contracts';

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
 * The store's write revision (#1722, Codex #2008 r2): a counter every statement that writes
 * the store advances, in the same transaction, so "nothing changed here since" covers every
 * mutation and not only the ones that append an event (a drain receipt is an UPDATE in place).
 * A load carries it forward and advances it too, so it never goes back. Like the load stamp it
 * describes this store and never leaves in a dump.
 */
export const WRITE_REVISION_KEY = 'write_revision';
/** The `_substrat_meta` keys that describe the store rather than the scope's data: never dumped. */
export const STORE_LOCAL_META_KEYS: readonly string[] = [LOAD_STAMP_KEY, WRITE_REVISION_KEY];
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
 * Whether one SQL string can change the store (#1722): what advances the write revision. Reads
 * are `SELECT`, `EXPLAIN`, `PRAGMA` (a setting, not data) and a `WITH` that names no write verb.
 * Anything else counts, so an unknown statement over-counts rather than slipping past the fence.
 * A string carrying several statements counts if any of them is a write.
 */
export function isWriteStatement(sql: string): boolean {
  for (const raw of sql.split(';')) {
    const stmt = raw.replace(/^(\s|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/, '');
    if (!stmt) continue;
    const verb = /^[A-Za-z]+/.exec(stmt)?.[0]?.toUpperCase();
    if (verb === 'SELECT' || verb === 'EXPLAIN' || verb === 'PRAGMA') continue;
    if (verb === 'WITH') {
      if (/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(stmt)) return true;
      continue;
    }
    return true;
  }
  return false;
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
