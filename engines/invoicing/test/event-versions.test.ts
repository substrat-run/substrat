/** Pinned shipped event versions; the suite checks the manifest and every emission. */
import { eventVersionSuite } from '@substrat-run/engine-test-kit/suites';
import { invoicingEventVersions, emitInvoicingEvent } from '../src/events.js';
import { invoicingManifest } from '../src/index.js';

const SHIPPED = [
    { type: 'invoicing.underlag-updated', schemaVersion: 1 },
    { type: 'invoicing.underlag-exported', schemaVersion: 2 },
];

eventVersionSuite({
  engine: 'invoicing',
  shipped: SHIPPED,
  manifest: invoicingManifest,
  versions: invoicingEventVersions,
  // The payload is irrelevant to the version stamp; only this test casts it.
  emit: (ctx, type) => emitInvoicingEvent(ctx, { type, entity: { entityType: 'x', entityId: 'y' }, piiClass: 'none', payload: {} } as never),
});
