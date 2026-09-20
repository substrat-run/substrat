/**
 * engine-invoicing's event contract (#696) — what a VERTICAL imports so that
 * consuming this engine by event is checked rather than guessed.
 *
 * ## This engine is where the asymmetry is easiest to see
 *
 * engine-invoicing is composed BY EVENT: it consumes `workorder.completed`,
 * `commerce.order-placed` and `timesheet.period-closed`, and it consumes each of
 * them through **its own Zod view of the payload, with zero imports from the
 * producer**. That stays exactly as it is. What this file adds is the other
 * direction — the events invoicing itself emits, typed for the VERTICAL that
 * reads the basis back.
 *
 * So the same event is typed for a vertical and parsed by an engine, on purpose:
 *
 * - a sibling engine cannot import a producer's types (R1, star topology), and
 *   the defensive parse is what lets it ride out #128's dual-emit window — a
 *   tolerated absence instead of a compile break between independently versioned
 *   packages (D-30);
 * - a vertical already imports the engines it composes, ships as one unit and
 *   upgrades them together, so for it the compile break is the point.
 *
 * TYPES ONLY. `emitInvoicingEvent` forwards to `ctx.emit` unchanged — one extra
 * call in the stack, and no change in what is emitted; the runtime contract is
 * still the fat payload and the consumer's Zod parse (kernel `EventContract`,
 * `packages/kernel/src/scope-host.ts`).
 *
 * **No completion group.** A group says two events report ONE fact by different
 * routes, so handling a subset strands the entity. These two are a running
 * basis and its terminal export — sequential facts about one artifact, not one
 * fact by two routes.
 *
 * ## `schemaVersion` lives on the emit, not here
 *
 * `invoicing.underlag-exported` is at **v2** (`total` is `Money`, not a bare
 * amount string), and `InvoicingUnderlagExportedPayload` describes v2. There is
 * no v1 type, because there is no v1 emission: K-39 makes a bump a REPLACE, and
 * dual-emit is not available — consumer dispatch selects on event type alone, so
 * emitting both would deliver both to the same consumer, which for an export
 * event whose consumer is an accounting connector is a double invoice. A v1
 * consumer's strict parse rejecting v2 and dead-lettering is the loud failure
 * that replaces the silent one.
 */
import type { DomainEventInput, EntityRef, Money } from '@substrat-run/contracts';
import type { OperationContext } from '@substrat-run/kernel';

/**
 * Lines were appended to an invoice basis.
 *
 * Emitted once per delivery consumed, whichever producer it came from — the
 * `source` says which, and it is the DOCUMENT that produced the lines
 * (`workorder`/`order`/`timesheet` + its id), not the per-line provenance.
 */
export interface InvoicingUnderlagUpdatedPayload {
  underlagId: string;
  /** How many lines this delivery added, not the running total on the basis. */
  addedLines: number;
  source: EntityRef;
}

/**
 * The basis was exported and is immutable from here.
 *
 * **v2.** `total` is `Money`: the consumer of an export event is an accounting
 * connector, and "1550" without a currency is not an amount.
 */
export interface InvoicingUnderlagExportedPayload {
  underlagId: string;
  /** The per-scope running number the basis was issued under. */
  number: number;
  total: Money;
}

/**
 * engine-invoicing's event contract — the two event types this engine emits and
 * the payload each one carries.
 *
 * Satisfies the kernel's `EventContract`, so a vertical writes
 * `consumersFor<[InvoicingEvents]>()({ … })` and gets typed payloads plus
 * rejection of an event type this engine does not emit. Reading the basis back
 * by consuming `invoicing.underlag-updated` into a side table keyed by the
 * underlag's id is decision 28's shape, and this is what types it.
 */
export type InvoicingEvents = {
  events: {
    'invoicing.underlag-updated': InvoicingUnderlagUpdatedPayload;
    'invoicing.underlag-exported': InvoicingUnderlagExportedPayload;
  };
};

/** Every event type this engine emits. */
export type InvoicingEventType = keyof InvoicingEvents['events'];

/**
 * `ctx.emit`, with the event type and its payload welded together.
 *
 * This is what stops `InvoicingEvents` becoming a description nothing holds in
 * agreement. `ctx.emit` takes `payload: unknown`, so a map declared beside the
 * emit sites would be checked by nobody and could rot silently into a lie a
 * vertical compiles against. Routing every emit through here makes the map the
 * *source*: rename a payload field on one side and the other side fails to
 * compile, and emitting a type the map does not declare fails too.
 *
 * Zero runtime behaviour of its own — it forwards to `ctx.emit` unchanged.
 */
export function emitInvoicingEvent<K extends InvoicingEventType>(
  ctx: OperationContext,
  event: Omit<DomainEventInput, 'type' | 'payload'> & {
    type: K;
    payload: InvoicingEvents['events'][K];
  },
): void {
  ctx.emit(event);
}
