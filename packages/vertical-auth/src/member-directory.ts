/**
 * The MEMBER-INVITE half of the identity directory — the `invite` table and the rows over it —
 * written as plain functions over the `exec` seam so they are tested against real SQLite
 * without a Durable Object, the way `owner-seat.ts` and `site-registry.ts` are. The IdentityDO
 * delegates every invite method here.
 *
 * An invite is a pre-minted principal + a role the inviter already granted at scope level,
 * waiting for a login to claim it by token. Only the token's HASH is stored — the token itself
 * lives in the accept link, never here, so a read of this table cannot mint access.
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
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))`,
  `CREATE INDEX IF NOT EXISTS invite_by_scope ON invite (scope_id)`,
];

/** The whole directory an invite touches: the identity (and owner-seat) tables, then the invites. */
export const MEMBER_DIRECTORY_DDL: readonly string[] = [...OWNER_SEAT_DDL, ...INVITE_DDL];

/** An outstanding invite as the directory returns it — never its token. */
export type InviteRow = { principal: string; roleKey: string; email: string | null; createdAt: number };

/** One principal as the identity directory knows it at a scope (#1150). */
export type MemberBinding = { principal: string; logins: number; email: string | null };

const inviteRowOf = (r: Record<string, unknown>): InviteRow => ({
  principal: r.principal as string,
  roleKey: r.role_key as string,
  email: (r.email as string | null) ?? null,
  createdAt: Number(r.created_at),
});

export function createInvite(
  sql: RegistrySql, scopeId: string, principal: string, roleKey: string, email: string | null, tokenHash: string,
): void {
  sql.exec(
    'INSERT INTO invite (token_hash, scope_id, principal, role_key, email) VALUES (?, ?, ?, ?, ?)',
    tokenHash, scopeId, principal, roleKey, email,
  );
}

/** The scope's outstanding (unclaimed) invites, newest first. No token. */
export function listInvites(sql: RegistrySql, scopeId: string): InviteRow[] {
  return [...sql.exec(
    'SELECT principal, role_key, email, created_at FROM invite WHERE scope_id = ? AND claimed = 0 ORDER BY created_at DESC',
    scopeId,
  )].map(inviteRowOf);
}

/** One outstanding invite by its pre-minted principal, or null (#1931). */
export function getInvite(sql: RegistrySql, scopeId: string, principal: string): InviteRow | null {
  const r = [...sql.exec(
    'SELECT principal, role_key, email, created_at FROM invite WHERE scope_id = ? AND principal = ? AND claimed = 0',
    scopeId, principal,
  )][0];
  return r ? inviteRowOf(r) : null;
}

export function inviteExists(sql: RegistrySql, scopeId: string, tokenHash: string): boolean {
  return [...sql.exec('SELECT 1 FROM invite WHERE scope_id = ? AND token_hash = ? AND claimed = 0', scopeId, tokenHash)].length > 0;
}

/** Withdraw an unclaimed invite by its pre-minted principal. */
export function revokeInvite(sql: RegistrySql, scopeId: string, principal: string): void {
  sql.exec('DELETE FROM invite WHERE scope_id = ? AND principal = ? AND claimed = 0', scopeId, principal);
}

/**
 * Claim an invite: bind the verified subject to the invite's pre-minted principal and consume
 * the invite, with no await between the read and the writes — so in the Durable Object a
 * withdrawal (`revokeInvite`) and a claim are serialized, and a claim after a withdrawal finds
 * nothing. Returns the principal, or null when no unclaimed invite matches. It writes nothing
 * to the scope: the role was granted when the invite was minted.
 */
export function claimInvite(sql: RegistrySql, scopeId: string, sub: string, tokenHash: string): string | null {
  const inv = [...sql.exec('SELECT principal FROM invite WHERE scope_id = ? AND token_hash = ? AND claimed = 0', scopeId, tokenHash)][0];
  if (!inv) return null;
  sql.exec('INSERT OR REPLACE INTO identity (scope_id, sub, principal) VALUES (?, ?, ?)', scopeId, sub, inv.principal);
  sql.exec('UPDATE invite SET claimed = 1 WHERE scope_id = ? AND token_hash = ?', scopeId, tokenHash);
  return inv.principal as string;
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
