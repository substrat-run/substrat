import type { SqlExec } from '../src/introspect.js';

/**
 * The one-time, idempotent schema upgrade from the pre-1.7 issuer — run BEFORE
 * `SCHEMA_STATEMENTS`, on every boot, on every store.
 *
 * `CREATE TABLE IF NOT EXISTS` is the whole migration story for this vertical, and it is
 * exactly wrong three times across the `oidcProvider` → `oauthProvider` move and the Better
 * Auth 1.7.0–1.7.2 → 1.7.3 account revert:
 *
 *  1. **`account` carries an `issuer` column that Better Auth no longer writes.** 1.7.0–1.7.2
 *     made it required (`NOT NULL`, with a unique `(issuer, account_id)` index), and this
 *     upgrade used to ADD it; 1.7.3 went back to keying an account by `(provider_id,
 *     account_id)`, as 1.6 did, and stopped writing it. `IF NOT EXISTS` sees a table and
 *     leaves it alone, so an install that ran 1.7.0–1.7.2 keeps a `NOT NULL` column nothing
 *     fills — and every sign-up and every account link fails on it, including the password
 *     ones. So it is DROPPED, index first: SQLite refuses to drop an indexed column. That is
 *     the cleanup Better Auth's own upgrade guide prescribes for SQLite, and it loses nothing
 *     that is not derivable — `local:<provider_id>` for a local method, the provider row's own
 *     `identity_provider.issuer` for a generic upstream. A store from 1.6 never had the
 *     column and is left alone; adding it back would be the bug. This is user credentials'
 *     table, not OAuth state, but it is a column being removed, not a table.
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
  /** Columns removed from a surviving table, by `table.column`. */
  dropped: string[];
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
  const upgrade: SchemaUpgrade = { renamed: [], added: [], dropped: [] };

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

  // The index goes first, and on its own guard: a boot that stopped between the two statements
  // finds the column still there and the index already gone, and must still drop the column.
  // Nothing wraps these in a transaction on the Node runtime.
  const account = columnsOf(sql, 'account');
  if (account.includes('issuer')) {
    sql.exec('DROP INDEX IF EXISTS account_issuer_account_id_idx');
    sql.exec('ALTER TABLE account DROP COLUMN issuer');
    upgrade.dropped.push('account.issuer');
  }

  // Generic OIDC providers (#1213's follow-up): `identity_provider` grew `issuer`, `label`
  // and `endpoints`, and `IF NOT EXISTS` cannot add a column to a store that already has the
  // table. Nullable-with-no-backfill is correct here — every pre-existing row IS a catalogue
  // row, and NULL is exactly what marks one.
  // Guarded per column, not by `issuer` alone: nothing wraps these ALTERs in a transaction
  // on the Node runtime, so a boot that stopped between them must find the next one still
  // adding the columns it got to rather than skipping the block.
  const identityProvider = columnsOf(sql, 'identity_provider');
  if (identityProvider.length > 0) {
    for (const column of ['issuer', 'label', 'endpoints']) {
      if (identityProvider.includes(column)) continue;
      sql.exec(`ALTER TABLE identity_provider ADD COLUMN ${column} TEXT`);
      upgrade.added.push(`identity_provider.${column}`);
    }
  }

  // Per-client sign-in policy (`src/sign-in-policy.ts`): `session` grew `sign_in_provider`,
  // the method each session was established with, and `IF NOT EXISTS` cannot add a column to
  // a table that already exists. Nullable with NO backfill, deliberately: a session made
  // before this column existed has no honest value, and `policyAdmits` refuses a null under
  // any policy — so the upgrade costs those sessions one re-login at a restricted client and
  // never guesses a method on their behalf.
  const session = columnsOf(sql, 'session');
  if (session.length > 0 && !session.includes('sign_in_provider')) {
    sql.exec('ALTER TABLE session ADD COLUMN sign_in_provider TEXT');
    upgrade.added.push('session.sign_in_provider');
  }

  // The signing keys: `jwks` grew `alg` and `crv` with the 1.7 `jwt` plugin, and a store the
  // 1.6 issuer created has neither. This one does NOT fail the way the others do, which is
  // why it outlived them: drizzle quotes every identifier (`select "alg" … from "jwks"`), and
  // where SQLite still honours double-quoted strings — a Durable Object's does — a quoted
  // name that resolves to no column is read as the STRING `'alg'`, not refused. So the read
  // succeeds, the key comes back claiming the algorithm "alg", and `importJWK` rejects it
  // with `JOSENotSupported` — but only on the one path that signs, the `set-auth-jwt`
  // after-hook on `getSession`, which runs only when there IS a session. The visible symptom
  // was therefore "signed out, the login screen; signed in, a 400". better-sqlite3 is
  // compiled with that misfeature off and says `no such column` instead, so no node suite
  // could reproduce the symptom; the test pins the column.
  //
  // Nullable with NO backfill, because NULL is already what the plugin means by "a key from
  // before the column existed": it reads a null `alg` as `keyPairConfig.alg ?? 'EdDSA'`, and
  // the curve off the key's own JWK. The existing key keeps its `kid`, so nothing a relying
  // party has cached is invalidated. Guarded per column, like `identity_provider` above.
  const jwks = columnsOf(sql, 'jwks');
  if (jwks.length > 0) {
    for (const column of ['alg', 'crv']) {
      if (jwks.includes(column)) continue;
      sql.exec(`ALTER TABLE jwks ADD COLUMN ${column} TEXT`);
      upgrade.added.push(`jwks.${column}`);
    }
  }

  return upgrade;
}
