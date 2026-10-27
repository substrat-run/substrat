/** Pinned shipped event versions; the suite checks the manifest and every emission. */
import { eventVersionSuite } from '@substrat-run/engine-test-kit/suites';
import { workorderEventVersions, emitWorkorderEvent } from '../src/events.js';
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

eventVersionSuite({
  engine: 'workorder',
  shipped: SHIPPED,
  manifest: workorderManifest,
  versions: workorderEventVersions,
  // The payload is irrelevant to the version stamp; only this test casts it.
  emit: (ctx, type) => emitWorkorderEvent(ctx, { type, entity: { entityType: 'x', entityId: 'y' }, piiClass: 'none', payload: {} } as never),
});
