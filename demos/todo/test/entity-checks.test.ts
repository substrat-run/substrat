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
import { todoOperations } from '../spec/model.js';
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
  'todo',
  todoOperations,
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
  {
    // Only what the schema REQUIRES beyond the list id — the kit reads the input
    // shape and asks for nothing it can supply itself.
    inputs: {
      'todo/rename-list': { name: 'Renamed by the conformance kit' },
      'todo/add-item': { text: 'conformance item' },
      // A real person in the scope, as a literal — the seed's own address. The
      // world is not built when the suite is constructed.
      'todo/share-list': { email: 'ada@example.com' },
      // Any term above the prefix index's two-character floor. What is under test
      // is the entity check, which runs before the index is ever consulted — a
      // term matching nothing still proves Björn was let in or turned away.
      'todo/search-list-items': { q: 'conformance' },
    },
    // `share-list` opens on `list:manage` and honours it, then delegates
    // `list:contribute` to the invitee — and `ctx.grant` only narrows a
    // permission the caller HOLDS. Ada holds both on `owner:ada` through the
    // bootstrap grant, so no real owner ever notices; a principal granted
    // `list:manage` on one list alone is refused by that second gate.
    alsoGrant: {
      'todo/share-list': {
        permissions: ['list:contribute'],
        because:
          'the handler delegates list:contribute to the invitee via ctx.grant, and delegation ' +
          'only narrows a permission the caller already holds',
      },
    },
    // The three the kit cannot generate, and why. Asserted exactly: turning one
    // of the seven above into a `resolved` check fails here until this list says
    // so, which is the coverage loss made visible in the diff.
    //
    // `todo/search-items` is absent because it is out of scope rather than
    // uncovered: it declares `narrows`, so it claims no entity check for this
    // suite to honour. Its walk is proved by the scenario instead.
    uncovered: {
      'todo/set-item-done':
        "declares 'resolved' (the list the item is on) — the entity id is not in the input, " +
        'so the harness cannot reach the entity',
      'todo/delete-item':
        "declares 'resolved' (the list the item is on) — the entity id is not in the input, " +
        'so the harness cannot reach the entity',
      'todo/revoke-share':
        "declares 'resolved' (the list the share is on) — the entity id is not in the input, " +
        'so the harness cannot reach the entity',
    },
  },
);
