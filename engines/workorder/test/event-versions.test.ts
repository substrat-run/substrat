/**
 * #1597 — one home for each event's `schemaVersion`.
 *
 * `workorderEventVersions` is what `emitWorkorderEvent` stamps and what the manifest's
 * `emits` is read from. The pinned list below is the manifest as it shipped
 * before that move: a version bumped by accident (or a type dropped) fails here
 * instead of quietly changing what a deployed consumer parses.
 */
import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@substrat-run/kernel';
import { workorderEventVersions, emitWorkorderEvent, type WorkorderEventType } from '../src/events.js';
import { workorderManifest } from '../src/index.js';

const SHIPPED = [
    { type: 'workorder.created', schemaVersion: 1 },
    { type: 'workorder.assigned', schemaVersion: 1 },
    { type: 'workorder.started', schemaVersion: 1 },
    { type: 'workorder.time-reported', schemaVersion: 1 },
    { type: 'workorder.material-reported', schemaVersion: 1 },
    { type: 'workorder.completed', schemaVersion: 1 },
    { type: 'workorder.closed', schemaVersion: 1 },
];

describe('workorder: event schemaVersion has one home', () => {
  it('the manifest emits exactly what shipped, in the same order', () => {
    expect(workorderManifest.events.emits).toEqual(SHIPPED);
  });

  it('every emission carries the version the manifest declares for its type', () => {
    const seen: { type: string; schemaVersion: number }[] = [];
    const ctx = { emit: (e: { type: string; schemaVersion: number }) => seen.push(e) } as unknown as OperationContext;
    for (const type of Object.keys(workorderEventVersions) as WorkorderEventType[]) {
      // The payload is irrelevant to the stamp; the cast is this test's, not the engine's.
      emitWorkorderEvent(ctx, { type, entity: { entityType: 'x', entityId: 'y' }, piiClass: 'none', payload: {} } as never);
    }
    expect(seen.map((e) => ({ type: e.type, schemaVersion: e.schemaVersion }))).toEqual(
      workorderManifest.events.emits.map((d) => ({ type: d.type, schemaVersion: d.schemaVersion })),
    );
  });
});
