/**
 * The portal grant is a declared shape, so the keys it gained reach the customers who already
 * held part of it (#2083) — including the ones granted key by key before the shape grant existed.
 *
 * An instance as an older release left it: provisioned, one repair, and Kerstin given ONE key of
 * the `customer` shape (`protocol:read`) on her customer's record, with no holder marker. The
 * reconcile carries the shape exactly as declared. Until it runs she cannot see the repair, which
 * `bike-shop/portal-repairs` walks with `workorder:read`; after it she can, because the
 * `'grantee'` holder found her by the key she already held.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformActorId, principalId, scopeId, tenantId, type Page } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { PROTOCOL_PERM as PROTO } from '@substrat-run/engine-protocol';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildBikeShopHost, ENTITY_GRANTS, provisionHandlebar } from '../src/seed.js';

let dir: string;
let host: SqliteScopeHost;
let repairId: string;
const staff = platformActorId.parse(ulid());
const owner = principalId.parse(ulid());
const kerstin = principalId.parse(ulid());
const node = { tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()) };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'handlebar-portal-shape-'));
  host = buildBikeShopHost(dir);
  await provisionHandlebar(host, { ...node, owner, slug: 'acme', name: 'Acme Cykel' });
  const shop = await host.getScope(owner, node.tenantId, node.scopeId);
  const customer = await shop.invoke<{ id: string }>('bike-shop/create-customer', { number: '1', name: 'Kerstin' });
  const bike = await shop.invoke<{ id: string }>('bike-shop/register-bike', { customerId: customer.id, label: 'Crescent' });
  repairId = (await shop.invoke<{ id: string }>('bike-shop/create-repair', { bikeId: bike.id, kind: 'punktering', title: 'Punktering' })).id;
  // An older, smaller shape, granted the old way: one key, no marker.
  await host.admin.grant(staff, {
    principalId: kerstin,
    permission: PROTO.read,
    node,
    entity: { entityType: 'customer', entityId: customer.id },
    grantedBy: owner,
  });
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

const sees = async () =>
  (await (await host.getScope(kerstin, node.tenantId, node.scopeId)).invoke<Page<{ id: string }>>('bike-shop/portal-repairs')).entries.map(
    (o) => o.id,
  );

describe('the keys the portal shape gained reach a customer granted before markers (#2083)', () => {
  it('the declared shape is a bootstrap shape whose holder is whoever holds a key of it', () => {
    expect(ENTITY_GRANTS).toMatchObject([{ entityType: 'customer', bootstrap: true, holder: 'grantee' }]);
  });

  it('before the reconcile she cannot see her repair', async () => {
    expect(await sees()).toEqual([]);
  });

  it('after it, she can', async () => {
    await host.admin.reconcileEntityGrantShapes(staff, node, ENTITY_GRANTS);
    expect(await sees()).toEqual([repairId]);
  });
});
