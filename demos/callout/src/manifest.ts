import { moduleManifest, permissionKey } from '@substrat-run/contracts';

// ============================================================================
// The Callout vertical's declarative surface (spec/testrun.md §5.1): the
// permission keys, manifest metadata, event wiring, entity relations and
// entitlement. Everything a reader needs to understand the SHAPE of the
// vertical, with nothing executable to wade through — operations live in
// module.ts, the migration journal in migrations.ts.
//
// SC_PERM and the manifest's `permissions` list are the same keys expressed
// twice; keep them side by side so "add a permission" is a single-file edit.
// ============================================================================

export const SC_PERM = {
  customerManage: permissionKey.parse('customer:manage'),
  facilityManage: permissionKey.parse('facility:manage'),
};

export const calloutManifest = moduleManifest.parse({
  id: '@substrat-run/demo-callout',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'customer:manage', description: 'Manage customers and the price list' },
    { key: 'facility:manage', description: 'Manage facilities' },
  ],
  // protocol:* permissions and protocol.* events moved to
  // @substrat-run/engine-protocol at milestone B (engine-protocol.md §2).
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [
    { entityType: 'customer', readPermission: 'customer:manage' },
    { entityType: 'facility', readPermission: 'facility:manage' },
  ],
  entityRelations: [
    { entityType: 'facility', parentType: 'customer' },
    // The protocol engine is entity-agnostic; THIS vertical hangs protocols
    // off work orders, so it declares the permission-walk edge.
    { entityType: 'protocol', parentType: 'workorder' },
  ],
  entitlementKey: 'callout',
});
