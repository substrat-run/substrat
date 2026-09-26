/**
 * #696 — engine-absence' published event contract, as a compile-time suite.
 *
 * THIS FILE IS THE GATE. `AbsenceEvents` is types only, so nothing at runtime
 * can tell an enforced constraint from a decorative one: a type-level check
 * fails *permissively*, and a map that has quietly stopped biting compiles
 * exactly like one that still does. Every `@ts-expect-error` below is therefore
 * load-bearing in the inverted direction — if a check stops being enforced,
 * `tsc` reports "Unused '@ts-expect-error' directive" and
 * `pnpm --filter @substrat-run/engine-absence typecheck` goes red.
 *
 * Each negative has a POSITIVE TWIN through the same path. A negative on its own
 * proves nothing: delete the mechanism and "wrong shape is rejected" and "right
 * shape is accepted" both pass, because nothing is left to accept anything.
 */
import { describe, expect, it } from 'vitest';
import type { DataSubjectId } from '@substrat-run/contracts';
import { consumersFor, type OperationContext } from '@substrat-run/kernel';

import { emitAbsenceEvent } from '../src/events.js';
/**
 * The PUBLIC surface, imported the way a vertical imports it — from the package
 * root, not from `src/events.ts`. Everything below is checked through these, so
 * a name missing or mistyped in `src/index.ts` fails here instead of leaving
 * every gate green while the documented import breaks.
 */
import type {
  AbsenceEvents,
  AbsenceEventType,
  AbsenceSubjectRef,
  AbsenceLeaveTypeConfiguredPayload,
  AbsenceEntryRecordedPayload,
  AbsenceRequestedPayload,
  AbsenceApprovedPayload,
  AbsenceRejectedPayload,
  AbsenceDecidedPayload,
  AbsenceCancelledPayload,
  AbsenceExpiredPayload,
} from '../src/index.js';

/** Every published name, referenced — an absent re-export cannot compile. */
type _PublishedSurface = [
  AbsenceEvents extends never ? never : true,
  AbsenceEventType extends never ? never : true,
  AbsenceSubjectRef extends never ? never : true,
  AbsenceLeaveTypeConfiguredPayload extends never ? never : true,
  AbsenceEntryRecordedPayload extends never ? never : true,
  AbsenceRequestedPayload extends never ? never : true,
  AbsenceApprovedPayload extends never ? never : true,
  AbsenceRejectedPayload extends never ? never : true,
  AbsenceDecidedPayload extends never ? never : true,
  AbsenceCancelledPayload extends never ? never : true,
  AbsenceExpiredPayload extends never ? never : true,
];

// ===========================================================================
// THE CONSUMING SIDE — what a vertical gets.
// ===========================================================================

// --- positive twin: the full completion group, with typed payloads ----------
const wellFormed = consumersFor<[AbsenceEvents]>()({
  'absence.cancelled': async (_ctx, event) => {
    // Cancelling an APPROVED request writes a compensating reversal; a pending
    // one touches no ledger and reports null. The type makes that decidable.
    if (event.payload.priorStatus === 'approved') void event.payload.reversalId;
  },
  'absence.expired': async (_ctx, event) => {
    void event.payload.startDate;
  },
});

// ---------------------------------------------------------------------------
// THE DEFECT THIS ENGINE WOULD HAVE HAD. `cancelAbsence` and
// `expireStaleRequests` both write `status = 'cancelled'` and emit DIFFERENT
// event types. A consumer handling `absence.cancelled` alone looks right in
// every hand-written test and strands every auto-expired request in production,
// where the date-triggered sweep (#383) is the only route that fires.
// ---------------------------------------------------------------------------
consumersFor<[AbsenceEvents]>()(
  // @ts-expect-error 'absence.expired' is missing — same completion group
  {
    'absence.cancelled': async (_ctx, event) => {
      void event.payload.requestId;
    },
  },
);

// --- and the other way round, which is just as wrong ------------------------
consumersFor<[AbsenceEvents]>()(
  // @ts-expect-error 'absence.cancelled' is missing — same completion group
  {
    'absence.expired': async (_ctx, event) => {
      void event.payload.requestId;
    },
  },
);

// --- an event type this engine does not emit -------------------------------
consumersFor<[AbsenceEvents]>()({
  'absence.requested': async () => {},
  // @ts-expect-error engine-absence emits no 'absence.approved' — it is 'absence.decided'
  'absence.approved': async () => {},
});

// --- the decision payload is a UNION, and reading it flat is the bug --------
consumersFor<[AbsenceEvents]>()({
  'absence.decided': async (_ctx, event) => {
    // @ts-expect-error `days` rides the approval only — narrow on `decision` first
    void event.payload.days;
    if (event.payload.decision === 'approved') {
      const days: string = event.payload.days; // accepted, once narrowed
      const booking: string = event.payload.bookingId; // and non-null here
      void days;
      void booking;
    } else {
      const noBooking: null = event.payload.bookingId; // a rejection books nothing
      void noBooking;
    }
  },
});

// --- a request outside the group stands alone -------------------------------
// The group demands companions; an event outside it does not, or the check
// would be indistinguishable from "handle everything or nothing".
consumersFor<[AbsenceEvents]>()({
  'absence.entry-recorded': async (_ctx, event) => {
    void event.payload.entryKind;
  },
});

// ===========================================================================
// THE EMITTING SIDE — what keeps the map from rotting into a lie.
//
// Never called: these are assertions for `tsc`, and `ctx` is a parameter rather
// than a fabricated value so nothing here can run by accident.
// ===========================================================================

function _emitSiteChecks(ctx: OperationContext, approved: AbsenceApprovedPayload, who: DataSubjectId): void {
  const subject = { entityType: 'employee', entityId: '01K' };

  // --- positive twin: the declared types, accepted --------------------------
  emitAbsenceEvent(ctx, {
    type: 'absence.decided',
    entity: subject,
    piiClass: 'pseudonymous',
    subjectId: who,
    payload: approved,
  });

  // --- a schemaVersion at the emit site: the engine owns it (#1597) ----------
  emitAbsenceEvent(ctx, {
    type: 'absence.decided',
    // @ts-expect-error the version is the engine's (`absenceEventVersions`) — an emit site cannot name one
    schemaVersion: 2,
    entity: subject,
    piiClass: 'pseudonymous',
    subjectId: who,
    payload: approved,
  });

  emitAbsenceEvent(ctx, {
    type: 'absence.expired',
    entity: subject,
    piiClass: 'pseudonymous',
    subjectId: who,
    payload: { requestId: '01J', subject, startDate: '2026-09-01' },
  });

  // --- an event type the map does not declare -------------------------------
  emitAbsenceEvent(ctx, {
    // @ts-expect-error engine-absence declares no 'absence.accrued'
    type: 'absence.accrued',
    entity: subject,
    piiClass: 'pseudonymous',
    subjectId: who,
    payload: { requestId: '01J', subject, startDate: '2026-09-01' },
  });

  // --- the union's wrong branch ---------------------------------------------
  // A rejection carrying `days` is the shape that would let a consumer read a
  // balance change that never happened.
  emitAbsenceEvent(ctx, {
    type: 'absence.decided',
    entity: subject,
    piiClass: 'pseudonymous',
    subjectId: who,
    payload: {
      requestId: '01J',
      subject,
      leaveTypeKey: 'vacation',
      decision: 'rejected',
      bookingId: null,
      // @ts-expect-error a rejection changed no balance, so it reports no days
      days: '3',
    },
  });

  // --- an approval with no booking to name ----------------------------------
  emitAbsenceEvent(ctx, {
    type: 'absence.decided',
    entity: subject,
    piiClass: 'pseudonymous',
    subjectId: who,
    // @ts-expect-error an approval books days, so `bookingId` cannot be null
    payload: {
      requestId: '01J',
      subject,
      leaveTypeKey: 'vacation',
      decision: 'approved',
      bookingId: null,
      days: '3',
      startDate: '2026-09-01',
      endDate: '2026-09-03',
    },
  });

  // --- a decimal handed over as a number ------------------------------------
  emitAbsenceEvent(ctx, {
    type: 'absence.requested',
    entity: subject,
    piiClass: 'pseudonymous',
    subjectId: who,
    // @ts-expect-error days are decimal strings, never floats (K-14)
    payload: { requestId: '01J', subject, leaveTypeKey: 'vacation', startDate: '2026-09-01', endDate: '2026-09-03', days: 3 },
  });
}
void _emitSiteChecks;

describe('#696 engine-absence event contract', () => {
  it('is a pass-through at runtime — types only', () => {
    const emitted: unknown[] = [];
    const ctx = { emit: (event: unknown) => emitted.push(event) } as unknown as OperationContext;
    emitAbsenceEvent(ctx, {
      type: 'absence.leave-type-configured',
      entity: { entityType: 'absence-leave-type', entityId: 'vacation' },
      piiClass: 'none',
      payload: { key: 'vacation', floor: '0', active: true },
    });
    expect(emitted).toEqual([
      {
        type: 'absence.leave-type-configured',
        schemaVersion: 1,
        entity: { entityType: 'absence-leave-type', entityId: 'vacation' },
        piiClass: 'none',
        payload: { key: 'vacation', floor: '0', active: true },
      },
    ]);
  });

  it('hands a vertical back exactly the handlers it wrote', () => {
    expect(Object.keys(wellFormed).sort()).toEqual(['absence.cancelled', 'absence.expired']);
  });
});
