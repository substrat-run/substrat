import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, type Page } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { INVOICING_PERM as INV } from '@substrat-run/engine-invoicing';
import { buildBikeShopHost, ENTITY_GRANTS, seedBikeShop, type BikeShopWorld } from '../src/seed.js';
import { portalPerms } from '../src/provision.js';

// ============================================================================
// The portal grant is a declared SHAPE (`ENTITY_GRANTS`), so a key you add to
// `portalPerms` reaches the customers who already hold it — including ones a
// release before the shape grant gave it key by key.
//
// The second shop (t2) stands for one an older release left behind: never
// reconciled, one repair, and Kerstin given one key of an older shape on her
// customer's record, with no holder marker. The reconcile carries the shape
// grown by the key she lacks (`workorder:read`, the key `shop/portal-repairs`
// walks). Before it she sees nothing; after it she sees her repair.
// ============================================================================

describe('a key the portal shape gains reaches a customer granted before markers', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: BikeShopWorld;
  let repairId: string;
  const staff = platformActorId.parse(ulid());
  const kerstin = principalId.parse(ulid());

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bike-shop-portal-shape-'));
    host = buildBikeShopHost(dir);
    w = await seedBikeShop(host, dir);
    const shop = await host.getScope(w.rutger, w.t2, w.s2);
    const customer = await shop.invoke<{ id: string }>('shop/create-customer', { number: '1', name: 'Kerstin' });
    const bike = await shop.invoke<{ id: string }>('shop/register-bike', { customerId: customer.id, label: 'Crescent' });
    repairId = (await shop.invoke<{ id: string }>('shop/create-repair', { bikeId: bike.id, kind: 'punktering', title: 'Punktering' })).id;
    await host.admin.grant(staff, {
      principalId: kerstin,
      permission: INV.read,
      node: { tenantId: w.t2, scopeId: w.s2 },
      entity: { entityType: 'customer', entityId: customer.id },
      grantedBy: w.rutger,
    });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const sees = async () =>
    (await (await host.getScope(kerstin, w.t2, w.s2)).invoke<Page<{ id: string }>>('shop/portal-repairs')).entries.map((o) => o.id);

  it('the shape is declared bootstrap, and its holder is whoever holds a key of it', () => {
    expect(ENTITY_GRANTS).toEqual([{ entityType: 'customer', permissions: portalPerms, bootstrap: true, holder: 'grantee' }]);
  });

  it('before the reconcile she sees nothing', async () => {
    expect(await sees()).toEqual([]);
  });

  it('after it, she sees her repair', async () => {
    const grown = ENTITY_GRANTS.map((g) => ({ ...g, permissions: [INV.read, ...g.permissions] }));
    await host.admin.reconcileEntityGrantShapes(staff, { tenantId: w.t2, scopeId: w.s2 }, grown);
    expect(await sees()).toEqual([repairId]);
  });
});
