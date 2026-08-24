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
      const anna = await host.getScope(w.anna, w.t1, w.s1);
      const order = await anna.invoke<{ id: string }>('callout/create-workorder', {
        facilityId: w.forskolanId,
        kind: 'akut',
        title: 'Conformance',
      });
      if (entityType === 'workorder') return order.id;
      if (entityType === 'protocol') {
        // `callout/timeline` reads the spine of a protocol as well as of an order
        // (#890), so the kit asks for one — on an order of its own, since the
        // engine allows a single open instance per (template, entity).
        const instance = await anna.invoke<{ id: string }>('callout/instantiate-protocol', {
          templateKey: 'self-inspection-electrical',
          entityType: 'workorder',
          entityId: order.id,
        });
        return instance.id;
      }
      throw new Error(`no factory for '${entityType}'`);
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
    // No `inputs` at all. `callout/timeline` needed `{ entityType: 'workorder' }`
    // until #890, and that entry was doing two jobs badly: supplying a constant the
    // schema could state, and silently choosing WHICH of the operation's types got
    // driven. It declares `entityFrom` now, so the kit reads both admissible types
    // off the schema and drives the pair over each — a work order and a protocol.
    //
    // `callout/portal-orders` is absent rather than uncovered: it declares
    // `narrows`, so it claims no single entity check for this suite to honour.
    // Its per-row proof walk is what the scenario's portal-isolation beat proves.
    uncovered: {},
  },
);
