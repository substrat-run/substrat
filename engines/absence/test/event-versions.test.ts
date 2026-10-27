/** Pinned shipped event versions; the suite checks the manifest and every emission. */
import { eventVersionSuite } from '@substrat-run/engine-test-kit/suites';
import { absenceEventVersions, emitAbsenceEvent } from '../src/events.js';
import { absenceManifest } from '../src/index.js';

const SHIPPED = [
    { type: 'absence.leave-type-configured', schemaVersion: 1 },
    { type: 'absence.entry-recorded', schemaVersion: 1 },
    { type: 'absence.requested', schemaVersion: 1 },
    { type: 'absence.decided', schemaVersion: 1 },
    { type: 'absence.cancelled', schemaVersion: 1 },
    { type: 'absence.expired', schemaVersion: 1 },
];

eventVersionSuite({
  engine: 'absence',
  shipped: SHIPPED,
  manifest: absenceManifest,
  versions: absenceEventVersions,
  // The payload is irrelevant to the version stamp; only this test casts it.
  emit: (ctx, type) => emitAbsenceEvent(ctx, { type, entity: { entityType: 'x', entityId: 'y' }, piiClass: 'none', payload: {} } as never),
});
