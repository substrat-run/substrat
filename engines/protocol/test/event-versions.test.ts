import { eventVersionSuite } from '@substrat-run/engine-test-kit/suites';
import { protocolEventVersions, emitProtocolEvent } from '../src/events.js';
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

eventVersionSuite({
  engine: 'protocol',
  shipped: SHIPPED,
  manifest: protocolManifest,
  versions: protocolEventVersions,
  // The payload is irrelevant to the version stamp; only this test casts it.
  emit: (ctx, type) => emitProtocolEvent(ctx, { type, entity: { entityType: 'x', entityId: 'y' }, piiClass: 'none', payload: {} } as never),
});
