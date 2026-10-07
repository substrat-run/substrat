/**
 * The portal grant is a declared shape, so a key added to it reaches the customers who already
 * held it (#2083) — including the ones granted key by key before the shape grant existed.
 *
 * An instance as an older release left it: provisioned, one order, and Kerstin given a key of
 * the `customer` shape on her customer's record one key at a time, with no holder marker. The
 * shape the reconcile carries is the declared one grown by the key she lacks (`workorder:read`,
 * the key `callout/portal-orders` walks). Until the reconcile she sees nothing; after it she
 * sees the order, because the `'grantee'` holder found her by the key she already held.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformActorId, principalId, scopeId, tenantId, type Page } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { PROTOCOL_PERM as PROTO } from '@substrat-run/engine-protocol';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ENTITY_GRANTS, portalPerms, provisionCallout } from '../src/provision.js';
import { buildDemoHost } from '../src/seed.js';

let dir: string;
let host: SqliteScopeHost;
let orderId: string;
const staff = platformActorId.parse(ulid());
const owner = principalId.parse(ulid());
const kerstin = principalId.parse(ulid());
const node = { tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()) };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'callout-portal-shape-'));
  host = buildDemoHost(dir);
  await provisionCallout(host, { ...node, owner, slug: 'acme', name: 'Acme VVS' });
  const office = await host.getScope(owner, node.tenantId, node.scopeId);
  const customer = await office.invoke<{ id: string }>('callout/create-customer', { number: '1', name: 'BRF Acme' });
  const facility = await office.invoke<{ id: string }>('callout/create-facility', { customerId: customer.id, name: 'Huset' });
  orderId = (await office.invoke<{ id: string }>('callout/create-workorder', { facilityId: facility.id, kind: 'akut', title: 'Läcka' })).id;
  // The older shape, granted the old way: one key, no marker.
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
  (await (await host.getScope(kerstin, node.tenantId, node.scopeId)).invoke<Page<{ id: string }>>('callout/portal-orders')).entries.map(
    (o) => o.id,
  );

describe('a key the portal shape gains reaches a customer granted before markers (#2083)', () => {
  it('the declared shape is a bootstrap shape whose holder is whoever holds a key of it', () => {
    expect(ENTITY_GRANTS).toEqual([{ entityType: 'customer', permissions: portalPerms, bootstrap: true, holder: 'grantee' }]);
  });

  it('before the reconcile she sees nothing', async () => {
    expect(await sees()).toEqual([]);
  });

  it('after it, she sees her customer’s order', async () => {
    const grown = ENTITY_GRANTS.map((g) => ({ ...g, permissions: [PROTO.read, ...g.permissions] }));
    await host.admin.reconcileEntityGrantShapes(staff, node, grown);
    expect(await sees()).toEqual([orderId]);
  });
});
