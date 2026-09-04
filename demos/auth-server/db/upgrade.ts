import type { SqlExec } from '../src/introspect.js';

/**
 * The one-time, idempotent schema upgrade from the pre-1.7 issuer — run BEFORE
 * `SCHEMA_STATEMENTS`, on every boot, on every store.
 *
 * `CREATE TABLE IF NOT EXISTS` is the whole migration story for this vertical, and it is
 * exactly wrong twice across the `oidcProvider` → `oauthProvider` move:
 *
 *  1. **`account` gained a required `issuer` column** (Better Auth 1.7 core, not the OAuth
 *     plugin). `IF NOT EXISTS` sees a table and leaves it alone, so an upgraded install would
 *     keep an `account` table the adapter now writes an extra column to — and every
 *     password sign-in would fail. This is user credentials, not OAuth state: it is
 *     backfilled, never dropped. Better Auth writes `local:<provider_id>` for accounts whose
 *     provider has no issuer of its own, which is what the backfill reproduces.
 *
 *  2. **`oauth_access_token` and `oauth_consent` are REUSED NAMES with new shapes.** This is
 *     the silent one: `IF NOT EXISTS` would keep the 1.6 tables, the plugin would query
 *     columns that are not there, and the failure would land at runtime in a Durable Object
 *     rather than in CI. They are renamed out of the way instead.
 *
 * Renamed, not dropped — the clean break is about not CARRYING the old registry forward, and
 * a rename delivers that without an irreversible DROP running unattended on a live issuer.
 * The rows stay readable in the Data tab under `legacy_*` until an operator removes them.
 * Relying parties must be re-registered after this upgrade; their old ids and secrets are in
 * `legacy_oauth_application` if anyone needs to reconcile what was there.
 */

/** Does `table` exist, and does it have `column`? Both answers come from PRAGMA, not guesses. */
function columnsOf(sql: SqlExec, table: string): string[] {
  const rows = sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table).toArray();
  if (rows.length === 0) return [];
  return (sql.exec(`PRAGMA table_info("${table}")`).toArray() as { name: string }[]).map((r) => r.name);
}

export interface SchemaUpgrade {
  /** Legacy tables moved aside, by their new name. */
  renamed: string[];
  /** Columns added to a surviving table. */
  added: string[];
}

/**
 * Legacy tables whose NAME the new schema reuses, identified by a column only the old shape
 * has. Checking a column rather than mere existence is what makes this idempotent: after the
 * rename the new table appears under the same name, and it must not be renamed again.
 */
const LEGACY_TABLES: { table: string; legacyOnlyColumn: string }[] = [
  // The 1.6 client registry. Its name is not reused, but it is moved aside with the rest so
  // "everything from the old plugin" reads as one group in the Data tab.
  { table: 'oauth_application', legacyOnlyColumn: 'redirect_urls' },
  { table: 'oauth_access_token', legacyOnlyColumn: 'access_token' },
  { table: 'oauth_consent', legacyOnlyColumn: 'consent_given' },
];

export function upgradeLegacySchema(sql: SqlExec): SchemaUpgrade {
  const upgrade: SchemaUpgrade = { renamed: [], added: [] };

  for (const { table, legacyOnlyColumn } of LEGACY_TABLES) {
    const columns = columnsOf(sql, table);
    if (!columns.includes(legacyOnlyColumn)) continue;
    const legacy = `legacy_${table}`;
    // A second upgrade attempt after a crash would find the target occupied; the older
    // rename wins and this one is dropped on the floor rather than failing the boot.
    if (columnsOf(sql, legacy).length > 0) {
      sql.exec(`DROP TABLE "${table}"`);
    } else {
      sql.exec(`ALTER TABLE "${table}" RENAME TO "${legacy}"`);
      upgrade.renamed.push(legacy);
    }
  }

  const account = columnsOf(sql, 'account');
  if (account.length > 0 && !account.includes('issuer')) {
    // Added nullable (SQLite cannot add a NOT NULL column without a constant default) and
    // then filled. The adapter always writes the column from here on, so the only rows that
    // could be null are these, and they are all filled in the same statement.
    sql.exec('ALTER TABLE account ADD COLUMN issuer TEXT');
    sql.exec("UPDATE account SET issuer = 'local:' || provider_id WHERE issuer IS NULL");
    upgrade.added.push('account.issuer');
  }

  // Generic OIDC providers (#1213's follow-up): `identity_provider` grew `issuer`, `label`
  // and `endpoints`, and `IF NOT EXISTS` cannot add a column to a store that already has the
  // table. Nullable-with-no-backfill is correct here — every pre-existing row IS a catalogue
  // row, and NULL is exactly what marks one.
  const identityProvider = columnsOf(sql, 'identity_provider');
  if (identityProvider.length > 0 && !identityProvider.includes('issuer')) {
    sql.exec('ALTER TABLE identity_provider ADD COLUMN issuer TEXT');
    sql.exec('ALTER TABLE identity_provider ADD COLUMN label TEXT');
    sql.exec('ALTER TABLE identity_provider ADD COLUMN endpoints TEXT');
    upgrade.added.push('identity_provider.issuer', 'identity_provider.label', 'identity_provider.endpoints');
  }

  return upgrade;
}
