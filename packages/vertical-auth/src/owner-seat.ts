/**
 * The OWNER SEAT — how a provisioned scope gets its first human (#925).
 *
 * At provision the platform mints a principal for the installer and hands it to the
 * vertical as `owner`. It cannot hand over the login: the vertical authenticates at
 * whatever issuer the tenant bound, and the platform does not know what `sub` that
 * issuer will emit for this person. So the seat is minted EMPTY and bound later, by a
 * verified subject arriving to claim it. Three ways in, and the first two are what
 * closes the window this used to leave open:
 *
 *   1. **First sign-in, inside a window.** The install flow is "provision, then the
 *      installer opens the app and signs in" — seconds apart. That trust-on-first-use
 *      claim stays, but only for `FIRST_SIGN_IN_WINDOW_MS` after provision. Before, it
 *      was unbounded in time and audience: a CI-deployed instance whose issuer had open
 *      sign-up was a seat anyone could take, indefinitely, and nothing said so.
 *   2. **A claim link.** After the window (or instead of it), the platform asks the
 *      vertical for a short-lived claim token under the platform secret, and the
 *      dashboard hands the installer the link. Only the token's HASH is stored here;
 *      the token rides one HTTP exchange and is never persisted anywhere.
 *   3. **Reconcile never re-opens.** A re-provision (the platform's reconciliation
 *      sweep, a retry) keeps whatever window the seat already has, and a seat already
 *      claimed is left claimed — before, `INSERT OR REPLACE` re-minted the pending seat
 *      on every re-provision, so a sweep could hand a claimed desk's ownership to the
 *      next stranger to sign in.
 *
 * A CLOSED window is not a lost desk: `pending_owner` stays until a claim binds it, so
 * `needsSetup` keeps reporting the truth and a claim link always works. What a closed
 * window refuses is exactly the unbounded part — a stranger's plain sign-in.
 *
 * Plain functions over a minimal SQLite `exec` seam (the same shape as site-registry.ts)
 * so the rules are unit-tested against a real SQLite without standing up a Durable Object.
 * The IdentityDO's owner-seat methods delegate here.
 */

import type { RegistrySql } from './site-registry.js';

/** How long after provision a plain first sign-in still claims the seat. */
export const FIRST_SIGN_IN_WINDOW_MS = 15 * 60_000;
/** How long a minted claim link stays valid. */
export const OWNER_CLAIM_TTL_MS = 15 * 60_000;

/**
 * The tables. `identity` is the provider-agnostic directory (a verified `sub` → the
 * PrincipalId it maps to, per scope — K-22, the same login is a different principal in
 * each scope); it is also written by invites, which is why it lives here beside the seat
 * rather than in the DO alone: claiming IS writing it.
 */
export const OWNER_SEAT_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS identity (scope_id TEXT NOT NULL, sub TEXT NOT NULL, principal TEXT NOT NULL, PRIMARY KEY (scope_id, sub))`,
  // The owner seat waiting to be claimed: set at provision, consumed by the claim. `claim_until`
  // bounds the plain first-sign-in path (ms epoch); NULL — a row from before the column existed —
  // reads as CLOSED, since a seat that sat unclaimed across an upgrade is exactly the case.
  `CREATE TABLE IF NOT EXISTS pending_owner (scope_id TEXT PRIMARY KEY, principal TEXT NOT NULL, claim_until INTEGER)`,
  // The DURABLE owner of record: also set at provision, but NEVER consumed (#332). `pending_owner`
  // is gone the moment the owner claims, so it can't answer "who owns this scope" after that.
  // This can — it survives a scope-DO storage wipe, and the reconcile path re-grants from it.
  `CREATE TABLE IF NOT EXISTS owner_of_record (scope_id TEXT PRIMARY KEY, principal TEXT NOT NULL)`,
  // One outstanding claim link per scope — the hash of its token and when it stops working.
  // Minting again replaces it, so a leaked link is retired by minting a fresh one.
  `CREATE TABLE IF NOT EXISTS owner_claim (scope_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
];

/**
 * Bring a `pending_owner` table from before `claim_until` up to date. `CREATE TABLE IF NOT
 * EXISTS` leaves an existing table alone, so a DO whose storage predates the column needs the
 * one `ALTER`. Idempotent — run it after the DDL on every construction.
 */
export function migrateOwnerSeat(sql: RegistrySql): void {
  const columns = [...sql.exec('PRAGMA table_info(pending_owner)')].map((r) => r.name as string);
  if (!columns.includes('claim_until')) {
    sql.exec('ALTER TABLE pending_owner ADD COLUMN claim_until INTEGER');
  }
}

/** What the platform (and the vertical's own first-run screen) can see of the seat. */
export interface OwnerSeat {
  /** `unknown` ⇒ this scope was never provisioned through this directory. */
  state: 'claimed' | 'unclaimed' | 'unknown';
  /** The owner of record — the principal the seat binds to. Null when unknown. */
  owner: string | null;
  /** While unclaimed: whether a plain first sign-in still claims it, and until when (ISO). */
  firstSignIn: { open: boolean; until: string | null } | null;
  /** While unclaimed: the outstanding claim link's expiry (ISO), or null when none is live. */
  claimLink: { expiresAt: string } | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Record the seat at provision — both the transient `pending_owner` and the durable
 * `owner_of_record`. The FIRST write wins: a scope that already has an owner of record is
 * left exactly as it is, whatever principal a re-run names. The platform re-runs provision
 * on reconcile and retry with the owner it minted, so a same-owner re-run changes nothing
 * either way; a DIFFERENT owner reaching a seat that is already recorded would otherwise
 * re-point it — and re-open a claimed one for a stranger — which is the hole this closes.
 * A pending seat keeps the window it was given rather than getting a fresh one per re-run.
 */
export function recordOwnerSeat(
  sql: RegistrySql,
  scopeId: string,
  principal: string,
  now: number,
  windowMs: number = FIRST_SIGN_IN_WINDOW_MS,
): void {
  if (ownerOfRecord(sql, scopeId) !== null) return;
  sql.exec('INSERT INTO owner_of_record (scope_id, principal) VALUES (?, ?)', scopeId, principal);
  sql.exec(
    'INSERT INTO pending_owner (scope_id, principal, claim_until) VALUES (?, ?, ?)',
    scopeId,
    principal,
    now + windowMs,
  );
}

/** The scope's durable owner of record, or null if never provisioned through this directory. */
export function ownerOfRecord(sql: RegistrySql, scopeId: string): string | null {
  const row = [...sql.exec('SELECT principal FROM owner_of_record WHERE scope_id = ?', scopeId)][0] as
    | { principal: string }
    | undefined;
  return row?.principal ?? null;
}

/** Is the seat unclaimed? True whatever the window says — a closed window is still an empty seat. */
export function needsSetup(sql: RegistrySql, scopeId: string): boolean {
  return [...sql.exec('SELECT 1 FROM pending_owner WHERE scope_id = ?', scopeId)][0] !== undefined;
}

function pendingRow(sql: RegistrySql, scopeId: string): { principal: string; claim_until: number | null } | undefined {
  return [...sql.exec('SELECT principal, claim_until FROM pending_owner WHERE scope_id = ?', scopeId)][0] as
    | { principal: string; claim_until: number | null }
    | undefined;
}

function liveClaim(sql: RegistrySql, scopeId: string, now: number): { token_hash: string; expires_at: number } | undefined {
  const row = [...sql.exec('SELECT token_hash, expires_at FROM owner_claim WHERE scope_id = ?', scopeId)][0] as
    | { token_hash: string; expires_at: number }
    | undefined;
  return row && row.expires_at > now ? row : undefined;
}

/** Bind a subject to the pending seat and consume it — the one write every claim path shares. */
function bindSeat(sql: RegistrySql, scopeId: string, sub: string, principal: string): string {
  sql.exec('INSERT OR REPLACE INTO identity (scope_id, sub, principal) VALUES (?, ?, ?)', scopeId, sub, principal);
  sql.exec('DELETE FROM pending_owner WHERE scope_id = ?', scopeId);
  sql.exec('DELETE FROM owner_claim WHERE scope_id = ?', scopeId);
  return principal;
}

/** The seat as the platform sees it. */
export function ownerSeat(sql: RegistrySql, scopeId: string, now: number): OwnerSeat {
  const owner = ownerOfRecord(sql, scopeId);
  if (!owner) return { state: 'unknown', owner: null, firstSignIn: null, claimLink: null };
  const pending = pendingRow(sql, scopeId);
  if (!pending) return { state: 'claimed', owner, firstSignIn: null, claimLink: null };
  const claim = liveClaim(sql, scopeId, now);
  return {
    state: 'unclaimed',
    owner,
    firstSignIn: {
      open: pending.claim_until !== null && pending.claim_until > now,
      until: pending.claim_until === null ? null : iso(pending.claim_until),
    },
    claimLink: claim ? { expiresAt: iso(claim.expires_at) } : null,
  };
}

/**
 * Map a verified subject to a principal in this scope. Bound ⇒ that principal. Unbound with
 * the seat pending AND the first-sign-in window open ⇒ claim it. Otherwise null — a valid
 * login with no seat has no access, and a closed window is "no seat" for THIS path (the
 * claim link is the other). Provider-agnostic: the subject may come from Better Auth or an
 * OIDC issuer.
 */
export function resolvePrincipal(sql: RegistrySql, scopeId: string, sub: string, now: number): string | null {
  const bound = [...sql.exec('SELECT principal FROM identity WHERE scope_id = ? AND sub = ?', scopeId, sub)][0] as
    | { principal: string }
    | undefined;
  if (bound) return bound.principal;
  const pending = pendingRow(sql, scopeId);
  if (!pending) return null;
  if (pending.claim_until === null || pending.claim_until <= now) return null;
  return bindSeat(sql, scopeId, sub, pending.principal);
}

/**
 * Mint a claim link for a pending seat: store the token's hash with an expiry, replacing any
 * earlier link (so minting again is also how one is revoked). Null ⇒ the seat is not pending
 * — already claimed, or never provisioned here — and there is nothing to mint for.
 */
export function mintOwnerClaim(
  sql: RegistrySql,
  scopeId: string,
  tokenHash: string,
  now: number,
  ttlMs: number = OWNER_CLAIM_TTL_MS,
): { expiresAt: string } | null {
  if (!pendingRow(sql, scopeId)) return null;
  const expiresAt = now + ttlMs;
  sql.exec(
    'INSERT OR REPLACE INTO owner_claim (scope_id, token_hash, expires_at) VALUES (?, ?, ?)',
    scopeId,
    tokenHash,
    expiresAt,
  );
  return { expiresAt: iso(expiresAt) };
}

/**
 * Claim the seat by link: the presented token's hash must match the live claim, and the seat
 * must still be pending. Binds the subject, consumes the seat and the link. Null ⇒ invalid,
 * expired, already used, or nothing to claim — one answer, so a probe learns nothing.
 */
export function claimOwner(sql: RegistrySql, scopeId: string, sub: string, tokenHash: string, now: number): string | null {
  const pending = pendingRow(sql, scopeId);
  if (!pending) return null;
  const claim = liveClaim(sql, scopeId, now);
  if (!claim || claim.token_hash !== tokenHash) return null;
  return bindSeat(sql, scopeId, sub, pending.principal);
}
