/**
 * #696 — engine-invoicing's published event contract, as a compile-time suite.
 *
 * THIS FILE IS THE GATE. `InvoicingEvents` is types only, so nothing at runtime
 * can tell an enforced constraint from a decorative one: a type-level check
 * fails *permissively*, and a map that has quietly stopped biting compiles
 * exactly like one that still does. Every `@ts-expect-error` below is therefore
 * load-bearing in the inverted direction — if a check stops being enforced,
 * `tsc` reports "Unused '@ts-expect-error' directive" and
 * `pnpm --filter @substrat-run/engine-invoicing typecheck` goes red.
 *
 * Each negative has a POSITIVE TWIN through the same path. A negative on its own
 * proves nothing: delete the mechanism and "wrong shape is rejected" and "right
 * shape is accepted" both pass, because nothing is left to accept anything.
 *
 * This engine also carries the ASYMMETRY's positive twin: its own consumers of
 * `workorder.completed` and friends still take `ConsumerHandler` and a Zod
 * parse, and the last case here is what says that must keep compiling.
 */
import { describe, expect, it } from 'vitest';
import { moneyOf, type Money } from '@substrat-run/contracts';
import { consumersFor, type ConsumerHandler, type ModuleRegistration, type OperationContext } from '@substrat-run/kernel';

import { emitInvoicingEvent } from '../src/events.js';
/**
 * The PUBLIC surface, imported the way a vertical imports it — from the package
 * root, not from `src/events.ts`. Everything below is checked through these, so
 * a name missing or mistyped in `src/index.ts` fails here instead of leaving
 * every gate green while the documented import breaks.
 */
import type {
  InvoicingEvents,
  InvoicingEventType,
  InvoicingUnderlagUpdatedPayload,
  InvoicingUnderlagExportedPayload,
} from '../src/index.js';

/** Every published name, referenced — an absent re-export cannot compile. */
type _PublishedSurface = [
  InvoicingEvents extends never ? never : true,
  InvoicingEventType extends never ? never : true,
  InvoicingUnderlagUpdatedPayload extends never ? never : true,
  InvoicingUnderlagExportedPayload extends never ? never : true,
];

// ===========================================================================
// THE CONSUMING SIDE — what a vertical gets when it reads the basis back by
// event into a side table keyed by the underlag's id (decision 28).
// ===========================================================================

// --- positive twin: declared keys, typed payloads ---------------------------
const wellFormed = consumersFor<[InvoicingEvents]>()({
  'invoicing.underlag-updated': async (_ctx, event) => {
    // `source` is the DOCUMENT that produced the lines, not per-line provenance.
    void event.payload.source.entityType;
    void event.payload.addedLines;
  },
  'invoicing.underlag-exported': async (_ctx, event) => {
    // v2: `total` is Money. On v1 this was a bare amount string with no currency.
    const currency: string = event.payload.total.currency;
    void currency;
  },
});

// --- an event type this engine does not emit -------------------------------
consumersFor<[InvoicingEvents]>()({
  'invoicing.underlag-updated': async () => {},
  // @ts-expect-error invoicing CONSUMES 'workorder.completed'; it does not emit it
  'workorder.completed': async () => {},
});

// --- the v1 shape, which no longer exists -----------------------------------
// K-39 made the bump a REPLACE rather than a dual-emit, so there is one shape
// and a consumer written against the old one must fail here rather than read a
// currency-less amount off a financial artifact.
consumersFor<[InvoicingEvents]>()({
  'invoicing.underlag-exported': async (_ctx, event) => {
    // @ts-expect-error v1's bare amount string is gone — `total` is Money
    const total: string = event.payload.total;
    void total;
  },
});

// ---------------------------------------------------------------------------
// NO COMPLETION GROUP, on purpose — see `src/events.ts`. A running basis and its
// terminal export are sequential facts about one artifact, not one fact arriving
// by two routes, so handling exactly one must stay legitimate.
// ---------------------------------------------------------------------------
consumersFor<[InvoicingEvents]>()({
  'invoicing.underlag-exported': async () => {},
});

// ===========================================================================
// THE EMITTING SIDE — what keeps the map from rotting into a lie.
//
// Never called: these are assertions for `tsc`, and `ctx` is a parameter rather
// than a fabricated value so nothing here can run by accident.
// ===========================================================================

function _emitSiteChecks(ctx: OperationContext, total: Money): void {
  // --- positive twin: the declared types, accepted --------------------------
  emitInvoicingEvent(ctx, {
    type: 'invoicing.underlag-updated',
    schemaVersion: 1,
    entity: { entityType: 'underlag', entityId: '01J' },
    piiClass: 'none',
    payload: { underlagId: '01J', addedLines: 3, source: { entityType: 'workorder', entityId: '01K' } },
  });

  emitInvoicingEvent(ctx, {
    type: 'invoicing.underlag-exported',
    schemaVersion: 2,
    entity: { entityType: 'underlag', entityId: '01J' },
    piiClass: 'none',
    payload: { underlagId: '01J', number: 12, total },
  });

  // --- an event type the map does not declare -------------------------------
  emitInvoicingEvent(ctx, {
    // @ts-expect-error engine-invoicing declares no 'invoicing.underlag-voided'
    type: 'invoicing.underlag-voided',
    schemaVersion: 1,
    entity: { entityType: 'underlag', entityId: '01J' },
    piiClass: 'none',
    payload: { underlagId: '01J', addedLines: 0, source: { entityType: 'workorder', entityId: '01K' } },
  });

  // --- a payload field the map does not declare -----------------------------
  emitInvoicingEvent(ctx, {
    type: 'invoicing.underlag-updated',
    schemaVersion: 1,
    entity: { entityType: 'underlag', entityId: '01J' },
    piiClass: 'none',
    // @ts-expect-error the running total is not on this payload — `addedLines` is what changed
    payload: { underlagId: '01J', addedLines: 3, source: { entityType: 'workorder', entityId: '01K' }, total },
  });

  // --- an export that regresses to the v1 shape ------------------------------
  emitInvoicingEvent(ctx, {
    type: 'invoicing.underlag-exported',
    schemaVersion: 2,
    entity: { entityType: 'underlag', entityId: '01J' },
    piiClass: 'none',
    // @ts-expect-error "1550" without a currency is not an amount (v1's defect)
    payload: { underlagId: '01J', number: 12, total: '1550.00' },
  });
}
void _emitSiteChecks;

// ---------------------------------------------------------------------------
// THE ASYMMETRY, as its own positive twin. An ENGINE consuming a sibling's event
// keeps `ConsumerHandler` and its own Zod view — R1 forbids the type import, and
// the defensive parse is what lets it ride out #128's dual-emit window. If
// `ModuleRegistration.consumers` ever stopped admitting the untyped map, this
// stops compiling and the asymmetry has been broken by accident.
// ---------------------------------------------------------------------------
const siblingConsumer: ConsumerHandler = (_ctx, event) => {
  // `unknown`, as it must be — the engine parses it with its own schema.
  void event.payload;
};
const engineRegistration = {
  consumers: { 'workorder.completed': siblingConsumer },
} satisfies Pick<ModuleRegistration, 'consumers'>;
void engineRegistration;

describe('#696 engine-invoicing event contract', () => {
  it('is a pass-through at runtime — types only', () => {
    const emitted: unknown[] = [];
    const ctx = { emit: (event: unknown) => emitted.push(event) } as unknown as OperationContext;
    emitInvoicingEvent(ctx, {
      type: 'invoicing.underlag-exported',
      schemaVersion: 2,
      entity: { entityType: 'underlag', entityId: '01J' },
      piiClass: 'none',
      payload: { underlagId: '01J', number: 12, total: moneyOf('1550.00', 'SEK') },
    });
    expect(emitted).toEqual([
      {
        type: 'invoicing.underlag-exported',
        schemaVersion: 2,
        entity: { entityType: 'underlag', entityId: '01J' },
        piiClass: 'none',
        payload: { underlagId: '01J', number: 12, total: moneyOf('1550.00', 'SEK') },
      },
    ]);
  });

  it('hands a vertical back exactly the handlers it wrote', () => {
    expect(Object.keys(wellFormed).sort()).toEqual([
      'invoicing.underlag-exported',
      'invoicing.underlag-updated',
    ]);
  });
});
