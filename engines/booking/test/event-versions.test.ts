/** Pinned shipped event versions; the suite checks the manifest and every emission. */
import { eventVersionSuite } from '@substrat-run/engine-test-kit/suites';
import { bookingEventVersions, emitBookingEvent } from '../src/events.js';
import { bookingManifest } from '../src/index.js';

const SHIPPED = [
    { type: 'booking.held', schemaVersion: 1 },
    { type: 'booking.confirmed', schemaVersion: 1 },
    { type: 'booking.expired', schemaVersion: 1 },
    { type: 'booking.cancelled', schemaVersion: 1 },
    { type: 'booking.moved', schemaVersion: 1 },
    { type: 'booking.started', schemaVersion: 1 },
    { type: 'booking.completed', schemaVersion: 1 },
    { type: 'booking.no-show', schemaVersion: 1 },
    { type: 'booking.participant-joined', schemaVersion: 1 },
    { type: 'booking.participant-left', schemaVersion: 1 },
    { type: 'booking.opened', schemaVersion: 1 },
    { type: 'booking.resource-created', schemaVersion: 1 },
];

eventVersionSuite({
  engine: 'booking',
  shipped: SHIPPED,
  manifest: bookingManifest,
  versions: bookingEventVersions,
  // The payload is irrelevant to the version stamp; only this test casts it.
  emit: (ctx, type) => emitBookingEvent(ctx, { type, entity: { entityType: 'x', entityId: 'y' }, piiClass: 'none', payload: {} } as never),
});
