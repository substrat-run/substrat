import {
  SCOPE_TABLE_PAGE_MAX,
  type ScopeTable,
  type ScopeTablePage,
} from '@substrat-run/contracts';

/**
 * Read-only introspection of one issuer DO's SQLite (kernel-design §5.4's admin-query
 * RPC) — what makes the dashboard's Data tab work for an installed Auth Server app.
 * The issuer has no ScopeDO, but its Better Auth store IS a real per-scope SQLite
 * database, so it answers the same two table-shaped verbs the platform ScopeDO does.
 *
 * With one difference the domain demands: this database is an identity store, so the
 * vertical REDACTS its secret-bearing columns before anything leaves the DO. The Data
 * tab is a team-facing read — row shapes, counts and ids are what make it useful;
 * password hashes, session/OAuth tokens, JWKS private keys and the issuer's own
 * signing secret must never ride along. Redaction lives HERE, inside the vertical,
 * because only the vertical knows what its columns mean (the platform's generic PII
 * mask targets free text, not credentials).
 *
 * Pure functions over a narrow `exec` interface so node tests can drive them without
 * `cloudflare:workers`; `AuthServerDO` passes `ctx.storage.sql`.
 */

/** The cell value shown in place of a secret. */
export const REDACTED = '[redacted]';

/**
 * Secret-bearing columns, by table. Everything else (ids, emails, timestamps, flags)
 * passes through — an operator debugging "why can't this user sign in" needs the row,
 * not the credential inside it. `config.value` is redacted WHOLESALE: it holds the
 * issuer's generated signing secret and delivered `cfg:` entries (which can include
 * ADMIN_PASSWORD), and the Env tab already shows declared config honestly.
 */
export const REDACTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  session: ['token'],
  account: ['password', 'access_token', 'refresh_token', 'id_token'],
  verification: ['value'],
  jwks: ['private_key'],
  // `oauthProvider` stores client secrets hashed and opaque tokens hashed by default, so
  // these are already not the credential itself — redacted anyway, because a hash of a live
  // bearer token is still the thing an offline attacker wants, and the Data tab is a
  // convenience read rather than a reason to hand one out.
  oauth_client: ['client_secret'],
  oauth_access_token: ['token'],
  oauth_refresh_token: ['token', 'rotation_replay_response'],
  // Moved aside by `db/upgrade.ts` on an upgraded install; still full of 1.6 credentials,
  // which were NOT hashed.
  legacy_oauth_application: ['client_secret'],
  legacy_oauth_access_token: ['access_token', 'refresh_token'],
  // The one credential here that is NOT a hash and cannot be one: this issuer presents it to
  // the upstream provider on every token exchange, so it is stored as given. That makes it the
  // most valuable cell in the store — a working credential for someone else's directory — and
  // the Data tab is a convenience read.
  identity_provider: ['client_secret'],
  config: ['value'],
};

/** The narrow slice of `SqlStorage` introspection needs (structurally satisfied by the DO's). */
export interface SqlExec {
  exec(
    query: string,
    ...bindings: unknown[]
  ): {
    columnNames: string[];
    toArray(): Record<string, unknown>[];
    raw(): IterableIterator<unknown[]>;
  };
}

/** SQLite internals and Cloudflare's own KV shadow table — grouped apart in the UI. */
function isSystemTable(name: string): boolean {
  return name.startsWith('sqlite_') || name.startsWith('_cf');
}

/** SQLite cell → a JSON-safe value: bigints stringify, blobs (ArrayBuffer) read as null. */
function cellToJson(v: unknown): unknown {
  if (v == null) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof ArrayBuffer || v instanceof Uint8Array) return null;
  return v;
}

function tableNames(sql: SqlExec): string[] {
  return (
    sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).toArray() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

function rowCountOf(sql: SqlExec, table: string): number {
  return Number((sql.exec(`SELECT COUNT(*) AS c FROM "${table}"`).toArray()[0] as { c: number }).c);
}

/** Every table in the issuer's DB, with row counts; SQLite/Cloudflare internals flagged. */
export function introspectTables(sql: SqlExec): ScopeTable[] {
  return tableNames(sql).map((name) => ({
    name,
    rowCount: rowCountOf(sql, name),
    system: isSystemTable(name),
  }));
}

/** A bounded page of one table, secrets redacted. Unknown table names throw — never queried blind. */
export function introspectTable(
  sql: SqlExec,
  table: string,
  limit: number,
  offset: number,
): ScopeTablePage {
  if (!tableNames(sql).includes(table)) throw new Error(`unknown table '${table}'`);
  const l = Math.min(Math.max(1, limit), SCOPE_TABLE_PAGE_MAX);
  const o = Math.max(0, offset);
  const cursor = sql.exec(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`, l, o);
  const columns = cursor.columnNames;
  const secret = new Set(REDACTED_COLUMNS[table] ?? []);
  const redacted = columns.map((c) => secret.has(c));
  const rows = Array.from(cursor.raw(), (row) =>
    (row as unknown[]).map((cell, i) => {
      const value = cellToJson(cell);
      return redacted[i] && value != null ? REDACTED : value;
    }),
  );
  return { table, columns, rows, rowCount: rowCountOf(sql, table), limit: l, offset: o };
}
