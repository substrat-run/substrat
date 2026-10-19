/**
 * #1597 — one home for each event's `schemaVersion`. The pinned list is the manifest as it
 * first ships: a version bumped by accident, or a type dropped, fails here.
 */
import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@substrat-run/kernel';
import { emitNotificationsEvent, notificationsEventVersions, type NotificationsEventType } from '../src/events.js';
import { notificationsManifest } from '../src/index.js';

const SHIPPED = [
  { type: 'notifications.delivery-recorded', schemaVersion: 1 },
  { type: 'notifications.delivery-settled', schemaVersion: 1 },
  { type: 'notifications.preference-set', schemaVersion: 1 },
  { type: 'notifications.recipient-updated', schemaVersion: 1 },
  { type: 'notifications.topic-recorded', schemaVersion: 1 },
  // #118: added, never a bump — every shipped type keeps its version.
  { type: 'notifications.digest-sent', schemaVersion: 1 },
];

describe('notifications: event schemaVersion has one home', () => {
  it('the manifest emits exactly what shipped, in the same order', () => {
    expect(notificationsManifest.events.emits).toEqual(SHIPPED);
  });

  it('every emission carries the version the manifest declares for its type', () => {
    const seen: { type: string; schemaVersion: number }[] = [];
    const ctx = { emit: (e: { type: string; schemaVersion: number }) => seen.push(e) } as unknown as OperationContext;
    for (const type of Object.keys(notificationsEventVersions) as NotificationsEventType[]) {
      // The payload is irrelevant to the stamp; the cast is this test's, not the engine's.
      emitNotificationsEvent(ctx, { type, entity: { entityType: 'x', entityId: 'y' }, piiClass: 'none', payload: {} } as never);
    }
    expect(seen.map((e) => ({ type: e.type, schemaVersion: e.schemaVersion }))).toEqual(SHIPPED);
  });
});
