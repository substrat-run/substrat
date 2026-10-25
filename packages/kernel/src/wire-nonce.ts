import type { SwitchSql } from './system-switch.js';

/**
 * The wire-signing nonce store (RFC wire-signing §4, Q4 as amended): where a scope records the
 * nonce of each signed call it accepted that changes state, so the same envelope is accepted once.
 *
 * The verifier in the platform's entry claims a nonce here only after every other check of the
 * envelope has passed, and only in the scope the verified envelope names, through the scope host's
 * `claimWireNonceLocal`. Both adapters build these tables from this one definition and claim
 * through `claimWireNonceIn`, so the self-hosted store and the hosted one answer alike.
 *
 * Kernel-written spine, never a module migration. **Store-local**: the tables describe calls this
 * store accepted, not the scope's data, so a dump never carries them (`isWireNonceTable`) and a
 * write to them advances no write revision a carry fences on (`isWireNonceWrite`). A load,
 * restore, rewind, wipe or delete replaces the store, and the nonces recorded before it go with
 * it, for the rest of their window. That window is short by design: an envelope lives at most two
 * minutes.
 */

/**
 * The live nonces, one row each, and the count of them. `until_s` is the integer Unix second after
 * which a nonce may be forgotten (the envelope's `exp` plus the skew), and departs from the spine's
 * ISO-text rule on purpose: the envelope states its times in Unix seconds and every comparison
 * here is numeric, so text would add a conversion at both ends and change nothing.
 *
 * The count is a row of its own so that the cap costs one row read, not a scan: a claim keeps it in
 * step with the rows it inserts and purges, in the same transaction.
 */
export const WIRE_NONCE_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_wire_nonces (
    -- The envelope's nonce: 16 random bytes in canonical base64url, 22 characters.
    nonce TEXT PRIMARY KEY,
    -- Integer Unix seconds, not ISO text: the envelope's own unit, compared numerically.
    until_s INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS _substrat_wire_nonces_until
    ON _substrat_wire_nonces (until_s);
  -- One row, slot 'live': how many rows _substrat_wire_nonces holds. Absent until the first claim.
  CREATE TABLE IF NOT EXISTS _substrat_wire_nonce_count (
    slot TEXT PRIMARY KEY,
    live INTEGER NOT NULL
  ) WITHOUT ROWID;
`;

/** The tables `WIRE_NONCE_DDL` builds: store-local, so no dump carries them. */
export const WIRE_NONCE_TABLE_NAMES = ['_substrat_wire_nonces', '_substrat_wire_nonce_count'] as const;

const NONCE_TABLES: ReadonlySet<string> = new Set<string>(WIRE_NONCE_TABLE_NAMES);

/** Whether a table is one of the nonce store's, which a dump leaves out. Case-insensitive, as SQLite names are. */
export const isWireNonceTable = (name: string): boolean => NONCE_TABLES.has(name.toLowerCase());

/**
 * The most live nonces one scope holds. Past it a claim throws, which the entry answers as the
 * store's failure (fail closed, and counted), never as acceptance.
 *
 * Sized from what one scope can be asked, not from a guess:
 * - **How long a row lives.** A nonce is kept until `exp + 30` and can be claimed no earlier than
 *   `iat - 30`, and an envelope lives at most 120 s, so a row lives at most 120 + 30 + 30 = 180 s.
 * - **The platform's peak.** The control plane's calls that spend a nonce in a scope are made one
 *   at a time per scope (each awaits the last), and the busy paths that move many calls (a restore's
 *   pages, the drain, an event import) name the scope alone, so they spend none here. A sequential
 *   loop at a 10 ms round trip makes at most 100 calls a second: 100 × 180 = 18 000 rows. Ten times
 *   that is 180 000.
 * - **The object's own ceiling.** A claim is itself one request to the scope's object, which serves
 *   about 1 000 requests a second (`docs/master-plan.md`): 1 000 × 180 = 180 000 rows. No scope can
 *   reach the cap without first exceeding what its object can serve.
 *
 * At about 50 bytes a row, a full store is about 9 MB of a scope's 10 GB.
 */
export const WIRE_NONCE_CAP = 180_000;

/**
 * At most this many expired rows go per claim. A claim inserts at most one, so the purge outpaces
 * the inserts, and a claim's write stays bounded however many rows expired at once.
 */
export const WIRE_NONCE_PURGE_BATCH = 64;

/** The statements a claim writes with, whitespace aside: the only writes `isWireNonceWrite` admits. */
const PURGE_SQL = `DELETE FROM _substrat_wire_nonces WHERE nonce IN (SELECT nonce FROM _substrat_wire_nonces WHERE until_s < ? ORDER BY until_s LIMIT ${WIRE_NONCE_PURGE_BATCH}) RETURNING nonce`;
const INSERT_SQL = `INSERT INTO _substrat_wire_nonces (nonce, until_s) VALUES (?, ?) ON CONFLICT (nonce) DO NOTHING RETURNING nonce`;
const COUNT_WRITE_SQL = `INSERT INTO _substrat_wire_nonce_count (slot, live) VALUES ('live', ?) ON CONFLICT (slot) DO UPDATE SET live = excluded.live`;
const WRITES: ReadonlySet<string> = new Set([PURGE_SQL, INSERT_SQL, COUNT_WRITE_SQL]);

/**
 * Whether a statement is one of the claim's own writes, whitespace aside. The scope DO lets these,
 * and only these, through the bookkeeping path that advances no write revision: a nonce describes
 * a call this store accepted, not the scope's data, and a carried copy is another deployment, whose
 * audience check refuses an envelope meant for this one anyway.
 */
export const isWireNonceWrite = (sql: string): boolean => WRITES.has(sql.trim().replace(/\s+/g, ' '));

/** 16 bytes in canonical base64url: 22 characters, the last one's unused trailing bits zero. */
const NONCE = /^[A-Za-z0-9_-]{21}[AQgw]$/;

/** What a claim answers: the nonce was unspent (`true`), spent or too late (`false`), or the store is at its cap. */
export type WireNonceClaim = true | false | 'full';

/**
 * Claim `nonce` until `until` (Unix seconds) in one scope's store, at `nowSeconds` by the store's
 * own clock. Run it inside one transaction: it purges up to `WIRE_NONCE_PURGE_BATCH` expired rows,
 * then answers `false` for a claim after `until` (the nonce may already be forgotten) or a nonce
 * already held, `'full'` when the store holds `cap` live rows, and `true` once it has recorded the
 * nonce. `'full'` is answered rather than thrown so that the purge before it still commits: the
 * caller throws after the transaction, and a store that filled up drains as its rows expire.
 *
 * A nonce that is not 22 characters of base64url, or an `until` or a clock that is not a
 * non-negative safe integer, is the caller's fault and throws before anything is written.
 */
export function claimWireNonceIn(
  sql: SwitchSql,
  nonce: string,
  until: number,
  nowSeconds: number,
  cap: number = WIRE_NONCE_CAP,
): WireNonceClaim {
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) throw new TypeError('a wire nonce is 22 characters of canonical base64url');
  for (const [name, value] of [['until', until], ['nowSeconds', nowSeconds]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} is a non-negative whole number of seconds`);
  }
  // No count row yet means no nonce yet: the row is written with the first one.
  let live = Number(sql.all(`SELECT live FROM _substrat_wire_nonce_count WHERE slot = 'live'`)[0]?.live ?? 0);
  const before = live;
  live -= sql.all(PURGE_SQL, nowSeconds).length;
  let answer: WireNonceClaim;
  if (nowSeconds > until) answer = false;
  else if (live >= cap) answer = 'full';
  else if (sql.all(INSERT_SQL, nonce, until).length === 1) {
    live += 1;
    answer = true;
  } else answer = false;
  if (live !== before) sql.run(COUNT_WRITE_SQL, live);
  return answer;
}

/** What a claim at the cap throws, after its purge committed: the entry answers it as the store's failure. */
export const WIRE_NONCE_FULL = 'the wire nonce store holds as many live nonces as it may; a claim is refused until some expire';
