/**
 * #696 — engine-metering's published event contract, as a compile-time suite.
 *
 * THIS FILE IS THE GATE. `MeteringEvents` is types only, so nothing at runtime
 * can tell an enforced constraint from a decorative one: a type-level check
 * fails *permissively*, and a map that has quietly stopped biting compiles
 * exactly like one that still does. Every `@ts-expect-error` below is therefore
 * load-bearing in the inverted direction — if a check stops being enforced,
 * `tsc` reports "Unused '@ts-expect-error' directive" and
 * `pnpm --filter @substrat-run/engine-metering typecheck` goes red.
 *
 * Each negative has a POSITIVE TWIN through the same path. A negative on its own
 * proves nothing: delete the mechanism and "wrong shape is rejected" and "right
 * shape is accepted" both pass, because nothing is left to accept anything.
 */
import { describe, expect, it } from 'vitest';
import { consumersFor, type OperationContext } from '@substrat-run/kernel';

import { emitMeteringEvent, type MeteringEvents, type MeteringPeriodClosedPayload } from '../src/events.js';

// ===========================================================================
// THE CONSUMING SIDE — what a vertical gets. This engine's close is what the
// vertical PRICES, so a guessed payload here reaches a customer as a wrong
// invoice rather than a crash.
// ===========================================================================

// --- positive twin: declared keys, typed payloads ---------------------------
const wellFormed = consumersFor<[MeteringEvents]>()({
  'metering.period-closed': async (_ctx, event) => {
    for (const line of event.payload.lines) {
      // `qty` is a decimal STRING and the line is UNPRICED by design (D-E) —
      // the vertical is what turns it into money.
      const qty: string = line.qty;
      void qty;
      void line.unit;
    }
  },
  'metering.usage-recorded': async (_ctx, event) => {
    // `subject` is nullable: an entry need not be about anything in particular.
    void event.payload.subject?.entityId;
  },
});

// --- an event type this engine does not emit -------------------------------
consumersFor<[MeteringEvents]>()({
  'metering.period-closed': async () => {},
  // @ts-expect-error engine-metering emits no 'metering.period-priced' — pricing is the vertical's
  'metering.period-priced': async () => {},
});

// --- the field that would reach a customer as money -------------------------
// A close carries quantities, never amounts. A consumer reaching for a price is
// reaching for something this engine has refused to own (D-E).
consumersFor<[MeteringEvents]>()({
  'metering.period-closed': async (_ctx, event) => {
    const [line] = event.payload.lines;
    void line?.entryCount;
    // @ts-expect-error metering owns quantities, never prices — no currency, no rates
    void line?.amount;
  },
});

// --- a quantity is a string, and reading it as a number is the defect --------
consumersFor<[MeteringEvents]>()({
  'metering.usage-recorded': async (_ctx, event) => {
    // @ts-expect-error decimals are strings, never floats (D-E, K-14)
    const qty: number = event.payload.qty;
    void qty;
  },
});

// ---------------------------------------------------------------------------
// NO COMPLETION GROUP, on purpose — see `src/events.ts`. A configuration, an
// observation and a freeze are three facts, so consuming only the close is the
// normal thing and must stay legitimate.
// ---------------------------------------------------------------------------
consumersFor<[MeteringEvents]>()({
  'metering.period-closed': async () => {},
});

// ===========================================================================
// THE EMITTING SIDE — what keeps the map from rotting into a lie.
//
// Never called: these are assertions for `tsc`, and `ctx` is a parameter rather
// than a fabricated value so nothing here can run by accident.
// ===========================================================================

function _emitSiteChecks(ctx: OperationContext, closed: MeteringPeriodClosedPayload): void {
  // --- positive twin: the declared types, accepted --------------------------
  emitMeteringEvent(ctx, {
    type: 'metering.period-closed',
    schemaVersion: 1,
    entity: { entityType: 'metering-period', entityId: '01J' },
    piiClass: 'none',
    payload: closed,
  });

  emitMeteringEvent(ctx, {
    type: 'metering.meter-configured',
    schemaVersion: 1,
    entity: { entityType: 'metering-meter', entityId: 'turns' },
    piiClass: 'none',
    payload: { key: 'turns', kind: 'counter', unit: 'turn', active: true },
  });

  // --- an event type the map does not declare -------------------------------
  emitMeteringEvent(ctx, {
    // @ts-expect-error engine-metering declares no 'metering.meter-retired'
    type: 'metering.meter-retired',
    schemaVersion: 1,
    entity: { entityType: 'metering-meter', entityId: 'turns' },
    piiClass: 'none',
    payload: { key: 'turns', kind: 'counter', unit: 'turn', active: false },
  });

  // --- a meter kind this engine does not have -------------------------------
  emitMeteringEvent(ctx, {
    type: 'metering.meter-configured',
    schemaVersion: 1,
    entity: { entityType: 'metering-meter', entityId: 'turns' },
    piiClass: 'none',
    // @ts-expect-error there are two kinds: 'counter' and 'gauge'
    payload: { key: 'turns', kind: 'histogram', unit: 'turn', active: true },
  });

  // --- a payload field the map declares and the emit drops ------------------
  emitMeteringEvent(ctx, {
    type: 'metering.usage-recorded',
    schemaVersion: 1,
    entity: { entityType: 'metering-entry', entityId: '01J' },
    piiClass: 'none',
    // @ts-expect-error 'dedupeKey' is required — it is what makes ingest idempotent (D-C)
    payload: {
      entryId: '01J',
      meterKey: 'turns',
      kind: 'counter',
      unit: 'turn',
      qty: '1',
      subject: null,
      occurredAt: '2026-09-20T10:00:00.000Z',
    },
  });

  // --- a price on a line that is unpriced by design -------------------------
  emitMeteringEvent(ctx, {
    type: 'metering.period-closed',
    schemaVersion: 1,
    entity: { entityType: 'metering-period', entityId: '01J' },
    piiClass: 'none',
    payload: {
      periodId: '01J',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
      // @ts-expect-error metering owns quantities, never prices (D-E)
      lines: [{ meterKey: 'turns', kind: 'counter', unit: 'turn', qty: '12', entryCount: 12, amount: '120' }],
    },
  });
}
void _emitSiteChecks;

describe('#696 engine-metering event contract', () => {
  it('is a pass-through at runtime — types only', () => {
    const emitted: unknown[] = [];
    const ctx = { emit: (event: unknown) => emitted.push(event) } as unknown as OperationContext;
    emitMeteringEvent(ctx, {
      type: 'metering.meter-configured',
      schemaVersion: 1,
      entity: { entityType: 'metering-meter', entityId: 'turns' },
      piiClass: 'none',
      payload: { key: 'turns', kind: 'counter', unit: 'turn', active: true },
    });
    expect(emitted).toEqual([
      {
        type: 'metering.meter-configured',
        schemaVersion: 1,
        entity: { entityType: 'metering-meter', entityId: 'turns' },
        piiClass: 'none',
        payload: { key: 'turns', kind: 'counter', unit: 'turn', active: true },
      },
    ]);
  });

  it('hands a vertical back exactly the handlers it wrote', () => {
    expect(Object.keys(wellFormed).sort()).toEqual([
      'metering.period-closed',
      'metering.usage-recorded',
    ]);
  });
});
