/**
 * engine-workorder's event contract (#696) — what a VERTICAL imports so that
 * consuming this engine by event is checked rather than guessed.
 *
 * TYPES ONLY. The runtime contract is still the fat payload and **the
 * consumer's own Zod parse** (kernel `EventContract`,
 * `packages/kernel/src/scope-host.ts`); `emitWorkorderEvent` forwards to
 * `ctx.emit` unchanged and compiles away.
 *
 * VERTICAL-FACING ONLY. `engine-invoicing` consumes `workorder.completed` and
 * must NOT import this — R1 (star topology) forbids the import, and its own Zod
 * view is what lets it ride out #128's dual-emit window. That asymmetry is
 * deliberate: the same event is typed for a vertical and parsed by an engine.
 *
 * **No completion group.** These seven events are seven distinct facts about one
 * order's life, not one fact arriving by several routes, so nothing here asks a
 * consumer to handle a companion. That absence is a statement rather than an
 * omission — `completionGroups` is for `protocol.signed`/`protocol.countersigned`,
 * where completion rides on whichever event happens to arrive last.
 *
 * Additive, like every other engine surface: a new event type may appear, an
 * existing payload field does not change shape without a `schemaVersion` bump.
 */
import type { DomainEventInput, EntityRef, Money } from '@substrat-run/contracts';
import type { OperationContext } from '@substrat-run/kernel';

import type { BillableLine } from './schemas.js';

/** An order was raised against a facility for a customer. */
export interface WorkorderCreatedPayload {
  orderId: string;
  /** The per-scope running number, not the id. */
  number: number;
  /** Entity-agnostic by design: a facility in one vertical, a bike in another. */
  facility: EntityRef;
  customer: EntityRef;
  kind: string;
  title: string;
}

/** An order was assigned to a technician. */
export interface WorkorderAssignedPayload {
  orderId: string;
  technician: string;
}

/** planned → in_progress. */
export interface WorkorderStartedPayload {
  orderId: string;
}

/** One append to the order's time history — a correction is another entry, never an edit. */
export interface WorkorderTimeReportedPayload {
  orderId: string;
  entryId: string;
  /** Exact decimal as a string, six places — never a float (K-14). */
  hours: string;
}

/** One append to the order's material history, on the same append-only rule. */
export interface WorkorderMaterialReportedPayload {
  orderId: string;
  lineId: string;
  article: string;
  /** Exact decimal as a string, six places — never a float (K-14). */
  qty: string;
}

/**
 * The order is done and priced.
 *
 * Deliberately fat: this is the event `engine-invoicing` is composed by, and a
 * consumer must never need a cross-module read — so the priced lines and the
 * total travel with it rather than being fetched back through this engine.
 */
export interface WorkorderCompletedPayload {
  orderId: string;
  number: number;
  facility: EntityRef;
  customer: EntityRef;
  billable: BillableLine[];
  total: Money;
}

/** completed → closed. */
export interface WorkorderClosedPayload {
  orderId: string;
}

/**
 * engine-workorder's event contract — the seven event types this engine emits
 * and the payload each one carries.
 *
 * Satisfies the kernel's `EventContract`, so a vertical writes
 * `consumersFor<[WorkorderEvents]>()({ … })` and gets typed payloads plus
 * rejection of an event type this engine does not emit.
 */
export type WorkorderEvents = {
  events: {
    'workorder.created': WorkorderCreatedPayload;
    'workorder.assigned': WorkorderAssignedPayload;
    'workorder.started': WorkorderStartedPayload;
    'workorder.time-reported': WorkorderTimeReportedPayload;
    'workorder.material-reported': WorkorderMaterialReportedPayload;
    'workorder.completed': WorkorderCompletedPayload;
    'workorder.closed': WorkorderClosedPayload;
  };
};

/** Every event type this engine emits. */
export type WorkorderEventType = keyof WorkorderEvents['events'];

/**
 * `ctx.emit`, with the event type and its payload welded together.
 *
 * This is what stops `WorkorderEvents` becoming a description nothing holds in
 * agreement. `ctx.emit` takes `payload: unknown`, so a map declared beside the
 * emit sites would be checked by nobody and could rot silently into a lie a
 * vertical compiles against. Routing every emit through here makes the map the
 * *source*: rename a payload field on one side and the other side fails to
 * compile, and emitting a type the map does not declare fails too.
 *
 * Zero runtime behaviour of its own — it forwards to `ctx.emit` unchanged.
 */
export function emitWorkorderEvent<K extends WorkorderEventType>(
  ctx: OperationContext,
  event: Omit<DomainEventInput, 'type' | 'payload'> & {
    type: K;
    payload: WorkorderEvents['events'][K];
  },
): void {
  ctx.emit(event);
}
