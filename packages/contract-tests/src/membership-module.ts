import { moduleManifest, type PermissionKey } from '@substrat-run/contracts';
import type { ModuleRegistration, OperationContext, OperationHandler } from '@substrat-run/kernel';

/**
 * The requests the membership executor consumes (#1184), in engine-invites' event shapes and
 * nothing more: `invites.sent` under the inviter, then `invites.accepted` and
 * `member.add-requested` under the joiner, in the accept's own transaction; and
 * `member.remove-requested` under whoever removes. The executor's
 * contract is the events, so the suite holds it to the events, and `invitefix/request`
 * emits a bare request with whatever payload a test hands it, for the forgeries.
 *
 * No permission checks: the suite is about what the EXECUTOR lets through, and a fixture
 * that refused at send would hide exactly the escalation it must refuse.
 */

export const INVITEFIX_A = 'invitefix:a' as PermissionKey;
export const INVITEFIX_B = 'invitefix:b' as PermissionKey;

const membershipFixtureManifest = moduleManifest.parse({
  id: '@test/invitefix',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [
    { key: INVITEFIX_A, description: 'the lesser permission' },
    { key: INVITEFIX_B, description: 'the one only a lead holds' },
  ],
  events: {
    emits: [
      { type: 'invites.sent', schemaVersion: 1 },
      { type: 'invites.accepted', schemaVersion: 1 },
      { type: 'member.add-requested', schemaVersion: 1 },
      { type: 'member.remove-requested', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'invitefix',
});

interface Invitation {
  invitationId: string;
  orgId: string;
  roleKey: string;
}

const invitation = (id: string) => ({ entityType: 'invitation', entityId: id });

/** The acceptance and the request it carries, in either order (`requestFirst` is the forgery). */
const accept = (ctx: OperationContext, input: Invitation, requestFirst = false): void => {
  ctx.sql.exec('INSERT INTO invitefix_accepts (invitation_id, principal) VALUES (?, ?)', [
    input.invitationId,
    ctx.principal,
  ]);
  const accepted = () =>
    ctx.emit({
      type: 'invites.accepted',
      schemaVersion: 1,
      entity: invitation(input.invitationId),
      piiClass: 'none',
      payload: { ...input, principal: ctx.principal },
    });
  const request = () =>
    ctx.emit({
      type: 'member.add-requested',
      schemaVersion: 1,
      entity: { entityType: 'membership', entityId: ctx.principal },
      piiClass: 'none',
      payload: { principal: ctx.principal, orgId: input.orgId, tenantId: ctx.tenantId, roleKey: input.roleKey, invitationId: input.invitationId },
    });
  if (requestFirst) {
    request();
    accepted();
  } else {
    accepted();
    request();
  }
};

export const membershipFixtureMod: ModuleRegistration = {
  manifest: membershipFixtureManifest,
  migrations: [
    {
      version: '0001-init',
      sql: 'CREATE TABLE invitefix_accepts (invitation_id TEXT NOT NULL, principal TEXT NOT NULL)',
    },
  ],
  operations: {
    'invitefix/send': ((ctx: OperationContext, input: Invitation) => {
      ctx.emit({
        type: 'invites.sent',
        schemaVersion: 1,
        entity: invitation(input.invitationId),
        piiClass: 'none',
        payload: { ...input, expiresAt: ctx.now() },
      });
    }) as unknown as OperationHandler<never, unknown>,
    'invitefix/accept': ((ctx: OperationContext, input: Invitation) => accept(ctx, input)) as unknown as OperationHandler<never, unknown>,
    /** The request emitted BEFORE the acceptance it claims — a request no acceptance preceded. */
    'invitefix/accept-request-first': ((ctx: OperationContext, input: Invitation) => accept(ctx, input, true)) as unknown as OperationHandler<never, unknown>,
    /** The accept, then a failure: the property the seam is chosen for is that nothing survives. */
    'invitefix/accept-and-throw': ((ctx: OperationContext, input: Invitation) => {
      accept(ctx, input);
      throw new Error('deliberate failure after accept');
    }) as unknown as OperationHandler<never, unknown>,
    /** A bare request, payload verbatim — what a module could emit without the engine. */
    'invitefix/request': ((ctx: OperationContext, input: { entityId: string; payload: unknown }) => {
      ctx.emit({
        type: 'member.add-requested',
        schemaVersion: 1,
        entity: { entityType: 'membership', entityId: input.entityId },
        piiClass: 'none',
        payload: input.payload,
      });
    }) as unknown as OperationHandler<never, unknown>,
    /** An acceptance whose payload names whoever the test says — the actor stays the caller. */
    'invitefix/claim-accepted': ((ctx: OperationContext, input: Invitation & { principal: string }) => {
      ctx.emit({
        type: 'invites.accepted',
        schemaVersion: 1,
        entity: invitation(input.invitationId),
        piiClass: 'none',
        payload: input,
      });
    }) as unknown as OperationHandler<never, unknown>,
    /** Ask for `principal` to be taken out of `orgId` and `roleKey` — as the caller. */
    'invitefix/remove': ((ctx: OperationContext, input: { principal: string; orgId: string; roleKey: string }) => {
      ctx.emit({
        type: 'member.remove-requested',
        schemaVersion: 1,
        entity: { entityType: 'membership', entityId: input.principal },
        piiClass: 'none',
        payload: { ...input, tenantId: ctx.tenantId },
      });
    }) as unknown as OperationHandler<never, unknown>,
    /** Whether the caller holds `permission` at this scope — the effect, observed. */
    'invitefix/probe': (async (ctx: OperationContext, input: { permission: PermissionKey }) => ({
      allowed: (await ctx.check(input.permission)).allowed,
    })) as unknown as OperationHandler<never, unknown>,
  },
};
