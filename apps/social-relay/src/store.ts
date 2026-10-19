/**
 * The relay's storage, as pure functions over the Durable Object's SQLite.
 *
 * Split from the DO class for the reason every other store in this repo is: SQL that has
 * never been executed is a guess. These functions run against a real database in the test
 * suite, so the statements that matter — the single-use takes above all — are asserted on
 * behaviour rather than on their text.
 *
 * Two properties are load-bearing and both live in the SQL rather than in a caller:
 *
 *   - **Single use.** An authorization code that can be redeemed twice is a replay. So a
 *     take is one `DELETE … RETURNING`, not a read followed by a delete that a concurrent
 *     request can interleave with. The Durable Object is single-threaded, which makes
 *     this belt-and-braces — but the braces are one statement long.
 *   - **Expiry is checked on read, not by a sweeper.** A sweeper that stops running must
 *     never turn into a longer TTL. Rows are also swept opportunistically on write, which
 *     is housekeeping, not enforcement.
 */

import { randomToken, sha256b64url } from './jwt.js';

/** The `ctx.storage.sql` surface, as much of it as this store uses. */
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

/**
 * Applied on every DO start rather than versioned as migrations: this schema holds one
 * registry table and two caches of things that expire within minutes, so there is no
 * history to preserve and nothing a re-create could lose. The moment that stops being
 * true — the first column anyone must not drop — it wants real migrations instead.
 *
 * `ref` arrived after the first clients were registered, so it is ALTERed in by
 * `applySchema` when an older table lacks it. That is the one exception, and a nullable
 * column added in place is the only kind this file takes without becoming migrations.
 */
export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS relay_client (
     client_id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     secret_hash TEXT NOT NULL,
     redirect_uris TEXT NOT NULL,
     disabled INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     ref TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS relay_ephemeral (
     kind TEXT NOT NULL,
     id TEXT NOT NULL,
     payload TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     PRIMARY KEY (kind, id)
   )`,
  `CREATE INDEX IF NOT EXISTS relay_ephemeral_expiry ON relay_ephemeral (expires_at)`,
  `CREATE TABLE IF NOT EXISTS relay_rate (
     client_id TEXT NOT NULL,
     window_start INTEGER NOT NULL,
     hits INTEGER NOT NULL,
     PRIMARY KEY (client_id, window_start)
   )`,
  `CREATE TABLE IF NOT EXISTS relay_key (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     kid TEXT NOT NULL,
     private_jwk TEXT NOT NULL,
     public_jwk TEXT NOT NULL
   )`,
];

export function applySchema(sql: SqlExec): void {
  for (const statement of SCHEMA) sql.exec(statement);
  const columns = sql.exec('PRAGMA table_info(relay_client)').toArray().map((row) => row.name);
  if (!columns.includes('ref')) sql.exec('ALTER TABLE relay_client ADD COLUMN ref TEXT');
  // One client per install: the reconciler finds it again by this key rather than minting
  // a second one on every run. NULLs do not collide, so hand-registered clients are fine.
  sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS relay_client_ref ON relay_client (ref)');
}

/* ---- the client registry ---- */

export interface StoredClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  disabled: boolean;
  createdAt: number;
  /** The platform's key for the install this client belongs to; null for one registered by hand. */
  ref: string | null;
}

interface ClientRow {
  client_id: string;
  name: string;
  secret_hash: string;
  redirect_uris: string;
  disabled: number;
  created_at: number;
  ref: string | null;
}

function toClient(row: ClientRow): StoredClient {
  return {
    clientId: row.client_id,
    name: row.name,
    redirectUris: JSON.parse(row.redirect_uris) as string[],
    disabled: Boolean(row.disabled),
    createdAt: row.created_at,
    ref: row.ref ?? null,
  };
}

export function insertClient(
  sql: SqlExec,
  input: {
    clientId: string;
    name: string;
    secretHash: string;
    redirectUris: string[];
    createdAt: number;
    ref?: string | null;
  },
): void {
  sql.exec(
    `INSERT INTO relay_client (client_id, name, secret_hash, redirect_uris, disabled, created_at, ref)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    input.clientId,
    input.name,
    input.secretHash,
    JSON.stringify(input.redirectUris),
    input.createdAt,
    input.ref ?? null,
  );
}

export function selectClientByRef(sql: SqlExec, ref: string): StoredClient | null {
  const row = sql.exec('SELECT * FROM relay_client WHERE ref = ?', ref).toArray()[0] as ClientRow | undefined;
  return row ? toClient(row) : null;
}

/** Replaces the whole list and the display name; `disabled` is deliberately not touched. */
export function updateClientRegistration(
  sql: SqlExec,
  clientId: string,
  input: { name: string; redirectUris: string[] },
): boolean {
  return (
    sql
      .exec(
        'UPDATE relay_client SET name = ?, redirect_uris = ? WHERE client_id = ? RETURNING client_id',
        input.name,
        JSON.stringify(input.redirectUris),
        clientId,
      )
      .toArray().length > 0
  );
}

/**
 * The client registered under `ref`, created if there is none, its name and redirect URIs
 * replaced otherwise. Read-then-write is safe: a Durable Object runs one request at a time
 * between awaits, and the unique index on `ref` is the backstop if that ever stops being true.
 * The secret is returned only on create — it is stored hashed and cannot be read back.
 */
export async function ensureClientRow(
  sql: SqlExec,
  ref: string,
  input: { name: string; redirectUris: string[] },
  now: number,
): Promise<{ clientId: string; clientSecret: string | null; created: boolean; disabled: boolean }> {
  const existing = selectClientByRef(sql, ref);
  if (existing) {
    updateClientRegistration(sql, existing.clientId, input);
    return { clientId: existing.clientId, clientSecret: null, created: false, disabled: existing.disabled };
  }
  const clientId = randomToken(16);
  const clientSecret = randomToken(32);
  insertClient(sql, {
    clientId,
    name: input.name,
    secretHash: await sha256b64url(clientSecret),
    redirectUris: input.redirectUris,
    createdAt: now,
    ref,
  });
  return { clientId, clientSecret, created: true, disabled: false };
}

/** A fresh secret for an existing client, or null if there is no such client. */
export async function rotateClientSecretRow(sql: SqlExec, clientId: string): Promise<string | null> {
  const clientSecret = randomToken(32);
  return updateClientSecretHash(sql, clientId, await sha256b64url(clientSecret)) ? clientSecret : null;
}

export function updateClientSecretHash(sql: SqlExec, clientId: string, secretHash: string): boolean {
  return (
    sql
      .exec('UPDATE relay_client SET secret_hash = ? WHERE client_id = ? RETURNING client_id', secretHash, clientId)
      .toArray().length > 0
  );
}

export function selectClient(sql: SqlExec, clientId: string): StoredClient | null {
  const row = sql.exec('SELECT * FROM relay_client WHERE client_id = ?', clientId).toArray()[0] as
    | ClientRow
    | undefined;
  return row ? toClient(row) : null;
}

export function selectClientSecretHash(sql: SqlExec, clientId: string): string | null {
  const row = sql.exec('SELECT secret_hash FROM relay_client WHERE client_id = ?', clientId).toArray()[0] as
    | { secret_hash: string }
    | undefined;
  return row?.secret_hash ?? null;
}

export function selectClients(sql: SqlExec): StoredClient[] {
  return (sql.exec('SELECT * FROM relay_client ORDER BY created_at').toArray() as unknown as ClientRow[]).map(
    toClient,
  );
}

export function updateClientDisabled(sql: SqlExec, clientId: string, disabled: boolean): boolean {
  const rows = sql
    .exec('UPDATE relay_client SET disabled = ? WHERE client_id = ? RETURNING client_id', disabled ? 1 : 0, clientId)
    .toArray();
  return rows.length > 0;
}

export function removeClient(sql: SqlExec, clientId: string): boolean {
  return sql.exec('DELETE FROM relay_client WHERE client_id = ? RETURNING client_id', clientId).toArray().length > 0;
}

/* ---- in-flight state ---- */

export function putEphemeral(sql: SqlExec, kind: string, id: string, payload: string, expiresAt: number): void {
  sql.exec(
    `INSERT INTO relay_ephemeral (kind, id, payload, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(kind, id) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`,
    kind,
    id,
    payload,
    expiresAt,
  );
}

/**
 * Housekeeping, and ONLY housekeeping: expiry is enforced by `takeEphemeral` reading the
 * row's own `expires_at`, so a sweep that stops running can never become a longer TTL.
 *
 * It is deliberately not folded into `putEphemeral`, which is where it started and where
 * it was wrong: a put knows the expiry of the row it is WRITING, not the current time, and
 * sweeping against the former deletes every other round in flight. Two people signing in a
 * second apart lost each other's flows, and the suite could not see it because every test
 * pinned the clock to one constant.
 */
export function sweepExpired(sql: SqlExec, now: number): void {
  sql.exec('DELETE FROM relay_ephemeral WHERE expires_at <= ?', now);
}

/**
 * Take a row: delete it and return what it held, or null if it was never there, has
 * already been taken, or has expired. All three answer the same to a caller on purpose —
 * telling a replay from an expiry would tell an attacker which half of a guess was right.
 */
export function takeEphemeral(sql: SqlExec, kind: string, id: string, now: number): string | null {
  const row = sql
    .exec('DELETE FROM relay_ephemeral WHERE kind = ? AND id = ? RETURNING payload, expires_at', kind, id)
    .toArray()[0] as { payload: string; expires_at: number } | undefined;
  if (!row) return null;
  return row.expires_at > now ? row.payload : null;
}

/* ---- the per-client rate window ---- */

/**
 * One shared upstream client means one shared quota and one shared reputation, so an
 * install that runs away must be stopped before it spends everyone else's (#1544). A
 * fixed window is chosen over a sliding one deliberately: the failure this guards is a
 * loop, not a burst, and the crude version is legible in a row an operator can read.
 */
export function countInWindow(sql: SqlExec, clientId: string, windowStart: number): number {
  sql.exec('DELETE FROM relay_rate WHERE window_start < ?', windowStart);
  const row = sql
    .exec(
      `INSERT INTO relay_rate (client_id, window_start, hits) VALUES (?, ?, 1)
       ON CONFLICT(client_id, window_start) DO UPDATE SET hits = hits + 1
       RETURNING hits`,
      clientId,
      windowStart,
    )
    .toArray()[0] as { hits: number } | undefined;
  return Number(row?.hits ?? 1);
}

/* ---- the signing key ---- */

export function selectKey(sql: SqlExec): { kid: string; privateJwk: string; publicJwk: string } | null {
  const row = sql.exec('SELECT kid, private_jwk, public_jwk FROM relay_key WHERE id = 1').toArray()[0] as
    | { kid: string; private_jwk: string; public_jwk: string }
    | undefined;
  return row ? { kid: row.kid, privateJwk: row.private_jwk, publicJwk: row.public_jwk } : null;
}

export function insertKey(sql: SqlExec, key: { kid: string; privateJwk: string; publicJwk: string }): void {
  sql.exec(
    'INSERT INTO relay_key (id, kid, private_jwk, public_jwk) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
    key.kid,
    key.privateJwk,
    key.publicJwk,
  );
}
