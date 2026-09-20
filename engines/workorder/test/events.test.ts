/**
 * #696 — engine-workorder's published event contract, as a compile-time suite.
 *
 * THIS FILE IS THE GATE. `WorkorderEvents` is types only, so nothing at runtime
 * can tell an enforced constraint from a decorative one: a type-level check
 * fails *permissively*, and a map that has quietly stopped biting compiles
 * exactly like one that still does. Every `@ts-expect-error` below is therefore
 * load-bearing in the inverted direction — if a check stops being enforced,
 * `tsc` reports "Unused '@ts-expect-error' directive" and
 * `pnpm --filter @substrat-run/engine-workorder typecheck` goes red.
 *
 * Each negative has a POSITIVE TWIN through the same path. A negative on its own
 * proves nothing: delete the mechanism and "wrong shape is rejected" and "right
 * shape is accepted" both pass, because nothing is left to accept anything.
 */
import { describe, expect, it } from 'vitest';
import type { DataSubjectId } from '@substrat-run/contracts';
import { consumersFor, type OperationContext } from '@substrat-run/kernel';

import { emitWorkorderEvent } from '../src/events.js';
/**
 * The PUBLIC surface, imported the way a vertical imports it — from the package
 * root, not from `src/events.ts`. Everything below is checked through these, so
 * a name missing or mistyped in `src/index.ts` fails here instead of leaving
 * every gate green while the documented import breaks.
 */
import type {
  WorkorderEvents,
  WorkorderEventType,
  WorkorderCreatedPayload,
  WorkorderAssignedPayload,
  WorkorderStartedPayload,
  WorkorderTimeReportedPayload,
  WorkorderMaterialReportedPayload,
  WorkorderCompletedPayload,
  WorkorderClosedPayload,
} from '../src/index.js';

/** Every published name, referenced — an absent re-export cannot compile. */
type _PublishedSurface = [
  WorkorderEvents extends never ? never : true,
  WorkorderEventType extends never ? never : true,
  WorkorderCreatedPayload extends never ? never : true,
  WorkorderAssignedPayload extends never ? never : true,
  WorkorderStartedPayload extends never ? never : true,
  WorkorderTimeReportedPayload extends never ? never : true,
  WorkorderMaterialReportedPayload extends never ? never : true,
  WorkorderCompletedPayload extends never ? never : true,
  WorkorderClosedPayload extends never ? never : true,
];

// ===========================================================================
// THE CONSUMING SIDE — what a vertical gets.
// ===========================================================================

// --- positive twin: declared keys, typed payloads ---------------------------
const wellFormed = consumersFor<[WorkorderEvents]>()({
  'workorder.completed': async (_ctx, event) => {
    // `total` is a Money object and `billable` an array — no cast, no guessing.
    void event.payload.total.currency;
    void event.payload.billable.length;
  },
  'workorder.closed': async (_ctx, event) => {
    void event.payload.orderId;
  },
});

// --- an event type this engine does not emit -------------------------------
consumersFor<[WorkorderEvents]>()({
  'workorder.completed': async () => {},
  // @ts-expect-error engine-workorder emits no 'workorder.invoiced' — that is invoicing's
  'workorder.invoiced': async () => {},
});

// --- a payload field the producer does not send -----------------------------
consumersFor<[WorkorderEvents]>()({
  'workorder.completed': async (_ctx, event) => {
    // @ts-expect-error the completion payload carries no 'invoiceId'
    void event.payload.invoiceId;
  },
});

// --- the payloads are genuinely different from one another ------------------
consumersFor<[WorkorderEvents]>()({
  'workorder.time-reported': async (_ctx, event) => {
    const hours: string = event.payload.hours; // accepted — decimals are strings (K-14)
    void hours;
    // @ts-expect-error 'article' is on the MATERIAL payload only
    void event.payload.article;
  },
});

// ---------------------------------------------------------------------------
// NO COMPLETION GROUP, on purpose. These seven events are seven distinct facts
// about one order, not one fact arriving by several routes, so handling exactly
// one of them is legitimate and must stay legitimate. This is the positive twin
// for engine-protocol's completion-group negative — the constraint is real
// there BECAUSE it is absent here.
// ---------------------------------------------------------------------------
consumersFor<[WorkorderEvents]>()({
  'workorder.completed': async () => {},
});

// ===========================================================================
// THE EMITTING SIDE — what keeps the map from rotting into a lie.
//
// Never called: these are assertions for `tsc`, and `ctx` is a parameter rather
// than a fabricated value so nothing here can run by accident.
// ===========================================================================

function _emitSiteChecks(
  ctx: OperationContext,
  completed: WorkorderCompletedPayload,
  technician: DataSubjectId,
): void {
  // --- positive twin: the declared types, accepted --------------------------
  emitWorkorderEvent(ctx, {
    type: 'workorder.completed',
    schemaVersion: 1,
    entity: { entityType: 'workorder', entityId: '01J' },
    piiClass: 'none',
    payload: completed,
  });

  emitWorkorderEvent(ctx, {
    type: 'workorder.assigned',
    schemaVersion: 1,
    entity: { entityType: 'workorder', entityId: '01J' },
    piiClass: 'pseudonymous',
    subjectId: technician,
    payload: { orderId: '01J', technician: 'p1' },
  });

  // --- an event type the map does not declare -------------------------------
  emitWorkorderEvent(ctx, {
    // @ts-expect-error engine-workorder declares no 'workorder.cancelled'
    type: 'workorder.cancelled',
    schemaVersion: 1,
    entity: { entityType: 'workorder', entityId: '01J' },
    piiClass: 'none',
    payload: { orderId: '01J' },
  });

  // --- a payload field the map does not declare -----------------------------
  emitWorkorderEvent(ctx, {
    type: 'workorder.closed',
    schemaVersion: 1,
    entity: { entityType: 'workorder', entityId: '01J' },
    piiClass: 'none',
    // @ts-expect-error 'closedBy' is not on WorkorderClosedPayload
    payload: { orderId: '01J', closedBy: 'p1' },
  });

  // --- a payload field the map declares and the emit drops ------------------
  emitWorkorderEvent(ctx, {
    type: 'workorder.time-reported',
    schemaVersion: 1,
    entity: { entityType: 'workorder', entityId: '01J' },
    piiClass: 'none',
    // @ts-expect-error 'hours' is required on WorkorderTimeReportedPayload
    payload: { orderId: '01J', entryId: '01K' },
  });

  // --- a decimal handed over as a number ------------------------------------
  emitWorkorderEvent(ctx, {
    type: 'workorder.time-reported',
    schemaVersion: 1,
    entity: { entityType: 'workorder', entityId: '01J' },
    piiClass: 'none',
    // @ts-expect-error money and decimals are strings, never floats (K-14)
    payload: { orderId: '01J', entryId: '01K', hours: 2.5 },
  });
}
void _emitSiteChecks;

describe('#696 engine-workorder event contract', () => {
  it('is a pass-through at runtime — types only', () => {
    const emitted: unknown[] = [];
    const ctx = { emit: (event: unknown) => emitted.push(event) } as unknown as OperationContext;
    emitWorkorderEvent(ctx, {
      type: 'workorder.closed',
      schemaVersion: 1,
      entity: { entityType: 'workorder', entityId: '01J' },
      piiClass: 'none',
      payload: { orderId: '01J' },
    });
    expect(emitted).toEqual([
      {
        type: 'workorder.closed',
        schemaVersion: 1,
        entity: { entityType: 'workorder', entityId: '01J' },
        piiClass: 'none',
        payload: { orderId: '01J' },
      },
    ]);
  });

  it('hands a vertical back exactly the handlers it wrote', () => {
    expect(Object.keys(wellFormed).sort()).toEqual(['workorder.closed', 'workorder.completed']);
  });
});
