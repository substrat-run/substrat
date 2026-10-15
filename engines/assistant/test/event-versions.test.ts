/**
 * #1597 — one home for each event's `schemaVersion`.
 *
 * `assistantEventVersions` is what `emitAssistantEvent` stamps and what the manifest's
 * `emits` is read from. The pinned list below is the manifest as it first shipped: a version
 * bumped by accident, or a type dropped, fails here instead of quietly changing what a
 * deployed consumer parses.
 */
import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@substrat-run/kernel';
import { assistantEventVersions, emitAssistantEvent, type AssistantEventType } from '../src/events.js';
import { assistantManifest } from '../src/index.js';

const SHIPPED = [
  { type: 'assistant.thread-created', schemaVersion: 1 },
  { type: 'assistant.turn-started', schemaVersion: 1 },
  { type: 'assistant.turn-finished', schemaVersion: 1 },
  { type: 'assistant.approval-requested', schemaVersion: 1 },
  { type: 'assistant.approval-resolved', schemaVersion: 1 },
  { type: 'assistant.thread-closed', schemaVersion: 1 },
];

describe('assistant: event schemaVersion has one home', () => {
  it('the manifest emits exactly what shipped, in the same order', () => {
    expect(assistantManifest.events.emits).toEqual(SHIPPED);
  });

  it('every emission carries the version the manifest declares for its type', () => {
    const seen: { type: string; schemaVersion: number }[] = [];
    const ctx = { emit: (e: { type: string; schemaVersion: number }) => seen.push(e) } as unknown as OperationContext;
    for (const type of Object.keys(assistantEventVersions) as AssistantEventType[]) {
      // The payload is irrelevant to the stamp; the cast is this test's, not the engine's.
      emitAssistantEvent(ctx, { type, entity: { entityType: 'x', entityId: 'y' }, piiClass: 'none', payload: {} } as never);
    }
    expect(seen.map((e) => ({ type: e.type, schemaVersion: e.schemaVersion }))).toEqual(
      assistantManifest.events.emits.map((d) => ({ type: d.type, schemaVersion: d.schemaVersion })),
    );
  });
});
