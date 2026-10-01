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

import type { z, ownerTransferAbandon, ownerTransferRecord } from '@substrat-run/contracts';
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
  `CREATE INDEX IF NOT EXISTS identity_by_principal ON identity (scope_id, principal, sub)`,
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
  // The last owner hand-over (#1665): who handed to whom, and whether the platform's flow has
  // finished seating and revoking around it (`pending` → `done`), or staff abandoned it
  // (`pending` → `abandoned`). What tells a retry of THAT
  // hand-over, which must finish it, from any other request that merely finds the record naming
  // `to`, which must not revoke anybody.
  `CREATE TABLE IF NOT EXISTS owner_transfer (scope_id TEXT PRIMARY KEY, prev_principal TEXT NOT NULL, principal TEXT NOT NULL, state TEXT NOT NULL)`,
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

/**
 * What `transferOwner` did — the contracts' `ownerTransferRecord`, which the platform parses it
 * with. `transferred` moved the record and opened the hand-over; `already` found THIS hand-over
 * still open (a retry, which the platform's flow finishes); `done` found it finished (a repeat,
 * which changes nothing). `refused` wrote nothing, and `reason` says why.
 */
export type OwnerTransfer = z.input<typeof ownerTransferRecord>;
/** What `abandonOwnerTransfer` did — the contracts' `ownerTransferAbandon`. */
export type OwnerTransferAbandon = z.infer<typeof ownerTransferAbandon>;

/**
 * Hand the owner of record from `from` to `to` (#1665) — the one write that moves
 * `owner_of_record`, which `recordOwnerSeat` never does after the first. The record is what a
 * reconcile's lockout repair re-seats (#1659), so without this a hand-over left it naming the
 * ORIGINAL owner, and revoking the successor later brought that owner back.
 *
 * It moves the record and opens the hand-over (`owner_transfer`, `pending`). Seating `to` in the
 * owner's role and revoking `from` are the scope host's writes, in another Durable Object; the
 * platform's flow runs them after this, then closes the hand-over with `completeOwnerTransfer`.
 * A record already naming `to` is `already` or `done` ONLY for this same `from → to`: the record
 * says who owns the scope now, not who handed it over, and answering a different `from` as a
 * retry would have the flow revoke that principal's owner role on nobody's hand-over.
 *
 * Refuses, writing nothing, when:
 * - the scope has no owner of record here (`unknown`);
 * - `from` and `to` are one principal (`same-principal`);
 * - the seat is still UNCLAIMED (`unclaimed`). `pending_owner` names the principal a claim binds
 *   to, so moving the record under it would leave a claim link that seats a stranger as a
 *   principal that is no longer the owner. Claim the seat first. A claimed seat stays claimed:
 *   this never writes `pending_owner` or `owner_claim`.
 * - `from` is not the current record (`not-owner`) — a caller working from a stale view, or one
 *   naming a `from` other than the one this scope's record was handed over from;
 * - ANOTHER hand-over is still open (`in-flight`): its seat and revoke have not both run, and
 *   starting a second on top would let the two flows revoke across each other. Re-sending the
 *   open one finishes it, or staff abandon it (`abandonOwnerTransfer`); `inFlight` names it.
 * - THIS hand-over is open but can no longer finish (`wedged`): `to` has since lost its login or
 *   its role here. The check still refuses it, since finishing would seat as owner someone the
 *   scope removed; this only makes the refusal say which hand-over is stuck. Abandon it.
 * - `to` is not a member (`not-member`): no subject in this scope is bound to it, so nobody can
 *   sign in as that principal.
 * - `to` holds no role here (`no-role`): `toHoldsRole`, the host's read passed in by the
 *   platform's flow, says it holds no role the scope can expand. A member removed by revoking
 *   their role keeps the binding; so does one whose access is only entity-narrowed grants,
 *   which a role check does not count. Grant a role first.
 *
 * Synchronous over one DO's storage, so the read and the write cannot interleave with another
 * call; the `UPDATE` still carries `principal = from` so it can only ever move the record it read.
 */
export function transferOwner(
  sql: RegistrySql,
  scopeId: string,
  from: string,
  to: string,
  toHoldsRole: boolean,
): OwnerTransfer {
  const owner = ownerOfRecord(sql, scopeId);
  if (owner === null) return { outcome: 'refused', owner, reason: 'unknown' };
  if (from === to) return { outcome: 'refused', owner, reason: 'same-principal' };
  if (needsSetup(sql, scopeId)) return { outcome: 'refused', owner, reason: 'unclaimed' };
  const bound = isBound(sql, scopeId, to);
  const member = bound && toHoldsRole;
  const last = lastTransfer(sql, scopeId);
  // An open hand-over is judged first, so each refusal names the real state; the membership
  // check below still decides whether THIS one may finish.
  if (last?.state === 'pending') {
    const inFlight = { from: last.prev_principal, to: last.principal };
    if (last.prev_principal !== from || last.principal !== to) {
      return { outcome: 'refused', owner, reason: 'in-flight', inFlight };
    }
    if (!member) return { outcome: 'refused', owner, reason: 'wedged', inFlight };
    return { outcome: 'already', owner };
  }
  if (!bound) return { outcome: 'refused', owner, reason: 'not-member' };
  if (!toHoldsRole) return { outcome: 'refused', owner, reason: 'no-role' };
  if (owner === to) {
    // Only a FINISHED hand-over of this same pair is a repeat; an abandoned one is no retry.
    if (last?.prev_principal === from && last.principal === to && last.state === 'done') {
      return { outcome: 'done', owner };
    }
    return { outcome: 'refused', owner, reason: 'not-owner' };
  }
  if (owner !== from) return { outcome: 'refused', owner, reason: 'not-owner' };
  sql.exec('UPDATE owner_of_record SET principal = ? WHERE scope_id = ? AND principal = ?', to, scopeId, from);
  sql.exec(
    `INSERT OR REPLACE INTO owner_transfer (scope_id, prev_principal, principal, state) VALUES (?, ?, ?, 'pending')`,
    scopeId,
    from,
    to,
  );
  return { outcome: 'transferred', owner: to };
}

/**
 * Close the hand-over `from → to` (#1665) once the platform's flow has seated `to` and revoked
 * `from`: from then on a repeat of it answers `done` and the flow seats and revokes nothing, so
 * a stale retry cannot undo what the scope decided since. True when this call closed it; false
 * when it was already closed or is not the open hand-over.
 */
export function completeOwnerTransfer(sql: RegistrySql, scopeId: string, from: string, to: string): boolean {
  const last = lastTransfer(sql, scopeId);
  if (last?.state !== 'pending' || last.prev_principal !== from || last.principal !== to) return false;
  sql.exec(`UPDATE owner_transfer SET state = 'done' WHERE scope_id = ?`, scopeId);
  return true;
}

/**
 * Abandon the open hand-over `from → to` (#1665), staff's way out of one that can no longer
 * finish — `to` lost its login or role after step 1, so its resend is `wedged` and every other
 * hand-over `in-flight`. Closes it as `abandoned` and nothing else: no seat, no revoke, and the
 * record stays on `to`, from where staff hand over again. The original `from` keeps whatever
 * owner seat it still holds; the next owner removes it in the app.
 *
 * Only a WEDGED one: an open hand-over whose `to` still signs in and holds a role
 * (`toHoldsRole`, the host's read) answers `healthy` and changes nothing — resending it
 * finishes it. `not-open` when `from → to` is not the open hand-over.
 */
export function abandonOwnerTransfer(
  sql: RegistrySql,
  scopeId: string,
  from: string,
  to: string,
  toHoldsRole: boolean,
): OwnerTransferAbandon {
  const last = lastTransfer(sql, scopeId);
  if (last?.state !== 'pending' || last.prev_principal !== from || last.principal !== to) return 'not-open';
  if (toHoldsRole && isBound(sql, scopeId, to)) return 'healthy';
  sql.exec(`UPDATE owner_transfer SET state = 'abandoned' WHERE scope_id = ?`, scopeId);
  return 'abandoned';
}

function lastTransfer(
  sql: RegistrySql,
  scopeId: string,
): { prev_principal: string; principal: string; state: 'pending' | 'done' | 'abandoned' } | undefined {
  return [...sql.exec('SELECT prev_principal, principal, state FROM owner_transfer WHERE scope_id = ?', scopeId)][0] as
    | { prev_principal: string; principal: string; state: 'pending' | 'done' | 'abandoned' }
    | undefined;
}

/** Is some subject in this scope bound to `principal` — can anybody sign in as it? */
function isBound(sql: RegistrySql, scopeId: string, principal: string): boolean {
  return [...sql.exec('SELECT 1 FROM identity WHERE scope_id = ? AND principal = ? LIMIT 1', scopeId, principal)].length > 0;
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
 * Unbind a subject from a scope (#1670) — the removal every "remove this member" path shares,
 * and the one write that takes a binding away. True when there was one to take.
 *
 * It removes only the binding. A role the principal holds at scope level is the vertical's to
 * revoke through the kernel; without a binding no login resolves to that principal, so the
 * grant authorizes nobody. It never re-opens the owner seat: unbinding the owner leaves the
 * seat claimed and the owner of record intact, and getting back in is a claim link's job.
 */
export function unbindSubject(sql: RegistrySql, scopeId: string, sub: string): boolean {
  const had = [...sql.exec('SELECT 1 FROM identity WHERE scope_id = ? AND sub = ?', scopeId, sub)].length > 0;
  sql.exec('DELETE FROM identity WHERE scope_id = ? AND sub = ?', scopeId, sub);
  return had;
}

/** Remove every subject bound to one principal in this scope (#1939). The directory owns
 * the whole lookup, so no caller's bounded scope scan can leave a second login live.
 * Return the removed subjects so the caller can report each absent place to its issuer. */
export function unbindPrincipal(sql: RegistrySql, scopeId: string, principal: string): string[] {
  const subs = [...sql.exec(
    'SELECT sub FROM identity WHERE scope_id = ? AND principal = ? ORDER BY sub',
    scopeId,
    principal,
  )].map((r) => r.sub as string);
  sql.exec('DELETE FROM identity WHERE scope_id = ? AND principal = ?', scopeId, principal);
  return subs;
}

/**
 * The subjects bound in a scope, at most `limit`, in a stable order — the whole set a places
 * repair reports (#1670). The caller asks for one more than it will send, so it can tell a
 * scope that fits from one it must refuse rather than truncate.
 */
export function subjectsOf(sql: RegistrySql, scopeId: string, limit: number): string[] {
  return [...sql.exec('SELECT sub FROM identity WHERE scope_id = ? ORDER BY sub LIMIT ?', scopeId, limit)].map(
    (r) => r.sub as string,
  );
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
