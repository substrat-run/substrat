/**
 * #696 — engine-invites' published event contract, as a compile-time suite.
 *
 * THIS FILE IS THE GATE. `InvitesEvents` is types only, so nothing at runtime
 * can tell an enforced constraint from a decorative one: a type-level check
 * fails *permissively*, and a map that has quietly stopped biting compiles
 * exactly like one that still does. Every `@ts-expect-error` below is therefore
 * load-bearing in the inverted direction — if a check stops being enforced,
 * `tsc` reports "Unused '@ts-expect-error' directive" and
 * `pnpm --filter @substrat-run/engine-invites typecheck` goes red.
 *
 * Each negative has a POSITIVE TWIN through the same path. A negative on its own
 * proves nothing: delete the mechanism and "wrong shape is rejected" and "right
 * shape is accepted" both pass, because nothing is left to accept anything.
 */
import { describe, expect, it } from 'vitest';
import { consumersFor, type OperationContext } from '@substrat-run/kernel';

import { emitInvitesEvent } from '../src/events.js';
/**
 * The PUBLIC surface, imported the way a vertical imports it — from the package
 * root, not from `src/events.ts`. Everything below is checked through these, so
 * a name missing or mistyped in `src/index.ts` fails here instead of leaving
 * every gate green while the documented import breaks.
 */
import type {
  InvitesEvents,
  InvitesEventType,
  InvitesSentPayload,
  InvitesAcceptedPayload,
  InvitesRevokedPayload,
  MemberAddRequestedPayload,
} from '../src/index.js';

/** Every published name, referenced — an absent re-export cannot compile. */
type _PublishedSurface = [
  InvitesEvents extends never ? never : true,
  InvitesEventType extends never ? never : true,
  InvitesSentPayload extends never ? never : true,
  InvitesAcceptedPayload extends never ? never : true,
  InvitesRevokedPayload extends never ? never : true,
  MemberAddRequestedPayload extends never ? never : true,
];

// ===========================================================================
// THE CONSUMING SIDE — what a vertical gets.
// ===========================================================================

// --- positive twin: declared keys, typed payloads ---------------------------
const wellFormed = consumersFor<[InvitesEvents]>()({
  'invites.accepted': async (_ctx, event) => {
    // `principal` is a ULID, not an identifier — a vertical creating its own
    // record needs it, and without it the event describes an acceptance by no one.
    void event.payload.principal;
    void event.payload.roleKey;
  },
  'member.add-requested': async (_ctx, event) => {
    // Fat (D-19): the tenant is on the payload so an executor needs no read.
    void event.payload.tenantId;
  },
});

// --- an event type this engine does not emit -------------------------------
consumersFor<[InvitesEvents]>()({
  'invites.sent': async () => {},
  // @ts-expect-error engine-invites emits no 'invites.declined'
  'invites.declined': async () => {},
});

// ---------------------------------------------------------------------------
// THE INVARIANT THE TYPES CARRY. Every payload is `piiClass: 'none'` and that is
// a claim about the FIELDS: the invited identifier is hashed before it touches
// storage and appears on no event, which is what keeps this surface
// non-enumerable. A consumer reaching for an address must not compile.
// ---------------------------------------------------------------------------
consumersFor<[InvitesEvents]>()({
  'invites.sent': async (_ctx, event) => {
    const org: string = event.payload.orgId; // accepted — an org names nobody
    void org;
    // @ts-expect-error the invited identifier is hashed and never published
    void event.payload.identifier;
  },
});

// --- the two events emitted by one call still stand alone --------------------
// `invites.accepted` and `member.add-requested` come out of the same call but
// report two facts to two readers, so there is no completion group and handling
// exactly one must stay legitimate — see `src/events.ts`.
consumersFor<[InvitesEvents]>()({
  'invites.accepted': async () => {},
});

// ===========================================================================
// THE EMITTING SIDE — what keeps the map from rotting into a lie.
//
// Never called: these are assertions for `tsc`, and `ctx` is a parameter rather
// than a fabricated value so nothing here can run by accident.
// ===========================================================================

function _emitSiteChecks(ctx: OperationContext): void {
  // --- positive twin: the declared types, accepted --------------------------
  emitInvitesEvent(ctx, {
    type: 'invites.sent',
    schemaVersion: 1,
    entity: { entityType: 'invitation', entityId: '01J' },
    piiClass: 'none',
    payload: { invitationId: '01J', orgId: '01K', roleKey: 'member', expiresAt: '2026-09-27T00:00:00.000Z' },
  });

  emitInvitesEvent(ctx, {
    type: 'member.add-requested',
    schemaVersion: 1,
    entity: { entityType: 'membership', entityId: '01M' },
    piiClass: 'none',
    payload: { principal: '01M', orgId: '01K', tenantId: '01T', roleKey: 'member', invitationId: '01J' },
  });

  // --- an event type the map does not declare -------------------------------
  emitInvitesEvent(ctx, {
    // @ts-expect-error engine-invites declares no 'invites.expired'
    type: 'invites.expired',
    schemaVersion: 1,
    entity: { entityType: 'invitation', entityId: '01J' },
    piiClass: 'none',
    payload: { invitationId: '01J' },
  });

  // --- a payload field the map does not declare -----------------------------
  // This one is load-bearing beyond tidiness: putting the address back on the
  // event is how the non-enumerable surface would quietly stop being one.
  emitInvitesEvent(ctx, {
    type: 'invites.sent',
    schemaVersion: 1,
    entity: { entityType: 'invitation', entityId: '01J' },
    piiClass: 'none',
    // @ts-expect-error the identifier is hashed before storage and is on no event
    payload: { invitationId: '01J', orgId: '01K', roleKey: 'member', expiresAt: '2026-09-27T00:00:00.000Z', identifier: 'a@example.com' },
  });

  // --- a payload field the map declares and the emit drops ------------------
  emitInvitesEvent(ctx, {
    type: 'member.add-requested',
    schemaVersion: 1,
    entity: { entityType: 'membership', entityId: '01M' },
    piiClass: 'none',
    // @ts-expect-error 'tenantId' is required — an executor outside the scope needs it
    payload: { principal: '01M', orgId: '01K', roleKey: 'member', invitationId: '01J' },
  });
}
void _emitSiteChecks;

describe('#696 engine-invites event contract', () => {
  it('is a pass-through at runtime — types only', () => {
    const emitted: unknown[] = [];
    const ctx = { emit: (event: unknown) => emitted.push(event) } as unknown as OperationContext;
    emitInvitesEvent(ctx, {
      type: 'invites.revoked',
      schemaVersion: 1,
      entity: { entityType: 'invitation', entityId: '01J' },
      piiClass: 'none',
      payload: { invitationId: '01J' },
    });
    expect(emitted).toEqual([
      {
        type: 'invites.revoked',
        schemaVersion: 1,
        entity: { entityType: 'invitation', entityId: '01J' },
        piiClass: 'none',
        payload: { invitationId: '01J' },
      },
    ]);
  });

  it('hands a vertical back exactly the handlers it wrote', () => {
    expect(Object.keys(wellFormed).sort()).toEqual(['invites.accepted', 'member.add-requested']);
  });
});
