import { entityRef, moduleManifest, permissionKey, substratError, type OrgId } from '@substrat-run/contracts';

/**
 * The conflict reasons this engine raises — its own vocabulary, narrowing the platform's
 * `conflict` code (#113). Exported so a vertical can branch on WHY a refusal happened
 * without importing this engine's types or matching on its prose; `as const` so a typo
 * is a compile error here rather than a slug nobody ever matches.
 *
 * Additive only, like every other engine surface: new reasons may appear, existing ones
 * do not change spelling.
 */
export const INVITES_CONFLICT_REASONS = [
  'open_invite_limit',
] as const;
export type InvitesConflictReason = (typeof INVITES_CONFLICT_REASONS)[number];

/** `conflict(reason, message)` — reason first, so the classification reads before the prose. */
const conflict = (reason: InvitesConflictReason, message: string) => substratError('conflict', message, { reason });


// The entity registry is PUBLIC: a vertical composing this engine needs the
// entity-type constants its relation edges name, and the row schema to declare
// an operation's output against without retyping this engine's shape.
export { invitation, invitesEntities, invitationRow } from './entities.js';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';

// ============================================================================
// The invites engine (membership.md §6; mechanics from booking-social.md
// "invite, don't search").
//
// An invitation is how a person joins an org they are not already in. The engine
// owns the state machine; it does NOT own the membership — that is tenant-wide
// directory state, effected by the connector executor (K-22 §4.2) when an invite
// is accepted. The engine's job ends at "this person said yes".
//
// Two properties do the real work, and both are easy to lose:
//
//   1. Non-enumerable. Identifiers are stored HASHED and never returned. A
//      non-member and a decline are indistinguishable to the sender, so the
//      invite surface can never answer "is this person on the platform".
//   2. Accept-required. An invitation confers nothing until the recipient acts.
//      Being invited is not a relationship.
// ============================================================================

export const INVITES_PERM = {
  send: permissionKey.parse('invites:send'),
  read: permissionKey.parse('invites:read'),
  revoke: permissionKey.parse('invites:revoke'),
};

export const invitesManifest = moduleManifest.parse({
  id: '@substrat-run/engine-invites',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'invites:send', description: 'Invite someone to an organization' },
    { key: 'invites:read', description: 'List invitations and their state' },
    { key: 'invites:revoke', description: 'Withdraw an invitation before it is accepted' },
  ],
  events: {
    emits: [
      { type: 'invites.sent', schemaVersion: 1 },
      { type: 'invites.accepted', schemaVersion: 1 },
      { type: 'invites.revoked', schemaVersion: 1 },
      // The connector seam's request (K-22 §4.2). The engine cannot write a
      // membership tuple — it is tenant-wide directory state, outside this
      // scope's transaction — so it asks, and an executor effects.
      { type: 'member.add-requested', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [],
  entitlementKey: 'invites',
  ui: {
    routes: [
      { path: 'invitations', screen: './ui/InvitationList', permission: 'invites:read' },
    ],
    nav: [
      { label: 'invites.nav', icon: 'user-plus', to: 'invitations', permission: 'invites:read' },
    ],
    entityViews: [{ entityType: 'invitation', view: './ui/InvitationCard' }],
    // No accept route, deliberately. Accepting checks no permission — the
    // invitation itself is the authority (membership.md §6) — so an accept
    // screen belongs in the host app's unauthenticated routing, outside the
    // permission-keyed shell.
  },
});

export const invitesMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE invites_invitation (
        id              TEXT PRIMARY KEY,
        org_id          TEXT NOT NULL,
        identifier_hash TEXT NOT NULL,
        role_key        TEXT NOT NULL,
        state           TEXT NOT NULL,
        invited_by      TEXT NOT NULL,
        accepted_by     TEXT,
        created_at      TEXT NOT NULL,
        expires_at      TEXT NOT NULL,
        settled_at      TEXT
      );
      CREATE INDEX invites_by_org ON invites_invitation (org_id, state);
    `,
  },
];

export type InviteState = 'invited' | 'accepted' | 'revoked' | 'expired';

export interface InvitationRow {
  id: string;
  org_id: string;
  identifier_hash: string;
  role_key: string;
  state: InviteState;
  invited_by: string;
  accepted_by: string | null;
  created_at: string;
  expires_at: string;
  settled_at: string | null;
}

/** Public shape: the hash never leaves the engine. */
export type Invitation = Omit<InvitationRow, 'identifier_hash'>;

const PUBLIC_COLUMNS =
  'id, org_id, role_key, state, invited_by, accepted_by, created_at, expires_at, settled_at';

/** How long an unaccepted invitation stands. Bounded, because a standing offer should be. */
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Open invitations one sender may hold per org — booking-social's rate limit. */
const MAX_OPEN_PER_SENDER = 25;

// Web Crypto + TextEncoder are runtime globals everywhere we run (Node >= 18,
// Workers, browsers); declared locally so the engine needs no platform types —
// the same convention engine-protocol uses for its content hash.
declare const crypto: {
  subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> };
};
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

/**
 * Hash an identifier with the scope's own salt (Web Crypto, never a node-only
 * import).
 *
 * Scope-salted deliberately. A global salt would make the same address produce the
 * same hash in every tenant, which reintroduces cross-tenant correlation through the
 * back door — the property per-tenant identity pools exist to prevent (§4.3).
 * Normalised first, so `A@b.com` and `a@b.com ` are one person.
 */
export async function hashIdentifier(scopeSalt: string, identifier: string): Promise<string> {
  const normalised = identifier.trim().toLowerCase();
  const bytes = new TextEncoder().encode(`${scopeSalt}:${normalised}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Settle this org's overdue invitations.
 *
 * Expiry is applied on read and on transition rather than by a timer: an expired
 * invitation must never be acceptable, and the only moments that matters are when
 * someone looks or someone acts. A sweep would be a second source of truth for the
 * same fact.
 */
export function expireOverdue(ctx: OperationContext, orgId: OrgId): void {
  ctx.sql.exec(
    `UPDATE invites_invitation SET state = 'expired', settled_at = ?
     WHERE org_id = ? AND state = 'invited' AND expires_at <= ?`,
    [ctx.now(), orgId, ctx.now()],
  );
}

export interface SendInviteInput {
  orgId: OrgId;
  /** Plaintext. Hashed before it touches storage, and never persisted. */
  identifier: string;
  roleKey: string;
  ttlMs?: number;
}

/**
 * Send an invitation. In-scope composition (K-16): a vertical calls this inside its
 * own operation, in the same transaction, having already checked its own permission.
 *
 * Returns only the invitation id. It deliberately does not report whether the
 * recipient already exists, is already a member, or declined before — the sender
 * learns that an invitation was recorded and nothing else. That is what keeps the
 * surface non-enumerable.
 */
export async function sendInvite(
  ctx: OperationContext,
  input: SendInviteInput,
): Promise<{ id: string }> {
  expireOverdue(ctx, input.orgId);

  const open = ctx.sql.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM invites_invitation
     WHERE org_id = ? AND invited_by = ? AND state = 'invited'`,
    [input.orgId, ctx.principal],
  );
  if ((open[0]?.n ?? 0) >= MAX_OPEN_PER_SENDER) {
    throw conflict('open_invite_limit', 
      `invite rate limit: ${MAX_OPEN_PER_SENDER} open invitations per sender per organization`,
    );
  }

  const hash = await hashIdentifier(ctx.scopeId, input.identifier);
  const existing = ctx.sql.query<{ id: string }>(
    `SELECT id FROM invites_invitation
     WHERE org_id = ? AND identifier_hash = ? AND state = 'invited'`,
    [input.orgId, hash],
  );
  // Re-inviting someone who already has an open invitation is a no-op that looks
  // exactly like a fresh send. Saying "already invited" would leak membership.
  if (existing[0]) return { id: existing[0].id };

  const id = ulid();
  const expiresAt = new Date(Date.parse(ctx.now()) + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString();
  ctx.sql.exec(
    `INSERT INTO invites_invitation
       (id, org_id, identifier_hash, role_key, state, invited_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'invited', ?, ?, ?)`,
    [id, input.orgId, hash, input.roleKey, ctx.principal, ctx.now(), expiresAt],
  );

  ctx.emit({
    type: 'invites.sent',
    schemaVersion: 1,
    entity: entityRef.parse({ entityType: 'invitation', entityId: id }),
    piiClass: 'none', // the identifier is hashed; nothing here names a person
    payload: { invitationId: id, orgId: input.orgId, roleKey: input.roleKey, expiresAt },
  });
  return { id };
}

/**
 * Accept an invitation, as the principal in `ctx` — the recipient, not the sender.
 *
 * The identifier is re-hashed and compared rather than trusted: an invitation id
 * alone must not be enough, or a leaked id would be a bearer token for someone
 * else's invitation.
 *
 * Emits `member.add-requested`. The engine does not write the membership; the
 * connector executor does (K-22 §4.2), because membership is tenant-wide directory
 * state that this transaction cannot reach atomically.
 */
export async function acceptInvite(
  ctx: OperationContext,
  input: { invitationId: string; identifier: string },
): Promise<Invitation> {
  const row = ctx.sql.query<InvitationRow>('SELECT * FROM invites_invitation WHERE id = ?', [
    input.invitationId,
  ])[0];
  // One message for every failure mode — wrong id, wrong person, already settled,
  // expired. Distinguishing them would turn this into an oracle.
  const refuse = () => new Error('invitation is not acceptable');
  if (!row || row.state !== 'invited') throw refuse();
  if (row.expires_at <= ctx.now()) {
    ctx.sql.exec(`UPDATE invites_invitation SET state = 'expired', settled_at = ? WHERE id = ?`, [
      ctx.now(),
      row.id,
    ]);
    throw refuse();
  }
  const hash = await hashIdentifier(ctx.scopeId, input.identifier);
  if (hash !== row.identifier_hash) throw refuse();

  ctx.sql.exec(
    `UPDATE invites_invitation SET state = 'accepted', accepted_by = ?, settled_at = ? WHERE id = ?`,
    [ctx.principal, ctx.now(), row.id],
  );

  ctx.emit({
    type: 'invites.accepted',
    schemaVersion: 1,
    entity: entityRef.parse({ entityType: 'invitation', entityId: row.id }),
    piiClass: 'none',
    // `principal` is who accepted — a ULID, not an identifier, so it names nobody
    // outside the platform. A vertical consuming this to create its own record
    // needs it, and without it the event describes an acceptance by no one.
    payload: {
      invitationId: row.id,
      orgId: row.org_id,
      roleKey: row.role_key,
      principal: ctx.principal,
    },
  });
  // Fat (D-19): the executor must never need a cross-module read to act.
  ctx.emit({
    type: 'member.add-requested',
    schemaVersion: 1,
    entity: entityRef.parse({ entityType: 'membership', entityId: ctx.principal }),
    piiClass: 'none',
    payload: {
      principal: ctx.principal,
      orgId: row.org_id,
      tenantId: ctx.tenantId,
      roleKey: row.role_key,
      invitationId: row.id,
    },
  });

  return ctx.sql.query<Invitation>(
    `SELECT ${PUBLIC_COLUMNS} FROM invites_invitation WHERE id = ?`,
    [row.id],
  )[0]!;
}

/** Withdraw an unaccepted invitation. Settled invitations are left alone. */
export function revokeInvite(ctx: OperationContext, invitationId: string): void {
  const changed = ctx.sql.query<{ id: string }>(
    `UPDATE invites_invitation SET state = 'revoked', settled_at = ?
     WHERE id = ? AND state = 'invited' RETURNING id`,
    [ctx.now(), invitationId],
  );
  if (!changed[0]) return; // already settled, or never existed — idempotent and silent
  ctx.emit({
    type: 'invites.revoked',
    schemaVersion: 1,
    entity: entityRef.parse({ entityType: 'invitation', entityId: invitationId }),
    piiClass: 'none',
    payload: { invitationId },
  });
}

/**
 * Invitations for an org, with state. The identifier hash is never returned — a
 * leaked hash lets its holder confirm an address offline, which is the enumeration
 * this design exists to prevent.
 */
export function listInvites(ctx: OperationContext, orgId: OrgId): Invitation[] {
  expireOverdue(ctx, orgId);
  return ctx.sql.query<Invitation>(
    `SELECT ${PUBLIC_COLUMNS} FROM invites_invitation WHERE org_id = ? ORDER BY created_at DESC`,
    [orgId],
  );
}

// -- operations: the permission check plus one exported function (D-28) -------

const sendOp: OperationHandler<SendInviteInput, { id: string }> = async (ctx, input) => {
  assertAllowed(await ctx.check(INVITES_PERM.send));
  return sendInvite(ctx, input);
};

const acceptOp: OperationHandler<{ invitationId: string; identifier: string }, Invitation> = async (
  ctx,
  input,
) => {
  // No permission check, by design: the recipient is not a member of anything yet,
  // so there is no grant they could hold. The invitation IS the authority, and it is
  // proven by re-hashing the identifier they present.
  return acceptInvite(ctx, input);
};

const listOp: OperationHandler<{ orgId: OrgId }, Invitation[]> = async (ctx, input) => {
  assertAllowed(await ctx.check(INVITES_PERM.read));
  return listInvites(ctx, input.orgId);
};

const revokeOp: OperationHandler<{ invitationId: string }, void> = async (ctx, input) => {
  assertAllowed(await ctx.check(INVITES_PERM.revoke));
  revokeInvite(ctx, input.invitationId);
};

export const invitesModule: ModuleRegistration = {
  manifest: invitesManifest,
  migrations: invitesMigrations,
  operations: {
    'invites/send': sendOp as unknown as OperationHandler<never, unknown>,
    'invites/accept': acceptOp as unknown as OperationHandler<never, unknown>,
    'invites/list': listOp as unknown as OperationHandler<never, unknown>,
    'invites/revoke': revokeOp as unknown as OperationHandler<never, unknown>,
  },
};
