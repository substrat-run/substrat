/**
 * The MEMBER-INVITE half of the identity directory — the `invite` table and the rows over it —
 * written as plain functions over the `exec` seam so they are tested against real SQLite
 * without a Durable Object, the way `owner-seat.ts` and `site-registry.ts` are. The IdentityDO
 * delegates every invite method here.
 *
 * An invite is a pre-minted principal + a role the inviter already granted at scope level,
 * waiting for a login to claim it by token. Only the token's HASH is stored — the token itself
 * lives in the accept link, never here, so a read of this table cannot mint access.
 *
 * Since #1686 the token is the secret of a `become` capability in the scope's own Durable
 * Object (single use, revocable, on the spine), and `capability_id` names it: the scope judges
 * the secret, this row says which capability IS the invite and which principal it seats. A row
 * with no `capability_id` is LEGACY — hash alone, as every invite was before #1686 and as
 * ticket0's own desk-invite flow still writes them — and is still redeemed the old way, by hash;
 * an invite has no expiry, so nothing ages those out (see `claimInvite`).
 */
import type { RegistrySql } from './site-registry.js';
import { OWNER_SEAT_DDL } from './owner-seat.js';

// The identity rows an invite binds into, for a host that keeps this directory outside a DO.
export { migrateOwnerSeat, unbindPrincipal } from './owner-seat.js';
export type { RegistrySql } from './site-registry.js';

export const INVITE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS invite (
    token_hash TEXT PRIMARY KEY, scope_id TEXT NOT NULL, principal TEXT NOT NULL,
    role_key TEXT NOT NULL, email TEXT, claimed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    capability_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS invite_by_scope ON invite (scope_id)`,
];

/** The whole directory an invite touches: the identity (and owner-seat) tables, then the invites. */
export const MEMBER_DIRECTORY_DDL: readonly string[] = [...OWNER_SEAT_DDL, ...INVITE_DDL];

/**
 * Bring an `invite` table from before #1686 up to date: `CREATE TABLE IF NOT EXISTS` leaves an
 * existing table alone, so a directory whose storage predates `capability_id` needs the one
 * `ALTER`, and every row it had reads as legacy (NULL). Idempotent — run it after the DDL.
 */
export function migrateInvites(sql: RegistrySql): void {
  const columns = [...sql.exec('PRAGMA table_info(invite)')].map((r) => r.name as string);
  if (!columns.includes('capability_id')) sql.exec('ALTER TABLE invite ADD COLUMN capability_id TEXT');
}

/**
 * An outstanding invite as the directory returns it — never its token. `capabilityId` names the
 * `become` capability its link is (#1686), so a list can ask the scope where that link stands;
 * null for a legacy hash-only invite.
 */
export type InviteRow = { principal: string; roleKey: string; email: string | null; createdAt: number; capabilityId: string | null };

/** One principal as the identity directory knows it at a scope (#1150). */
export type MemberBinding = { principal: string; logins: number; email: string | null };

const inviteRowOf = (r: Record<string, unknown>): InviteRow => ({
  principal: r.principal as string,
  roleKey: r.role_key as string,
  email: (r.email as string | null) ?? null,
  createdAt: Number(r.created_at),
  capabilityId: (r.capability_id as string | null) ?? null,
});

/**
 * Record an invite under its token's hash. `capabilityId` names the `become` capability whose
 * secret the token is (#1686); null writes a legacy hash-only row, which this package's own
 * invite routes no longer mint.
 */
export function createInvite(
  sql: RegistrySql, scopeId: string, principal: string, roleKey: string, email: string | null, tokenHash: string,
  capabilityId: string | null = null,
): void {
  sql.exec(
    'INSERT INTO invite (token_hash, scope_id, principal, role_key, email, capability_id) VALUES (?, ?, ?, ?, ?, ?)',
    tokenHash, scopeId, principal, roleKey, email, capabilityId,
  );
}

/** The scope's outstanding (unclaimed) invites, newest first. No token. */
export function listInvites(sql: RegistrySql, scopeId: string): InviteRow[] {
  return [...sql.exec(
    'SELECT principal, role_key, email, created_at, capability_id FROM invite WHERE scope_id = ? AND claimed = 0 ORDER BY created_at DESC',
    scopeId,
  )].map(inviteRowOf);
}

/** One outstanding invite by its pre-minted principal, or null (#1931). */
export function getInvite(sql: RegistrySql, scopeId: string, principal: string): InviteRow | null {
  const r = [...sql.exec(
    'SELECT principal, role_key, email, created_at, capability_id FROM invite WHERE scope_id = ? AND principal = ? AND claimed = 0',
    scopeId, principal,
  )][0];
  return r ? inviteRowOf(r) : null;
}

export function inviteExists(sql: RegistrySql, scopeId: string, tokenHash: string): boolean {
  return [...sql.exec('SELECT 1 FROM invite WHERE scope_id = ? AND token_hash = ? AND claimed = 0', scopeId, tokenHash)].length > 0;
}

/**
 * Withdraw an unclaimed invite by its pre-minted principal. Returns the `become` capability its
 * link was (#1686), or null for a legacy invite, or none. Deleting the row is what stops an
 * accept here; a withdrawal revokes the link in the scope BEFORE this (`inviteLink`).
 */
export function revokeInvite(sql: RegistrySql, scopeId: string, principal: string): string | null {
  const gone = [...sql.exec(
    'DELETE FROM invite WHERE scope_id = ? AND principal = ? AND claimed = 0 RETURNING capability_id',
    scopeId, principal,
  )][0];
  return (gone?.capability_id as string | null | undefined) ?? null;
}

/**
 * The `become` capability an open invite's link is (#1686), or null — a legacy invite, or none.
 * What a withdrawal revokes FIRST, while the row is still there to name it: a revoke that fails
 * leaves the row, and the retry finds the link again.
 */
export function inviteLink(sql: RegistrySql, scopeId: string, principal: string): string | null {
  const open = [...sql.exec(
    'SELECT capability_id FROM invite WHERE scope_id = ? AND principal = ? AND claimed = 0',
    scopeId, principal,
  )][0];
  return (open?.capability_id as string | null | undefined) ?? null;
}

/**
 * Is `tokenHash` an open capability-era invite here (#1686)? Asked BEFORE the secret is
 * exchanged, so a secret that is no open invite — withdrawn, already accepted, or a `become`
 * capability minted for something else — is refused without spending its use. The exchange is
 * still the authority: this only decides whether to ask it.
 */
export function inviteMatches(sql: RegistrySql, scopeId: string, tokenHash: string): boolean {
  return [...sql.exec(
    'SELECT 1 FROM invite WHERE scope_id = ? AND token_hash = ? AND claimed = 0 AND capability_id IS NOT NULL',
    scopeId, tokenHash,
  )].length > 0;
}

/**
 * Accept an invite with an exchanged `become` capability (#1686): the scope has taken the
 * capability's one use and answered the principal it becomes. Binds the subject when an open
 * invite here names that capability AND that principal, and consumes it — so a withdrawal
 * landing between the exchange and this finds nothing to bind. Null otherwise, one answer.
 */
export function claimInviteByCapability(
  sql: RegistrySql, scopeId: string, sub: string, capabilityId: string, principal: string,
): string | null {
  const inv = [...sql.exec(
    'SELECT token_hash FROM invite WHERE scope_id = ? AND capability_id = ? AND principal = ? AND claimed = 0',
    scopeId, capabilityId, principal,
  )][0];
  return inv ? bindInvite(sql, scopeId, sub, principal, inv.token_hash as string) : null;
}

/** Bind the subject to the invite's principal and consume the invite — the write both claims share. */
function bindInvite(sql: RegistrySql, scopeId: string, sub: string, principal: string, tokenHash: string): string {
  sql.exec('INSERT OR REPLACE INTO identity (scope_id, sub, principal) VALUES (?, ?, ?)', scopeId, sub, principal);
  sql.exec('UPDATE invite SET claimed = 1 WHERE scope_id = ? AND token_hash = ?', scopeId, tokenHash);
  return principal;
}

/**
 * LEGACY (#1686) — claim an invite minted before invites became `become` capabilities, by its
 * token's hash: bind the verified subject to the invite's pre-minted principal and consume the
 * invite, with no await between the read and the writes — so in the Durable Object a withdrawal
 * (`revokeInvite`) and a claim are serialized, and a claim after a withdrawal finds nothing.
 * Returns the principal, or null when no unclaimed legacy invite matches. It writes nothing to
 * the scope: the role was granted when the invite was minted.
 *
 * A capability-era row is NEVER claimed here, whatever hash is presented: its secret goes
 * through the scope's exchange (`claimInviteByCapability`), which is what spends its one use
 * and puts it on the spine. Unlike an owner claim link, a legacy invite never expires, so this
 * path cannot age out on a timer: it stays until every legacy row is accepted or withdrawn, or
 * a cut-off is decided.
 */
export function claimInvite(sql: RegistrySql, scopeId: string, sub: string, tokenHash: string): string | null {
  const inv = [...sql.exec(
    'SELECT principal FROM invite WHERE scope_id = ? AND token_hash = ? AND claimed = 0 AND capability_id IS NULL',
    scopeId, tokenHash,
  )][0];
  return inv ? bindInvite(sql, scopeId, sub, inv.principal as string, tokenHash) : null;
}

/**
 * Who this directory knows at the scope, by principal (#1150): how many subjects are bound to
 * each, and the address an invite to it named — the identity half of the dashboard's member
 * roster. The role half is the scope's own (`listScopeRoleHolders`). One scope, never a walk.
 */
export function listMemberBindings(sql: RegistrySql, scopeId: string): MemberBinding[] {
  return [...sql.exec(
    `SELECT principal, SUM(login) AS logins, MAX(email) AS email FROM (
       SELECT principal, 1 AS login, NULL AS email FROM identity WHERE scope_id = ?
       UNION ALL
       SELECT principal, 0 AS login, email FROM invite WHERE scope_id = ?
     ) GROUP BY principal ORDER BY principal`,
    scopeId, scopeId,
  )].map((r) => ({
    principal: r.principal as string,
    logins: Number(r.logins),
    email: (r.email as string | null) ?? null,
  }));
}
