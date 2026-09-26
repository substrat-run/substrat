/**
 * #1597 — one home for each event's `schemaVersion`.
 *
 * `meteringEventVersions` is what `emitMeteringEvent` stamps and what the manifest's
 * `emits` is read from. The pinned list below is the manifest as it shipped
 * before that move: a version bumped by accident (or a type dropped) fails here
 * instead of quietly changing what a deployed consumer parses.
 */
import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@substrat-run/kernel';
import { meteringEventVersions, emitMeteringEvent, type MeteringEventType } from '../src/events.js';
import { meteringManifest } from '../src/index.js';

const SHIPPED = [
    { type: 'metering.meter-configured', schemaVersion: 1 },
    { type: 'metering.usage-recorded', schemaVersion: 1 },
    { type: 'metering.period-closed', schemaVersion: 1 },
];

describe('metering: event schemaVersion has one home', () => {
  it('the manifest emits exactly what shipped, in the same order', () => {
    expect(meteringManifest.events.emits).toEqual(SHIPPED);
  });

  it('every emission carries the version the manifest declares for its type', () => {
    const seen: { type: string; schemaVersion: number }[] = [];
    const ctx = { emit: (e: { type: string; schemaVersion: number }) => seen.push(e) } as unknown as OperationContext;
    for (const type of Object.keys(meteringEventVersions) as MeteringEventType[]) {
      // The payload is irrelevant to the stamp; the cast is this test's, not the engine's.
      emitMeteringEvent(ctx, { type, entity: { entityType: 'x', entityId: 'y' }, piiClass: 'none', payload: {} } as never);
    }
    expect(seen.map((e) => ({ type: e.type, schemaVersion: e.schemaVersion }))).toEqual(
      meteringManifest.events.emits.map((d) => ({ type: d.type, schemaVersion: d.schemaVersion })),
    );
  });
});
