/**
 * Every entity check todo DECLARES, driven against the handler that serves it.
 *
 * The declaration (`spec/model.ts`) says `permission: { key: 'list:manage',
 * entity: 'list', idFrom: 'listId' }`. Nothing in the type system makes the
 * handler honour that: `ctx.check(perm)` without the entity typechecks and lets
 * every member reach every list. `entityCheckConformanceSuite` generates the
 * behavioural pair that separates the two, for each operation, from the
 * declaration itself — see its header for what each case does and does not
 * catch.
 *
 * The world here is deliberately asymmetric. Ada creates the lists; the probe is
 * **Björn**, who holds `list:manage` and `list:contribute` only through the
 * bootstrap grant on his OWN `owner` entity — so nothing he holds reaches a list
 * of Ada's until this suite grants it, one list at a time. That is what makes a
 * pass mean something: the grant under test is the only thing that could have
 * allowed him in.
 */
import { afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionKey, type EntityRef } from '@substrat-run/contracts';
import { entityCheckConformanceSuite } from '@substrat-run/contract-tests';
import type { ScopeHost } from '@substrat-run/kernel';
import { conformance } from './conformance.js';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'todo-entity-checks-'));
  host = buildHost(dir);
  world = await seed(host);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

entityCheckConformanceSuite(
  conformance.subject,
  conformance.operations,
  async () => ({
    async createEntity(entityType: string) {
      if (entityType !== 'list') throw new Error(`no factory for '${entityType}'`);
      const ada = await host.getScope(world.ada.principal, world.tenant, world.scope);
      const list = await ada.invoke<{ id: string }>('todo/create-list', { name: 'Conformance' });
      return list.id;
    },

    async grantOnEntity(permission: string, entity: EntityRef) {
      // The ADMIN grant, not `todo/share-list`. Setting the test up through the
      // vertical's own sharing operation would make `share-list`'s case prove
      // only that it agrees with itself.
      await host.admin.grant(world.staff, {
        principalId: world.bjorn.principal,
        permission: permissionKey.parse(permission),
        node: { tenantId: world.tenant, scopeId: world.scope },
        entity,
        grantedBy: world.ada.principal,
      });
    },

    async invoke(operation: string, input: Record<string, unknown>) {
      const bjorn = await host.getScope(world.bjorn.principal, world.tenant, world.scope);
      return bjorn.invoke(operation, input);
    },
  }),
  conformance,
);
