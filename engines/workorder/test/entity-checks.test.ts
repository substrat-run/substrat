/**
 * The one entity check this engine declares, driven against its handler.
 *
 * `workorder/get` is the only operation here that narrows — it declares
 * `permission: { key: 'workorder:read', entity: 'workorder', idFrom: 'orderId' }`
 * so a portal caller granted one order reaches that order and no other. The
 * remaining seven check the node, which is the honest description of what they
 * do, and they are correctly absent from both lists rather than reported as
 * gaps.
 *
 * One check is worth a suite because of who composes it: every vertical in the
 * repo binds `workorder/get`, and a node check here would let anyone holding
 * `workorder:read` read every order in the scope — which is the whole of a
 * customer portal's isolation.
 */
import { afterAll, beforeAll } from 'vitest';
import { permissionKey, type EntityRef, type PrincipalId } from '@substrat-run/contracts';
import { entityCheckConformanceSuite } from '@substrat-run/contract-tests';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import type { ScopeStub } from '@substrat-run/kernel';
import { createWorkOrder, workorderModule } from '../src/index.js';
import { workorderOperations } from '../src/operations.js';

const FACILITY: EntityRef = { entityType: 'facility', entityId: '01JFACILITY0000000000000000' };
const CUSTOMER: EntityRef = { entityType: 'customer', entityId: '01JCUSTOMER0000000000000000' };

let h: EngineHarness;
let probe: { principal: PrincipalId; stub: ScopeStub };

beforeAll(async () => {
  h = await engineHarness({ modules: [workorderModule] });
  // Nothing scope-wide: no role, no tuples. The grant this suite makes on one
  // order is the only authority this principal ever has.
  probe = await h.mintPrincipal();
});

afterAll(async () => {
  await h.close();
});

entityCheckConformanceSuite(
  'engine-workorder',
  workorderOperations,
  async () => ({
    async createEntity(entityType: string) {
      if (entityType !== 'workorder') throw new Error(`no factory for '${entityType}'`);
      const order = await h.run((ctx) =>
        createWorkOrder(ctx, {
          facility: FACILITY,
          customer: CUSTOMER,
          kind: 'service',
          title: 'conformance',
        }),
      );
      return order.id;
    },

    async grantOnEntity(permission: string, entity: EntityRef) {
      await h.grantOn(probe.principal, permissionKey.parse(permission), entity);
    },

    async invoke(operation: string, input: Record<string, unknown>) {
      return probe.stub.invoke(operation, input);
    },
  }),
);
