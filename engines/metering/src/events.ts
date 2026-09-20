/**
 * engine-metering's event contract (#696) — what a VERTICAL imports so that
 * consuming this engine by event is checked rather than guessed.
 *
 * This is the engine whose events most need it: a close is what the vertical
 * PRICES, and pricing something whose quantity arrived as `unknown` and was cast
 * is the failure mode that reaches a customer as a wrong invoice rather than a
 * crash. `metering.period-closed` carries unpriced lines on purpose (D-E) — the
 * vertical prices them and feeds invoicing — so the consumer is a billing path
 * by construction.
 *
 * TYPES ONLY. The runtime contract is still the fat payload and **the
 * consumer's own Zod parse** (kernel `EventContract`,
 * `packages/kernel/src/scope-host.ts`); `emitMeteringEvent` forwards to
 * `ctx.emit` unchanged and compiles away.
 *
 * VERTICAL-FACING ONLY. A sibling engine consuming one of these must NOT import
 * it — R1 (star topology) forbids the import, and the defensive parse is what
 * lets an engine ride out #128's dual-emit window.
 *
 * **No completion group.** A group says two events report ONE fact by different
 * routes, so handling a subset strands the entity. These three are a
 * configuration, an observation and a freeze — three different facts, and a
 * vertical that consumes only `metering.period-closed` is doing the normal
 * thing rather than the mistake #696 was filed for.
 *
 * Additive, like every other engine surface: a new event type may appear, an
 * existing payload field does not change shape without a `schemaVersion` bump.
 */
import type { DomainEventInput, EntityRef } from '@substrat-run/contracts';
import type { OperationContext } from '@substrat-run/kernel';

/** A meter was declared, or its declaration changed. */
export interface MeteringMeterConfiguredPayload {
  key: string;
  /** Counters take signed deltas; gauges take non-negative level samples. */
  kind: 'counter' | 'gauge';
  unit: string;
  /** Deactivating does not stop usage already recorded from billing. */
  active: boolean;
}

/** One observation appended to the ledger. A correction is a compensating entry, never an edit. */
export interface MeteringUsageRecordedPayload {
  entryId: string;
  meterKey: string;
  kind: 'counter' | 'gauge';
  unit: string;
  /** A decimal STRING, six places, signed — never a float (D-E, K-14). */
  qty: string;
  /** What was metered — a tenant, a site, a robot. The vertical's noun, or null. */
  subject: EntityRef | null;
  occurredAt: string;
  /** The caller's idempotency key, unique per meter (D-C) — e.g. a turn id. */
  dedupeKey: string;
}

/** One meter's frozen aggregate for a closed period. Unpriced, by design (D-E). */
export interface MeteringPeriodLine {
  meterKey: string;
  kind: 'counter' | 'gauge';
  unit: string;
  /** A decimal STRING, six places, signed — never a float. */
  qty: string;
  entryCount: number;
}

/**
 * A period was frozen over half-open `[from, to)`.
 *
 * Deliberately fat, and deliberately UNPRICED: the lines carry quantities and
 * units, and the vertical is what turns them into money and feeds invoicing —
 * the same wiring as `timesheet.period-closed`. A consumer must never need a
 * cross-module read to price a close.
 */
export interface MeteringPeriodClosedPayload {
  periodId: string;
  from: string;
  to: string;
  lines: MeteringPeriodLine[];
}

/**
 * engine-metering's event contract — the three event types this engine emits
 * and the payload each one carries.
 *
 * Satisfies the kernel's `EventContract`, so a vertical writes
 * `consumersFor<[MeteringEvents]>()({ … })` and gets typed payloads plus
 * rejection of an event type this engine does not emit.
 */
export type MeteringEvents = {
  events: {
    'metering.meter-configured': MeteringMeterConfiguredPayload;
    'metering.usage-recorded': MeteringUsageRecordedPayload;
    'metering.period-closed': MeteringPeriodClosedPayload;
  };
};

/** Every event type this engine emits. */
export type MeteringEventType = keyof MeteringEvents['events'];

/**
 * `ctx.emit`, with the event type and its payload welded together.
 *
 * This is what stops `MeteringEvents` becoming a description nothing holds in
 * agreement. `ctx.emit` takes `payload: unknown`, so a map declared beside the
 * emit sites would be checked by nobody and could rot silently into a lie a
 * vertical compiles against. Routing every emit through here makes the map the
 * *source*: rename a payload field on one side and the other side fails to
 * compile, and emitting a type the map does not declare fails too.
 *
 * Zero runtime behaviour of its own — it forwards to `ctx.emit` unchanged.
 */
export function emitMeteringEvent<K extends MeteringEventType>(
  ctx: OperationContext,
  event: Omit<DomainEventInput, 'type' | 'payload'> & {
    type: K;
    payload: MeteringEvents['events'][K];
  },
): void {
  ctx.emit(event);
}
