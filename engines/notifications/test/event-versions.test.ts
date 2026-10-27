import { expect } from 'vitest';
import { eventVersionSuite } from '@substrat-run/engine-test-kit/suites';
import { notificationsEventVersions, emitNotificationsEvent } from '../src/events.js';
import { notificationsManifest } from '../src/index.js';

const SHIPPED = [
  { type: 'notifications.delivery-recorded', schemaVersion: 1 },
  { type: 'notifications.delivery-settled', schemaVersion: 1 },
  { type: 'notifications.preference-set', schemaVersion: 1 },
  { type: 'notifications.recipient-updated', schemaVersion: 1 },
  { type: 'notifications.topic-recorded', schemaVersion: 1 },
  // #118: added, never a bump — every shipped type keeps its version.
  { type: 'notifications.digest-sent', schemaVersion: 1 },
  { type: 'notifications.digest-failed', schemaVersion: 1 },
  { type: 'notifications.digest-quarantined', schemaVersion: 1 },
  { type: 'notifications.digest-released', schemaVersion: 1 },
  { type: 'notifications.digest-withdrawn', schemaVersion: 1 },
];

eventVersionSuite({
  engine: 'notifications',
  shipped: SHIPPED,
  manifest: notificationsManifest,
  versions: notificationsEventVersions,
  // The payload is irrelevant to the version stamp; only this test casts it.
  emit: (ctx, type) => emitNotificationsEvent(ctx, { type, entity: { entityType: 'x', entityId: 'y' }, piiClass: 'none', payload: {} } as never),
  assertEmitted: (events) => expect(events.map(({ type, schemaVersion }) => ({ type, schemaVersion }))).toEqual(SHIPPED),
});
