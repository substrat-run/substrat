/**
 * The contact portal is a declared BINDING shape (#2083, #1686): a customer's portal is what the
 * shape gives the person their contact's `principal` names, and they are bound to it by a
 * customer invite — a link the desk-admin mints with `contact:invite` on that contact.
 *
 * What is held here, on the seeded desk (which binds its customer through exactly that link):
 * - the seeded customer is bound — the contact names them, and their portal lists their history;
 * - a key the shape gains reaches them at the next reconcile, once;
 * - the portal's keys come from the column alone: a direct grant of one on a contact is refused,
 *   while a key outside the shape is not;
 * - unbinding takes the portal away, and leaves the contact free for a new invite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { principalId, type Page } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { T0_PERM } from '../src/manifest.js';
import { CONTACT_BOUND_ROLE, CONTACT_PORTAL, ENTITY_GRANTS } from '../src/provision.js';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: SqliteScopeHost;
let world: World;
const kerstin = principalId.parse(ulid());

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-portal-shape-'));
  host = buildHost(dir);
  world = await seed(host);
  await host.admin.assignRole(world.staff, { principalId: kerstin, roleKey: CONTACT_BOUND_ROLE, node: node() });
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const node = () => ({ tenantId: world.substrat.tenant, scopeId: world.substrat.scope });
const contact = () => ({ entityType: 'contact', entityId: world.substrat.customerContactId });
const portalOf = async (who: ReturnType<typeof principalId.parse>) =>
  ((await (await host.getScope(who, world.substrat.tenant, world.substrat.scope)).invoke('ticket0/my-conversations', {
    limit: 100,
  })) as Page<{ id: string }>).entries.map((c) => c.id);
const principalOfContact = async () =>
  ((await (await host.getScope(world.substrat.admin.principal, world.substrat.tenant, world.substrat.scope)).invoke('ticket0/get-contact', {
    contactId: world.substrat.customerContactId,
  })) as { principal: string | null }).principal;

describe('the contact portal is a binding shape (#2083, #1686)', () => {
  it('is declared as one: bootstrap, held by the contact’s principal, bound with contact:invite; a follower is shared', () => {
    expect(ENTITY_GRANTS).toEqual([
      {
        entityType: 'contact',
        permissions: CONTACT_PORTAL,
        bootstrap: true,
        holder: { table: 'ticket0_contacts', idColumn: 'id', principalColumn: 'principal' },
        bind: { permission: T0_PERM.contactInvite },
      },
      { entityType: 'conversation', permissions: [T0_PERM.conversationRead] },
    ]);
  });

  it('the seeded customer is bound by their invite: the contact names them and their portal lists their history', async () => {
    expect(await principalOfContact()).toBe(world.substrat.customer.principal);
    expect((await portalOf(world.substrat.customer.principal)).length).toBeGreaterThan(0);
  });

  it('a key the shape gains reaches the bound customer at the next reconcile, once', async () => {
    const grown = ENTITY_GRANTS.map((g) => (g.bootstrap ? { ...g, permissions: [T0_PERM.contactRead, ...g.permissions] } : g));
    expect((await host.admin.reconcileEntityGrantShapes(world.staff, node(), grown)).toppedUp).toBe(1);
    expect((await host.admin.reconcileEntityGrantShapes(world.staff, node(), grown)).toppedUp).toBe(0);
    await host.admin.reconcileEntityGrantShapes(world.staff, node(), ENTITY_GRANTS);
  });

  it('a direct grant of a portal key on a contact is refused, a key the shape once carried too; a key it never carried is not', async () => {
    await expect(
      host.admin.grant(world.staff, { principalId: kerstin, permission: T0_PERM.conversationReadOwn, node: node(), entity: contact(), grantedBy: world.substrat.admin.principal }),
    ).rejects.toThrow(/given only by the shape grant/);
    expect(await portalOf(kerstin)).toEqual([]);
    // A key the shape carried once — `contact:read`, in the grown shape above — stays refused on a
    // type that has bound, whatever the registry says now (#1686).
    await expect(
      host.admin.grant(world.staff, { principalId: kerstin, permission: T0_PERM.contactRead, node: node(), entity: contact(), grantedBy: world.substrat.admin.principal }),
    ).rejects.toThrow(/given only by the shape grant/);
    await host.admin.grant(world.staff, { principalId: kerstin, permission: T0_PERM.kbRead, node: node(), entity: contact(), grantedBy: world.substrat.admin.principal });
  });

  it('unbinding takes the portal away, and frees the contact for a new invite', async () => {
    const customer = world.substrat.customer.principal;
    expect(await host.unbindEntityHolderBounded(world.substrat.tenant, world.substrat.scope, world.substrat.admin.principal, contact())).toEqual({
      ok: true,
      unbound: [customer],
    });
    expect(await principalOfContact()).toBeNull();
    expect(await portalOf(customer)).toEqual([]);
    // An agent holds no contact:invite: refused, naming it.
    expect(await host.unbindEntityHolderBounded(world.substrat.tenant, world.substrat.scope, world.substrat.agent.principal, contact())).toEqual({
      ok: false,
      coverage: { covered: false, missing: [T0_PERM.contactInvite] },
    });
  });
});
