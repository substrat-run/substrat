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
 * `ref` and `secret_generation` arrived after the first clients were registered, so they
 * are ALTERed in by `applySchema` when an older table lacks them. Those are the exceptions,
 * and a column added in place that is nullable or carries a constant default is the only
 * kind this file takes without becoming migrations. A client that predates generations
 * reads generation 1, which is safe because a generation is only ever compared with one
 * the relay itself handed out, and an install holding a secret from before generations
 * holds none to compare (`demos/auth-server/src/social-relay.ts`).
 */
export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS relay_client (
     client_id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     secret_hash TEXT NOT NULL,
     redirect_uris TEXT NOT NULL,
     disabled INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     ref TEXT,
     secret_generation INTEGER NOT NULL DEFAULT 1
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
  if (!columns.includes('secret_generation')) {
    sql.exec('ALTER TABLE relay_client ADD COLUMN secret_generation INTEGER NOT NULL DEFAULT 1');
  }
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
 * How long a rotation lease holds off every other rotation of the same client (#3275): the time
 * one reconcile has to deliver the secret it was just handed. A holder that delivers gives it
 * back at once; one that never does (a crash, a hung delivery) is outlived by it, and the next
 * reconcile rotates again. Two minutes is many times a delivery's round trip and short enough
 * that an install left without its secret waits for nothing longer than that.
 */
export const ROTATION_LEASE_MS = 120_000;

/** The `relay_ephemeral` kind a client's rotation lease is kept under, keyed by client id. */
const ROTATION_LEASE = 'rotation-lease';

/** The lease held on this client's rotation right now, or null. Expiry is judged here, on read. */
function liveRotationLease(sql: SqlExec, clientId: string, now: number): string | null {
  const row = sql
    .exec('SELECT payload FROM relay_ephemeral WHERE kind = ? AND id = ? AND expires_at > ?', ROTATION_LEASE, clientId, now)
    .toArray()[0] as { payload: string } | undefined;
  return row?.payload ?? null;
}

function takeRotationLease(sql: SqlExec, clientId: string, now: number): string {
  const lease = randomToken(16);
  putEphemeral(sql, ROTATION_LEASE, clientId, lease, now + ROTATION_LEASE_MS);
  return lease;
}

/**
 * The client registered under `ref`, created if there is none, its name and redirect URIs
 * replaced otherwise. Read-then-write is safe: a Durable Object runs one request at a time
 * between awaits — the one await, hashing, comes before the read — and the unique index on
 * `ref` is the backstop if that ever stops being true.
 *
 * The secret is returned only on create — it is stored hashed and cannot be read back — and
 * with it a rotation lease, because handing out a secret is the first half of "hand out, then
 * deliver" exactly as a rotation is: a run that overlaps the creating one must not rotate the
 * secret the creating run is still delivering (#3275). `generation` is the client's current one.
 */
export async function ensureClientRow(
  sql: SqlExec,
  ref: string,
  input: { name: string; redirectUris: string[] },
  now: number,
): Promise<{
  clientId: string;
  clientSecret: string | null;
  created: boolean;
  disabled: boolean;
  generation: number;
  lease?: string;
}> {
  const clientSecret = randomToken(32);
  const secretHash = await sha256b64url(clientSecret);
  const existing = selectClientByRef(sql, ref);
  if (existing) {
    updateClientRegistration(sql, existing.clientId, input);
    return {
      clientId: existing.clientId,
      clientSecret: null,
      created: false,
      disabled: existing.disabled,
      generation: selectSecretGeneration(sql, existing.clientId) ?? 1,
    };
  }
  const clientId = randomToken(16);
  insertClient(sql, { clientId, name: input.name, secretHash, redirectUris: input.redirectUris, createdAt: now, ref });
  const lease = takeRotationLease(sql, clientId, now);
  return { clientId, clientSecret, created: true, disabled: false, generation: 1, lease };
}

/** What a rotation came to. `busy` and `moved` rotated nothing. */
export type RotationResult =
  | { status: 'rotated'; clientSecret: string; generation: number; lease: string }
  /** Another rotation of this client holds the lease: its secret is still being delivered. */
  | { status: 'busy' }
  /** The client's secret is no longer at the generation the caller saw: someone rotated since. */
  | { status: 'moved'; generation: number };

/**
 * A fresh secret for an existing client — but only if its secret is still at `expected`, the
 * generation the caller saw, and no other rotation holds the lease (#3275). The check and the
 * write are one compare-and-set statement after the only await, so two callers that saw the same
 * generation can never both rotate. A rotation takes the lease its delivery runs under, given
 * back with `releaseRotationLease` or outlived. Null if there is no such client.
 */
export async function rotateClientSecretRow(
  sql: SqlExec,
  clientId: string,
  expected: number,
  now: number,
): Promise<RotationResult | null> {
  const clientSecret = randomToken(32);
  const secretHash = await sha256b64url(clientSecret);
  const current = selectSecretGeneration(sql, clientId);
  if (current === null) return null;
  if (liveRotationLease(sql, clientId, now) !== null) return { status: 'busy' };
  const row = sql
    .exec(
      `UPDATE relay_client SET secret_hash = ?, secret_generation = secret_generation + 1
       WHERE client_id = ? AND secret_generation = ? RETURNING secret_generation`,
      secretHash,
      clientId,
      expected,
    )
    .toArray()[0] as { secret_generation: number } | undefined;
  if (!row) return { status: 'moved', generation: current };
  return { status: 'rotated', clientSecret, generation: Number(row.secret_generation), lease: takeRotationLease(sql, clientId, now) };
}

/** Give a rotation lease back — only the holder's own; any other is left to run out. */
export function releaseRotationLease(sql: SqlExec, clientId: string, lease: string): boolean {
  return (
    sql
      .exec('DELETE FROM relay_ephemeral WHERE kind = ? AND id = ? AND payload = ? RETURNING id', ROTATION_LEASE, clientId, lease)
      .toArray().length > 0
  );
}

export function selectSecretGeneration(sql: SqlExec, clientId: string): number | null {
  const row = sql.exec('SELECT secret_generation FROM relay_client WHERE client_id = ?', clientId).toArray()[0] as
    | { secret_generation: number }
    | undefined;
  return row ? Number(row.secret_generation) : null;
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
