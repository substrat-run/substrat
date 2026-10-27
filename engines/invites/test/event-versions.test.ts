/** Pinned shipped event versions; the suite checks the manifest and every emission. */
import { eventVersionSuite } from '@substrat-run/engine-test-kit/suites';
import { invitesEventVersions, emitInvitesEvent } from '../src/events.js';
import { invitesManifest } from '../src/index.js';

const SHIPPED = [
    { type: 'invites.sent', schemaVersion: 1 },
    { type: 'invites.accepted', schemaVersion: 1 },
    { type: 'invites.revoked', schemaVersion: 1 },
    { type: 'member.add-requested', schemaVersion: 1 },
];

eventVersionSuite({
  engine: 'invites',
  shipped: SHIPPED,
  manifest: invitesManifest,
  versions: invitesEventVersions,
  // The payload is irrelevant to the version stamp; only this test casts it.
  emit: (ctx, type) => emitInvitesEvent(ctx, { type, entity: { entityType: 'x', entityId: 'y' }, piiClass: 'none', payload: {} } as never),
});
