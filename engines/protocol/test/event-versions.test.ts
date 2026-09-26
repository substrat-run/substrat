/**
 * #1597 — one home for each event's `schemaVersion`.
 *
 * `protocolEventVersions` is what `emitProtocolEvent` stamps and what the manifest's
 * `emits` is read from. The pinned list below is the manifest as it shipped
 * before that move: a version bumped by accident (or a type dropped) fails here
 * instead of quietly changing what a deployed consumer parses.
 */
import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@substrat-run/kernel';
import { protocolEventVersions, emitProtocolEvent, type ProtocolEventType } from '../src/events.js';
import { protocolManifest } from '../src/index.js';

const SHIPPED = [
    { type: 'protocol.instantiated', schemaVersion: 1 },
    { type: 'protocol.response-recorded', schemaVersion: 1 },
    { type: 'protocol.content-bound', schemaVersion: 1 },
    { type: 'protocol.signatures-requested', schemaVersion: 1 },
    { type: 'protocol.signature-declined', schemaVersion: 1 },
    { type: 'protocol.signatures-cancelled', schemaVersion: 1 },
    { type: 'protocol.signed', schemaVersion: 1 },
    { type: 'protocol.countersigned', schemaVersion: 1 },
    { type: 'protocol.voided', schemaVersion: 1 },
];

describe('protocol: event schemaVersion has one home', () => {
  it('the manifest emits exactly what shipped, in the same order', () => {
    expect(protocolManifest.events.emits).toEqual(SHIPPED);
  });

  it('every emission carries the version the manifest declares for its type', () => {
    const seen: { type: string; schemaVersion: number }[] = [];
    const ctx = { emit: (e: { type: string; schemaVersion: number }) => seen.push(e) } as unknown as OperationContext;
    for (const type of Object.keys(protocolEventVersions) as ProtocolEventType[]) {
      // The payload is irrelevant to the stamp; the cast is this test's, not the engine's.
      emitProtocolEvent(ctx, { type, entity: { entityType: 'x', entityId: 'y' }, piiClass: 'none', payload: {} } as never);
    }
    expect(seen.map((e) => ({ type: e.type, schemaVersion: e.schemaVersion }))).toEqual(
      protocolManifest.events.emits.map((d) => ({ type: d.type, schemaVersion: d.schemaVersion })),
    );
  });
});
