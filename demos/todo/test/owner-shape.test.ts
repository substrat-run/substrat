/**
 * The owner grant is a declared shape, so a key added to it reaches the people who already
 * held it (#2071).
 *
 * Eve is given the owner grant as it stood BEFORE #119 added `list:archive` and `list:trash`,
 * which is what every person seeded before that release holds. She cannot archive her own list.
 * The boot-time reconcile (`reconcileOwnerGrants`, what the dev server runs and what a deployed
 * install's provision does) tops her up, and then she can.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorCodeOf, permissionKey, principalId } from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import { buildHost, reconcileOwnerGrants, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
let eve: ScopeStub;
let groceries: string;

const codeOf = (call: Promise<unknown>) => call.then(() => 'answered', errorCodeOf);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'todo-owner-shape-'));
  host = buildHost(dir);
  world = await seed(host);

  const eveId = principalId.parse(ulid());
  const node = { tenantId: world.tenant, scopeId: world.scope };
  await host.admin.assignRole(world.staff, { principalId: eveId, roleKey: 'member', node });
  eve = await host.getScope(eveId, world.tenant, world.scope);
  await eve.invoke('todo/join', { email: 'eve@example.com', displayName: 'Eve' });
  // The owner shape as it was before #119.
  await host.admin.grantEntityShape(world.staff, {
    principalId: eveId,
    node,
    entity: { entityType: 'owner', entityId: eveId },
    permissions: ['list:manage', 'list:contribute'].map((k) => permissionKey.parse(k)),
    grantedBy: eveId,
  });
  groceries = (await eve.invoke<{ id: string }>('todo/create-list', { name: 'Groceries' })).id;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a key added to the owner grant reaches an owner granted before it', () => {
  it('before the reconcile, Eve cannot archive her own list', async () => {
    expect(await codeOf(eve.invoke('todo/archive-list', { listId: groceries }))).toBe('permission_denied');
  });

  it('after it, she can — and can bin it too', async () => {
    await reconcileOwnerGrants(host, world);
    expect(await eve.invoke('todo/archive-list', { listId: groceries })).toEqual({ id: groceries, state: 'archived' });
    expect(await eve.invoke('todo/trash-list', { listId: groceries })).toMatchObject({ id: groceries, state: 'trashed' });
  });

  it('a second reconcile changes nothing for anyone', async () => {
    const log = async () => (await host.admin.auditLog(world.staff, { tenantId: world.tenant })).filter((e) => e.action === 'reconcileEntityGrantShapes');
    const before = (await log()).length;
    await reconcileOwnerGrants(host, world);
    expect((await log()).length).toBe(before);
  });
});
