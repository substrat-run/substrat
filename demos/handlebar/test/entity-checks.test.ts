/**
 * Every entity check Handlebar DECLARES, driven against the handler that serves it.
 *
 * One operation narrows: `bike-shop/timeline` checks `workorder:read` on the
 * entity it is asked about, so a portal customer reaches their own repair's
 * history and nobody else's. Until #865 it declared that check at the NODE —
 * right key, wrong shape — which read as "any holder of `workorder:read` reads
 * any repair's timeline", the portal's isolation stated backwards.
 *
 * The probe holds no role and no grant; the narrowed grant this suite makes is
 * the only authority it ever has. See Callout's suite for the same note at length.
 */
import { afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionKey, platformActorId, principalId, type EntityRef } from '@substrat-run/contracts';
import { entityCheckConformanceSuite } from '@substrat-run/contract-tests';
import { ulid } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { buildBikeShopHost, seedBikeShop, type BikeShopWorld } from '../src/index.js';
import { handlebarOperations } from '../src/operations.js';

let dir: string;
let host: SqliteScopeHost;
let w: BikeShopWorld;

const probe = principalId.parse(ulid());
const staff = platformActorId.parse(ulid());

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'handlebar-entity-checks-'));
  host = buildBikeShopHost(dir);
  w = await seedBikeShop(host, dir);
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

entityCheckConformanceSuite(
  'handlebar',
  handlebarOperations,
  async () => ({
    async createEntity(entityType: string) {
      if (entityType !== 'workorder') throw new Error(`no factory for '${entityType}'`);
      const greta = await host.getScope(w.greta, w.t1, w.s1);
      const repair = await greta.invoke<{ id: string }>('bike-shop/create-repair', {
        bikeId: w.crescentId,
        kind: 'service',
        title: 'Conformance',
      });
      return repair.id;
    },

    async grantOnEntity(permission: string, entity: EntityRef) {
      // The ADMIN grant, not the portal grant the seed makes per customer: that
      // one reaches a repair through link resolution, which would prove the link
      // rather than the narrowing.
      await host.admin.grant(staff, {
        principalId: probe,
        permission: permissionKey.parse(permission),
        node: { tenantId: w.t1, scopeId: w.s1 },
        entity,
        grantedBy: w.greta,
      });
    },

    async invoke(operation: string, input: Record<string, unknown>) {
      const stub = await host.getScope(probe, w.t1, w.s1);
      return stub.invoke(operation, input);
    },
  }),
  {
    // The constant the server supplies by hand on the mounted route — the point
    // at which this vertical stops being entity-agnostic (`app/src/api.ts`).
    inputs: { 'bike-shop/timeline': { entityType: 'workorder' } },
    uncovered: {},
  },
);
