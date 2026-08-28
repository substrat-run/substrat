import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EntityRef, PermissionKey } from '@substrat-run/contracts';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  createWorkOrder,
  workorderModule,
  workorderOperations,
  WORKORDER_PERMISSIONS,
} from '../src/index.js';

/**
 * The declared permission is the checked permission (#960).
 *
 * `workorder/start` declared `workorder:assign` while its handler checked
 * `workorder:report`. The declaration is what every artifact reads — the
 * conformance receipt, `lint:permissions`, a vertical binding the operation
 * with `defineEngineRoutes` — so a role widened on the strength of it could
 * not start work, and the human permission-diff checkpoint reviewed the wrong
 * key. Nothing failed, because nothing compared the two.
 *
 * This does, for every operation the engine declares: a principal holding ONLY
 * the declared key is not refused on permission grounds, and a principal
 * holding every OTHER key is. The input map is keyed by the declaration, so an
 * operation added without a row here is a compile error rather than a gap.
 */

const FACILITY: EntityRef = { entityType: 'facility', entityId: '01JFACILITY0000000000000000' };
const CUSTOMER: EntityRef = { entityType: 'customer', entityId: '01JCUSTOMER0000000000000000' };

type OpName = keyof typeof workorderOperations;

/**
 * Plausible input per operation — enough to get past the permission check,
 * which is the first line of every handler. A business refusal after it
 * (`invalid transition` on a completion of a planned order) is not a
 * permission answer and is deliberately not read as one.
 */
const INPUTS: { [K in OpName]: (orderId: string) => unknown } = {
  'workorder/get': (orderId) => ({ orderId }),
  'workorder/list': () => undefined,
  // A ULID: the assignment event names the technician as its data subject.
  'workorder/assign': (orderId) => ({ orderId, technician: '01JTEKN1KER000000000000000' }),
  'workorder/start': (orderId) => ({ orderId }),
  'workorder/report-time': (orderId) => ({ orderId, hours: '1' }),
  'workorder/report-material': (orderId) => ({ orderId, article: 'artikel', qty: '1' }),
  'workorder/complete': (orderId) => ({ orderId, billable: [] }),
  'workorder/close': (orderId) => ({ orderId }),
};

const declaredKey = (name: OpName): PermissionKey => {
  const p = (workorderOperations[name] as { permission: string | { key: string } }).permission;
  return (typeof p === 'string' ? p : p.key) as PermissionKey;
};

const DENIED = /permission denied/;

describe('engine-workorder: declared permission = checked permission', () => {
  let h: EngineHarness;
  let orderId: string;

  beforeEach(async () => {
    h = await engineHarness({ modules: [workorderModule] });
    const order = await h.run((ctx) =>
      createWorkOrder(ctx, { facility: FACILITY, customer: CUSTOMER, kind: 'service', title: 'Byt termostat' }),
    );
    orderId = order.id;
  });
  afterEach(async () => {
    await h.close();
  });

  for (const name of Object.keys(workorderOperations) as OpName[]) {
    const key = declaredKey(name);

    it(`${name}: a principal holding only \`${key}\` is not denied`, async () => {
      const holder = await h.as([key]);
      const outcome = await holder.invoke(name, INPUTS[name](orderId)).then(
        () => 'ok',
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(outcome).not.toMatch(DENIED);
    });

    it(`${name}: a principal holding every key but \`${key}\` is denied`, async () => {
      const others = WORKORDER_PERMISSIONS.filter((k) => k !== key) as unknown as PermissionKey[];
      const holder = await h.as(others);
      await expect(holder.invoke(name, INPUTS[name](orderId))).rejects.toThrow(DENIED);
    });
  }
});
