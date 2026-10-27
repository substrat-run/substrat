import { eventVersionSuite } from '@substrat-run/engine-test-kit/suites';
import { meteringEventVersions, emitMeteringEvent } from '../src/events.js';
import { meteringManifest } from '../src/index.js';

const SHIPPED = [
    { type: 'metering.meter-configured', schemaVersion: 1 },
    { type: 'metering.usage-recorded', schemaVersion: 1 },
    { type: 'metering.period-closed', schemaVersion: 1 },
];

eventVersionSuite({
  engine: 'metering',
  shipped: SHIPPED,
  manifest: meteringManifest,
  versions: meteringEventVersions,
  // The payload is irrelevant to the version stamp; only this test casts it.
  emit: (ctx, type) => emitMeteringEvent(ctx, { type, entity: { entityType: 'x', entityId: 'y' }, piiClass: 'none', payload: {} } as never),
});
