/**
 * #696 — engine-protocol's published event contract, as a compile-time suite.
 *
 * THIS FILE IS THE GATE. `ProtocolEvents` is types only, so nothing at runtime
 * can tell an enforced constraint from a decorative one: a type-level check
 * fails *permissively*, and a map that has quietly stopped biting compiles
 * exactly like one that still does. Every `@ts-expect-error` below is therefore
 * load-bearing in the inverted direction — if a check stops being enforced,
 * `tsc` reports "Unused '@ts-expect-error' directive" and
 * `pnpm --filter @substrat-run/engine-protocol typecheck` goes red.
 *
 * Each negative has a POSITIVE TWIN through the same path. A negative on its own
 * proves nothing: delete the mechanism and "wrong shape is rejected" and "right
 * shape is accepted" both pass, because nothing is left to accept anything.
 *
 * The runtime assertions are deliberately thin — `emitProtocolEvent` forwards to
 * `ctx.emit` unchanged and there is no behaviour here to test.
 */
import { describe, expect, it } from 'vitest';
import type { DataSubjectId } from '@substrat-run/contracts';
import { consumersFor, type OperationContext } from '@substrat-run/kernel';

import { emitProtocolEvent } from '../src/events.js';
/**
 * The PUBLIC surface, imported the way a vertical imports it — from the package
 * root, not from `src/events.ts`. Everything below is checked through these, so
 * a name missing or mistyped in `src/index.ts` fails here instead of leaving
 * every gate green while the documented import breaks.
 */
import type {
  ProtocolEvents,
  ProtocolEventType,
  ProtocolSubjectRef,
  ProtocolInstantiatedPayload,
  ProtocolResponseRecordedPayload,
  ProtocolContentBoundPayload,
  ProtocolRequestedParty,
  ProtocolSignaturesRequestedPayload,
  ProtocolSignatureDeclinedPayload,
  ProtocolSignaturesCancelledPayload,
  ProtocolSignatureBase,
  ProtocolSignedPayload,
  ProtocolCountersignedPayload,
  ProtocolVoidedPayload,
} from '../src/index.js';

/** Every published name, referenced — an absent re-export cannot compile. */
type _PublishedSurface = [
  ProtocolEvents extends never ? never : true,
  ProtocolEventType extends never ? never : true,
  ProtocolSubjectRef extends never ? never : true,
  ProtocolInstantiatedPayload extends never ? never : true,
  ProtocolResponseRecordedPayload extends never ? never : true,
  ProtocolContentBoundPayload extends never ? never : true,
  ProtocolRequestedParty extends never ? never : true,
  ProtocolSignaturesRequestedPayload extends never ? never : true,
  ProtocolSignatureDeclinedPayload extends never ? never : true,
  ProtocolSignaturesCancelledPayload extends never ? never : true,
  ProtocolSignatureBase extends never ? never : true,
  ProtocolSignedPayload extends never ? never : true,
  ProtocolCountersignedPayload extends never ? never : true,
  ProtocolVoidedPayload extends never ? never : true,
];

// A contract is a type, never a value — nothing in `events.ts` exists at runtime.
type _AssertContractShape = ProtocolEvents extends {
  events: Record<string, unknown>;
  completionGroups?: Record<string, string>;
}
  ? true
  : never;
const _contractShape: _AssertContractShape = true;
void _contractShape;

// ===========================================================================
// THE CONSUMING SIDE — what a vertical gets.
// ===========================================================================

// --- positive twin: the full completion group, with typed payloads ----------
const wellFormed = consumersFor<[ProtocolEvents]>()({
  'protocol.signed': async (_ctx, event) => {
    // `complete` is boolean and `signedBy` is string — no cast, no guessing.
    if (event.payload.complete) void event.payload.signedBy.length;
  },
  'protocol.countersigned': async (_ctx, event) => {
    // On THIS event `signedBy` is nullable and the party who just signed is elsewhere.
    if (event.payload.complete) void event.payload.countersignedBy.length;
  },
});

// ---------------------------------------------------------------------------
// THE PRODUCTION DEFECT. A vertical consumed `protocol.signed` and not
// `protocol.countersigned`. Completion rides on whoever signs LAST, so a
// two-party contract completes as a COUNTERSIGNATURE — and every multi-party
// contract stayed `pending` for ever while the engine held it `signed`.
// `completionGroups` is what turns that into a compile error naming the miss.
// ---------------------------------------------------------------------------
consumersFor<[ProtocolEvents]>()(
  // @ts-expect-error 'protocol.countersigned' is missing — same completion group
  {
    'protocol.signed': async (_ctx, event) => {
      void event.payload.complete;
    },
  },
);

// --- an event type this engine does not emit -------------------------------
consumersFor<[ProtocolEvents]>()({
  'protocol.signed': async () => {},
  'protocol.countersigned': async () => {},
  // @ts-expect-error engine-protocol emits no 'protocol.signed-maybe'
  'protocol.signed-maybe': async () => {},
});

// --- a payload field the producer does not send -----------------------------
consumersFor<[ProtocolEvents]>()({
  'protocol.signed': async (_ctx, event) => {
    // @ts-expect-error 'countersignedBy' is on the COUNTERSIGNED payload only
    void event.payload.countersignedBy;
  },
  'protocol.countersigned': async () => {},
});

// --- the two completion payloads are genuinely different types --------------
// The 2026-08-16 correction: collapsing them into one shared type would hide
// exactly the confusion the split exists to prevent.
consumersFor<[ProtocolEvents]>()({
  'protocol.signed': async () => {},
  'protocol.countersigned': async (_ctx, event) => {
    const signer: string = event.payload.countersignedBy; // accepted
    void signer;
    // @ts-expect-error on this event `signedBy` is `string | null`
    const primary: string = event.payload.signedBy;
    void primary;
  },
});

// --- a non-completion event stands alone ------------------------------------
// The group demands companions; an event outside every group does not, or the
// check would be indistinguishable from "handle everything or nothing".
consumersFor<[ProtocolEvents]>()({
  'protocol.voided': async (_ctx, event) => {
    void event.payload.previousStatus;
  },
});

// ===========================================================================
// THE EMITTING SIDE — what keeps the map from rotting into a lie.
//
// Never called: these are assertions for `tsc`, and `ctx` is a parameter rather
// than a fabricated value so nothing here can run by accident.
// ===========================================================================

function _emitSiteChecks(
  ctx: OperationContext,
  payload: ProtocolSignedPayload,
  subjectId: DataSubjectId,
): void {
  const voided = {
    instanceId: '01J',
    entity: { entityType: 'workorder', entityId: '01K' },
    previousStatus: 'open',
    reason: 'superseded',
  } as const;

  // --- positive twin: the declared type, accepted ---------------------------
  emitProtocolEvent(ctx, {
    type: 'protocol.signed',
    schemaVersion: 1,
    entity: { entityType: 'protocol', entityId: '01J' },
    piiClass: 'pseudonymous',
    subjectId,
    payload,
  });

  emitProtocolEvent(ctx, {
    type: 'protocol.voided',
    schemaVersion: 1,
    entity: { entityType: 'protocol', entityId: '01J' },
    piiClass: 'none',
    payload: voided,
  });

  // --- an event type the map does not declare -------------------------------
  // The payload is a valid one, so the only thing left to fail is the key.
  emitProtocolEvent(ctx, {
    // @ts-expect-error engine-protocol declares no 'protocol.finished'
    type: 'protocol.finished',
    schemaVersion: 1,
    entity: { entityType: 'protocol', entityId: '01J' },
    piiClass: 'none',
    payload: voided,
  });

  // --- a payload field the map does not declare -----------------------------
  emitProtocolEvent(ctx, {
    type: 'protocol.voided',
    schemaVersion: 1,
    entity: { entityType: 'protocol', entityId: '01J' },
    piiClass: 'none',
    // @ts-expect-error 'supersededBy' is not on ProtocolVoidedPayload
    payload: { instanceId: '01J', entity: { entityType: 'workorder', entityId: '01K' }, previousStatus: 'open', reason: 'x', supersededBy: '01M' },
  });

  // --- a payload field the map declares and the emit drops ------------------
  emitProtocolEvent(ctx, {
    type: 'protocol.voided',
    schemaVersion: 1,
    entity: { entityType: 'protocol', entityId: '01J' },
    piiClass: 'none',
    // @ts-expect-error 'reason' is required on ProtocolVoidedPayload
    payload: { instanceId: '01J', entity: { entityType: 'workorder', entityId: '01K' }, previousStatus: 'open' },
  });

  // --- the right payload under the wrong key --------------------------------
  emitProtocolEvent(ctx, {
    type: 'protocol.countersigned',
    schemaVersion: 1,
    entity: { entityType: 'protocol', entityId: '01J' },
    piiClass: 'pseudonymous',
    subjectId,
    // @ts-expect-error a ProtocolSignedPayload is not a ProtocolCountersignedPayload
    payload,
  });
}
void _emitSiteChecks;

// The countersigned payload is the signed one plus three fields, so it goes the
// other way round — the positive twin for the negative just above.
function _countersignedIsASupersetOfSigned(payload: ProtocolCountersignedPayload): ProtocolSignedPayload {
  // @ts-expect-error `signedBy` is nullable here and not there — a superset in fields, not in types
  return payload;
}
void _countersignedIsASupersetOfSigned;

describe('#696 engine-protocol event contract', () => {
  it('is a pass-through at runtime — types only', () => {
    const emitted: unknown[] = [];
    const ctx = { emit: (event: unknown) => emitted.push(event) } as unknown as OperationContext;
    emitProtocolEvent(ctx, {
      type: 'protocol.voided',
      schemaVersion: 1,
      entity: { entityType: 'protocol', entityId: '01J' },
      piiClass: 'none',
      payload: { instanceId: '01J', entity: { entityType: 'workorder', entityId: '01K' }, previousStatus: 'signed', reason: 'superseded' },
    });
    expect(emitted).toEqual([
      {
        type: 'protocol.voided',
        schemaVersion: 1,
        entity: { entityType: 'protocol', entityId: '01J' },
        piiClass: 'none',
        payload: { instanceId: '01J', entity: { entityType: 'workorder', entityId: '01K' }, previousStatus: 'signed', reason: 'superseded' },
      },
    ]);
  });

  it('hands a vertical back exactly the handlers it wrote', () => {
    expect(Object.keys(wellFormed).sort()).toEqual(['protocol.countersigned', 'protocol.signed']);
  });
});
