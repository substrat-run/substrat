/**
 * Every entity check Callout DECLARES, driven against the handler that serves it.
 *
 * Callout is the reference implementation, and until #865 it declared ten bare
 * permission strings while two of its handlers narrowed to an entity. The kit
 * found the consequence immediately: `callout/timeline` declared
 * `customer:manage` at the node and enforced `workorder:read` on the entity, so
 * the permission snapshot said a `technician` could not read a timeline that a
 * technician could read every time.
 *
 * The probe is a principal with NO role and NO grant — minted here, absent from
 * the seed's cast. That is what makes a pass mean something: the narrowed grant
 * this suite makes is the only authority the probe ever holds, so case 1 cannot
 * be satisfied by a scope-wide key it happened to have.
 */
import { afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionKey, platformActorId, principalId, type EntityRef } from '@substrat-run/contracts';
import { entityCheckConformanceSuite } from '@substrat-run/contract-tests';
import { ulid } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildDemoHost, seedDemo, type DemoWorld } from '../src/index.js';
import { calloutOperations } from '../src/operations.js';

let dir: string;
let host: SqliteScopeHost;
let w: DemoWorld;

/** No role, no grant, not in the cast — see the header. */
const probe = principalId.parse(ulid());
/** The control-plane dev actor every admin mutation is stamped with (seed.ts). */
const staff = platformActorId.parse(ulid());

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'callout-entity-checks-'));
  host = buildDemoHost(dir);
  w = await seedDemo(host, dir);
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

entityCheckConformanceSuite(
  'callout',
  calloutOperations,
  async () => ({
    async createEntity(entityType: string) {
      if (entityType !== 'workorder') throw new Error(`no factory for '${entityType}'`);
      const anna = await host.getScope(w.anna, w.t1, w.s1);
      const order = await anna.invoke<{ id: string }>('callout/create-workorder', {
        facilityId: w.forskolanId,
        kind: 'akut',
        title: 'Conformance',
      });
      return order.id;
    },

    async grantOnEntity(permission: string, entity: EntityRef) {
      // The ADMIN grant. Callout's own portal grants are made per CUSTOMER and
      // reach an order through link resolution; using that path would prove the
      // link works, not that the handler narrows.
      await host.admin.grant(staff, {
        principalId: probe,
        permission: permissionKey.parse(permission),
        node: { tenantId: w.t1, scopeId: w.s1 },
        entity,
        grantedBy: w.anna,
      });
    },

    async invoke(operation: string, input: Record<string, unknown>) {
      const stub = await host.getScope(probe, w.t1, w.s1);
      return stub.invoke(operation, input);
    },
  }),
  {
    inputs: {
      // The handler is entity-agnostic and the declaration cannot yet say so, so
      // the type it is driven with is supplied here — the same constant every
      // call site in the app and the scenario passes.
      'callout/timeline': { entityType: 'workorder' },
    },
    // `callout/portal-orders` is absent rather than uncovered: it declares
    // `narrows`, so it claims no single entity check for this suite to honour.
    // Its per-row proof walk is what the scenario's portal-isolation beat proves.
    uncovered: {},
  },
);
