/**
 * engine-absence' event contract (#696) — what a VERTICAL imports so that
 * consuming this engine by event is checked rather than guessed.
 *
 * TYPES ONLY. The runtime contract is still the fat payload and **the
 * consumer's own Zod parse** (kernel `EventContract`,
 * `packages/kernel/src/scope-host.ts`); `emitAbsenceEvent` forwards to
 * `ctx.emit` unchanged — one extra call in the stack, and no change in what is
 * emitted.
 *
 * VERTICAL-FACING ONLY. A sibling engine consuming one of these must NOT import
 * it — R1 (star topology) forbids the import, and the defensive parse is what
 * lets an engine ride out #128's dual-emit window.
 *
 * ## This engine has a completion group, and it is the same shape as protocol's
 *
 * A request leaves `requested` by three routes, and TWO of them write the same
 * terminal status: `cancelAbsence` sets `status = 'cancelled'` and emits
 * `absence.cancelled`; `expireStaleRequests` sets `status = 'cancelled'` too and
 * emits `absence.expired`. One fact, two event names — exactly the split that
 * cost `protocol.signed`/`protocol.countersigned` a production outage.
 *
 * It is the more dangerous of the two, because the second route has no caller: a
 * date-triggered sweep attributed to the schedule (#383). A consumer that
 * handles `absence.cancelled` looks correct in every test anyone writes by hand
 * and strands every auto-expired request in production, where the sweep is the
 * only thing that emits. `completionGroups` is what turns that into a compile
 * error naming `absence.expired`.
 *
 * `absence.decided` is deliberately NOT in that group: a rejection is a
 * different fact from a cancellation, decided by a person, and a consumer may
 * legitimately care about one and not the other.
 *
 * Additive, like every other engine surface: a new event type may appear, an
 * existing payload field does not change shape without a `schemaVersion` bump.
 */
import type { DomainEventInput, EntityRef } from '@substrat-run/contracts';
import type { OperationContext } from '@substrat-run/kernel';

/**
 * Who the absence is for, as it rides every payload here.
 *
 * The employee is named by the VERTICAL's own entity — this engine is
 * subject-agnostic. The shreddable `DataSubjectId` that keys erasure travels on
 * the envelope's `subjectId`, never in the payload.
 */
export type AbsenceSubjectRef = EntityRef;

/** A leave type was declared, or its declaration changed. */
export interface AbsenceLeaveTypeConfiguredPayload {
  key: string;
  /** How far below zero a balance of this type may go — a decimal STRING, never a float. */
  floor: string;
  active: boolean;
}

/**
 * One append to the ledger. The ledger is append-only: a correction is a new
 * entry and a cancellation is a compensating `reversal`, never an edit.
 */
export interface AbsenceEntryRecordedPayload {
  entryId: string;
  subject: AbsenceSubjectRef;
  leaveTypeKey: string;
  entryKind: 'accrual' | 'booking' | 'correction' | 'carryover' | 'reversal';
  /** Signed decimal STRING, six places — a booking is negative, an accrual positive. */
  delta: string;
  /** Calendar date (YYYY-MM-DD), not an instant: leave is counted in days. */
  effectiveDate: string;
  /** The request this entry settles, or null for an administrative append. */
  requestId: string | null;
}

/** Someone asked for leave. Nothing has touched the ledger yet. */
export interface AbsenceRequestedPayload {
  requestId: string;
  subject: AbsenceSubjectRef;
  leaveTypeKey: string;
  startDate: string;
  endDate: string;
  /** Non-negative decimal STRING. */
  days: string;
}

/**
 * A request was approved, and the booking entry that took the days is named.
 *
 * The approved and rejected shapes are a discriminated union on `decision` and
 * genuinely differ: `days`, `startDate` and `endDate` ride the approval only,
 * because a rejection changed no balance and has no interval to report. Reading
 * `payload.days` off a rejection used to be a cast that compiled and a screen
 * that said `undefined`.
 */
export interface AbsenceApprovedPayload {
  requestId: string;
  subject: AbsenceSubjectRef;
  leaveTypeKey: string;
  decision: 'approved';
  bookingId: string;
  days: string;
  startDate: string;
  endDate: string;
}

/** A request was rejected. No ledger entry exists, so there is no booking to name. */
export interface AbsenceRejectedPayload {
  requestId: string;
  subject: AbsenceSubjectRef;
  leaveTypeKey: string;
  decision: 'rejected';
  bookingId: null;
}

/** A decision, either way. Narrow on `decision` before reading anything else. */
export type AbsenceDecidedPayload = AbsenceApprovedPayload | AbsenceRejectedPayload;

/**
 * A request was withdrawn, or an approved one was called off.
 *
 * `priorStatus` is what it was before: cancelling an `approved` request writes a
 * compensating reversal and names it in `reversalId`; cancelling a `requested`
 * one touches no ledger and reports `null`.
 */
export interface AbsenceCancelledPayload {
  requestId: string;
  subject: AbsenceSubjectRef;
  leaveTypeKey: string;
  priorStatus: 'requested' | 'approved';
  reversalId: string | null;
}

/**
 * A request still pending when its start date passed was cancelled by the sweep.
 *
 * The row lands on the same `cancelled` status `absence.cancelled` reports, and
 * this event is the OTHER route to it — hence the completion group. Emitted by a
 * date-triggered schedule with no human caller (#383), which is why a consumer
 * can handle its companion and never notice the gap until production.
 */
export interface AbsenceExpiredPayload {
  requestId: string;
  subject: AbsenceSubjectRef;
  startDate: string;
}

/**
 * engine-absence' event contract — the six event types this engine emits, the
 * payload each one carries, and the one pair that reports a single fact by two
 * routes.
 *
 * Satisfies the kernel's `EventContract`, so a vertical writes
 * `consumersFor<[AbsenceEvents]>()({ … })` and gets typed payloads, rejection of
 * an event type this engine does not emit, and — via `completionGroups` — a
 * compile error naming the cancellation route it forgot.
 */
export type AbsenceEvents = {
  events: {
    'absence.leave-type-configured': AbsenceLeaveTypeConfiguredPayload;
    'absence.entry-recorded': AbsenceEntryRecordedPayload;
    'absence.requested': AbsenceRequestedPayload;
    'absence.decided': AbsenceDecidedPayload;
    'absence.cancelled': AbsenceCancelledPayload;
    'absence.expired': AbsenceExpiredPayload;
  };
  /**
   * Both routes write `status = 'cancelled'`. Handling one and not the other
   * strands every request that took the route nobody tested — and the untested
   * one is the sweep, which is the only route with no caller.
   */
  completionGroups: {
    cancellation: 'absence.cancelled' | 'absence.expired';
  };
};

/** Every event type this engine emits. */
export type AbsenceEventType = keyof AbsenceEvents['events'];

/**
 * `ctx.emit`, with the event type and its payload welded together.
 *
 * This is what stops `AbsenceEvents` becoming a description nothing holds in
 * agreement. `ctx.emit` takes `payload: unknown`, so a map declared beside the
 * emit sites would be checked by nobody and could rot silently into a lie a
 * vertical compiles against. Routing every emit through here makes the map the
 * *source*: rename a payload field on one side and the other side fails to
 * compile, and emitting a type the map does not declare fails too.
 *
 * Zero runtime behaviour of its own — it forwards to `ctx.emit` unchanged.
 */
export function emitAbsenceEvent<K extends AbsenceEventType>(
  ctx: OperationContext,
  event: Omit<DomainEventInput, 'type' | 'payload'> & {
    type: K;
    payload: AbsenceEvents['events'][K];
  },
): void {
  ctx.emit(event);
}
