/**
 * The contact portal is a declared shape, so a key added to it reaches the customers who already
 * held it (#2083) — including the ones a release before the shape grant gave it key by key, which
 * is every customer a deployed desk invited until now.
 *
 * Kerstin stands for one of them: a second person on the seeded customer's contact, holding one
 * key of an older shape (`contact:read`) written one key at a time, with no holder marker. A
 * contact names no principal, so nothing but the `'grantee'` holder could find her. The shape the
 * reconcile carries is `CONTACT_PORTAL` grown by that key. Before it she sees no conversation in
 * her portal; after it she sees exactly the customer's, the same list the seeded customer sees.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { principalId, type Page } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { T0_PERM } from '../src/manifest.js';
import { CONTACT_BOUND_ROLE, CONTACT_PORTAL, ENTITY_GRANTS } from '../src/provision.js';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
const kerstin = principalId.parse(ulid());

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-portal-shape-'));
  host = buildHost(dir);
  world = await seed(host);
  const desk = world.substrat;
  const node = { tenantId: desk.tenant, scopeId: desk.scope };
  await host.admin.assignRole(world.staff, { principalId: kerstin, roleKey: CONTACT_BOUND_ROLE, node });
  // An older shape, granted the old way: one key, no marker.
  await host.admin.grant(world.staff, {
    principalId: kerstin,
    permission: T0_PERM.contactRead,
    node,
    entity: { entityType: 'contact', entityId: desk.customerContactId },
    grantedBy: desk.admin.principal,
  });
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const portalOf = async (who: ReturnType<typeof principalId.parse>) =>
  ((await (await host.getScope(who, world.substrat.tenant, world.substrat.scope)).invoke('ticket0/my-conversations', {
    limit: 100,
  })) as Page<{ id: string }>).entries.map((c) => c.id);

describe('a key the contact portal gains reaches a customer granted before markers (#2083)', () => {
  it('the seeded customer receives one audited shape grant', async () => {
    const grants = await host.admin.auditLog(world.staff, {
      tenantId: world.substrat.tenant,
      scopeId: world.substrat.scope,
      action: 'grantEntityShape',
    });
    expect(grants.map((entry) => (entry.after as { principalId: string }).principalId)).toEqual([world.substrat.customer.principal]);
  });

  it('the contact shape is a bootstrap shape whose holder is whoever holds a key of it; a follower is shared', () => {
    expect(ENTITY_GRANTS).toEqual([
      { entityType: 'contact', permissions: CONTACT_PORTAL, bootstrap: true, holder: 'grantee' },
      { entityType: 'conversation', permissions: [T0_PERM.conversationRead] },
    ]);
  });

  it('before the reconcile she sees no conversation', async () => {
    expect(await portalOf(kerstin)).toEqual([]);
  });

  it('after it, she sees the customer’s conversations, as the customer does', async () => {
    const grown = ENTITY_GRANTS.map((g) => (g.bootstrap ? { ...g, permissions: [T0_PERM.contactRead, ...g.permissions] } : g));
    await host.admin.reconcileEntityGrantShapes(world.staff, { tenantId: world.substrat.tenant, scopeId: world.substrat.scope }, grown);
    const customers = await portalOf(world.substrat.customer.principal);
    expect(customers.length).toBeGreaterThan(0);
    expect(await portalOf(kerstin)).toEqual(customers);
  });
});
