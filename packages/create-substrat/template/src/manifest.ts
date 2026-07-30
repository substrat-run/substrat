import { moduleManifest, permissionKey } from '@substrat-run/contracts';

// ============================================================================
// The vertical's MANIFEST — the reviewable contract the kernel reads at
// registration. A minimal bike-repair shop composed onto two engines:
//
//   engine-workorder  — the repair's state machine and append-only lines
//   engine-invoicing  — turns a completed repair into an invoice basis, by EVENT
//
// This vertical owns only vocabulary (customers, bikes, a price list) and the
// PRICING MOMENT. Every invariant that matters — a repair can't skip states,
// a completed repair is immutable, every mutation emits an event — lives in the
// engine. Read CLAUDE.md / AGENTS.md before you touch it.
// ============================================================================

/** The vertical's own permission keys (the engines declare their own). */
export const SHOP_PERM = {
  customerManage: permissionKey.parse('customer:manage'),
  bikeManage: permissionKey.parse('bike:manage'),
};

export const bikeShopManifest = moduleManifest.parse({
  id: 'bikeshop',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'customer:manage', description: 'Manage customers and the workshop price list' },
    { key: 'bike:manage', description: "Register and manage customers' bikes" },
  ],
  // The vertical emits and consumes no events of its own: the invoicing engine
  // consumes the WORKORDER engine's `workorder.completed` directly (star
  // topology — engines cooperate by event, never by import).
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [
    { entityType: 'customer', readPermission: 'customer:manage' },
    { entityType: 'bike', readPermission: 'bike:manage' },
  ],
  // The portal permission walk is workorder → bike → customer. The engine links
  // workorder → <facility ref>; in this vertical that facility ref IS a bike, so
  // the vertical declares BOTH of its own edges. An entity-narrowed
  // `workorder:read` grant on a customer then resolves all the way up.
  entityRelations: [
    { entityType: 'bike', parentType: 'customer' },
    { entityType: 'workorder', parentType: 'bike' },
  ],
  entitlementKey: 'bikeshop',
});
