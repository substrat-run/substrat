import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { moneyOf, type EntityRef, type Page } from '@substrat-run/contracts';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  PERM,
  completeWorkOrder,
  createWorkOrder,
  workorderModule,
  type WorkOrder,
} from '../src/index.js';

/**
 * The work-order engine, tested directly.
 *
 * Note what this engine does NOT register: a `workorder/create` operation.
 * Creation is the exported in-scope function `createWorkOrder(ctx, …)`, which a
 * vertical composes inside its own operation and permission check (K-16). That
 * makes the in-scope functions the surface most worth testing and the one a
 * demo scenario exercises only obliquely.
 */

const FACILITY: EntityRef = { entityType: 'facility', entityId: '01JFACILITY0000000000000000' };
const CUSTOMER: EntityRef = { entityType: 'customer', entityId: '01JCUSTOMER0000000000000000' };

const billable = (article: string, amount: string, currency = 'SEK') => ({
  article,
  description: `${article} line`,
  qty: '1',
  unit: 'tim',
  unitPrice: moneyOf(amount, currency),
  lineTotal: moneyOf(amount, currency),
  sourceType: 'time' as const,
  sourceId: 'src-1',
});

describe('engine-workorder', () => {
  let h: EngineHarness;
  let staff: Awaited<ReturnType<EngineHarness['as']>>;

  beforeEach(async () => {
    h = await engineHarness({ modules: [workorderModule] });
    staff = await h.as([PERM.create, PERM.read, PERM.assign, PERM.report, PERM.complete, PERM.close]);
  });
  afterEach(async () => {
    await h.close();
  });

  /** Create via the in-scope function, the way a vertical actually would. */
  const create = (title = 'Byt termostat') =>
    h.run((ctx) => createWorkOrder(ctx, { facility: FACILITY, customer: CUSTOMER, kind: 'service', title }));

  // -- in-scope functions --------------------------------------------------

  it('createWorkOrder starts in planned and emits workorder.created', async () => {
    const order = await create();
    expect(order.status).toBe('planned');
    expect(order.number).toBe(1);

    const [evt] = h.eventsOfType('workorder.created');
    expect(evt!.schemaVersion).toBe(1);
    expect(evt!.entity).toEqual({ entityType: 'workorder', entityId: order.id });
  });

  it('numbers work orders sequentially', async () => {
    await create('ett');
    const second = await create('två');
    expect(second.number).toBe(2);
  });

  it('rejects a malformed create rather than writing a partial row', async () => {
    await expect(
      h.run((ctx) => createWorkOrder(ctx, { facility: FACILITY, customer: CUSTOMER, kind: '', title: '' })),
    ).rejects.toThrow();
    // #811: a page. `entries`, because an in-process caller gets the kernel-side
    // shape — the HTTP body is still the bare array (#829).
    const page = await staff.invoke<Page<WorkOrder>>('workorder/list');
    expect(page.entries).toHaveLength(0);
  });

  // -- the state machine cannot skip ---------------------------------------

  it('cannot complete an order that was never started', async () => {
    const order = await create();
    await expect(
      h.run((ctx) => completeWorkOrder(ctx, { orderId: order.id, billable: [billable('arbete', '500')] })),
    ).rejects.toThrow(/invalid transition/);
  });

  it('cannot close an order that is not completed', async () => {
    const order = await create();
    await expect(staff.invoke('workorder/close', { orderId: order.id })).rejects.toThrow(
      /invalid transition/,
    );
  });

  it('cannot assign an order that is already in progress', async () => {
    const order = await create();
    await staff.invoke('workorder/start', { orderId: order.id });
    await expect(
      staff.invoke('workorder/assign', { orderId: order.id, technician: 'tekniker-1' }),
    ).rejects.toThrow(/invalid transition/);
  });

  it('walks planned → in_progress → completed → closed', async () => {
    const order = await create();

    const started = await staff.invoke<WorkOrder>('workorder/start', { orderId: order.id });
    expect(started.status).toBe('in_progress');

    const { order: done } = await h.run((ctx) =>
      completeWorkOrder(ctx, { orderId: order.id, billable: [billable('arbete', '500')] }),
    );
    expect(done.status).toBe('completed');
    expect(done.completedAt).toBeTruthy();

    const closed = await staff.invoke<WorkOrder>('workorder/close', { orderId: order.id });
    expect(closed.status).toBe('closed');
  });

  it('cannot complete twice — the transition is once', async () => {
    const order = await create();
    await staff.invoke('workorder/start', { orderId: order.id });
    await h.run((ctx) => completeWorkOrder(ctx, { orderId: order.id, billable: [billable('a', '1')] }));
    await expect(
      h.run((ctx) => completeWorkOrder(ctx, { orderId: order.id, billable: [billable('a', '1')] })),
    ).rejects.toThrow(/invalid transition/);
  });

  // -- the fat completion event --------------------------------------------

  it('completion emits a FAT event: the consumer never needs a cross-module read', async () => {
    const order = await create();
    await staff.invoke('workorder/start', { orderId: order.id });
    await h.run((ctx) =>
      completeWorkOrder(ctx, {
        orderId: order.id,
        billable: [billable('arbete', '500'), billable('material', '250')],
      }),
    );

    const [evt] = h.eventsOfType('workorder.completed');
    expect(evt!.schemaVersion).toBe(1);
    // Everything invoicing needs, in the payload: who to bill, what to bill,
    // and the total — no join back into workorder's private tables.
    expect(evt!.payload).toMatchObject({
      orderId: order.id,
      number: order.number,
      facility: FACILITY,
      customer: CUSTOMER,
      total: { amount: '750', currency: 'SEK' },
    });
    expect((evt!.payload as { billable: unknown[] }).billable).toHaveLength(2);
  });

  it('refuses to total a completion across currencies', async () => {
    const order = await create();
    await staff.invoke('workorder/start', { orderId: order.id });
    await expect(
      h.run((ctx) =>
        completeWorkOrder(ctx, {
          orderId: order.id,
          billable: [billable('arbete', '500', 'SEK'), billable('resa', '100', 'EUR')],
        }),
      ),
    ).rejects.toThrow(/currency/i);
  });

  // -- append-only reporting ------------------------------------------------

  it('time entries accumulate rather than overwrite', async () => {
    const order = await create();
    await staff.invoke('workorder/start', { orderId: order.id });
    await staff.invoke('workorder/report-time', { orderId: order.id, hours: '1.5' });
    await staff.invoke('workorder/report-time', { orderId: order.id, hours: '0.5' });

    const evts = h.eventsOfType('workorder.time-reported');
    expect(evts).toHaveLength(2);
  });

  // -- permissions ----------------------------------------------------------

  it('is default-deny: a principal with no permissions does nothing', async () => {
    const order = await create();
    const nobody = await h.as([]);
    await expect(nobody.invoke('workorder/list')).rejects.toThrow(/permission denied/);
    await expect(nobody.invoke('workorder/start', { orderId: order.id })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('separates report from close: a reporter cannot close', async () => {
    const order = await create();
    const reporter = await h.as([PERM.read, PERM.report]);
    await reporter.invoke('workorder/start', { orderId: order.id });
    await expect(reporter.invoke('workorder/close', { orderId: order.id })).rejects.toThrow(
      /permission denied/,
    );
  });
});
