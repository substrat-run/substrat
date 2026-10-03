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
export const CARRIED_AWAY_KEY = 'carried_away';

/**
 * What a carry expects to find unchanged in the store it is about to restore into (#1722): the
 * load stamp (any load since moves it) and the outbox's highest event id (any write since moves
 * it, since every mutation emits). A store the winning carry has loaded, or that has taken a
 * write since it went live, no longer matches, and the restore is refused before its first drop.
 */
export interface LoadMarker {
  loadStamp: string | null;
  outboxTop: string | null;
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
