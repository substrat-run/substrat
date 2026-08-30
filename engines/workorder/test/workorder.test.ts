import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { moneyOf, type EntityRef, type Page } from '@substrat-run/contracts';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  PERM,
  assignWorkOrder,
  completeWorkOrder,
  createWorkOrder,
  getReportedLines,
  getWorkOrder,
  reportMaterial,
  reportTime,
  startWorkOrder,
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
// A principal id: `workorder.assigned` names the technician as its data subject,
// and a subject id is a ULID (`dataSubjectId`), not a display name.
const TECHNICIAN = '01JTEKN1KER000000000000000';

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

  // -- the four reporting-side in-scope functions (#975) --------------------

  it('assignWorkOrder records the technician, leaves the order planned, and emits about them', async () => {
    const order = await create();
    const assigned = await h.run((ctx) => assignWorkOrder(ctx, { orderId: order.id, technician: TECHNICIAN }));
    expect(assigned.assignedTo).toBe(TECHNICIAN);
    expect(assigned.status).toBe('planned');

    const [evt] = h.eventsOfType('workorder.assigned');
    expect(evt!.payload).toEqual({ orderId: order.id, technician: TECHNICIAN });
    // The technician is the data subject, not the caller.
    expect(evt!.piiClass).toBe('pseudonymous');
    expect(evt!.subjectId).toBe(TECHNICIAN);
  });

  it('startWorkOrder moves planned → in_progress and emits workorder.started', async () => {
    const order = await create();
    const started = await h.run((ctx) => startWorkOrder(ctx, { orderId: order.id }));
    expect(started.status).toBe('in_progress');
    expect(h.eventsOfType('workorder.started')[0]!.payload).toEqual({ orderId: order.id });
  });

  it('reportTime and reportMaterial append, attributed to the acting principal', async () => {
    const order = await create();
    const { entry, line, principal } = await h.run((ctx) => ({
      principal: ctx.principal,
      entry: reportTime(ctx, { orderId: order.id, hours: '1.5', note: 'felsökning' }),
      line: reportMaterial(ctx, { orderId: order.id, article: 'termostat', qty: '2' }),
    }));
    expect(entry).toMatchObject({ order_id: order.id, technician: principal, hours: '1.5', note: 'felsökning' });
    expect(line).toMatchObject({ order_id: order.id, article: 'termostat', qty: '2', reported_by: principal });

    const lines = await h.run((ctx) => getReportedLines(ctx, order.id));
    expect(lines.time.map((t) => t.id)).toEqual([entry.id]);
    expect(lines.material.map((m) => m.id)).toEqual([line.id]);

    expect(h.eventsOfType('workorder.time-reported')[0]!.payload).toEqual({
      orderId: order.id,
      entryId: entry.id,
      hours: '1.5',
    });
    expect(h.eventsOfType('workorder.material-reported')[0]!.payload).toEqual({
      orderId: order.id,
      lineId: line.id,
      article: 'termostat',
      qty: '2',
    });
  });

  it('the in-scope functions parse their input on the way in', async () => {
    const order = await create();
    await expect(
      h.run((ctx) => assignWorkOrder(ctx, { orderId: order.id, technician: '' })),
    ).rejects.toThrow();
    await expect(
      h.run((ctx) => reportTime(ctx, { orderId: order.id, hours: 'en och en halv' })),
    ).rejects.toThrow();
    expect(h.eventsOfType('workorder.assigned')).toHaveLength(0);
    expect(h.eventsOfType('workorder.time-reported')).toHaveLength(0);
  });

  // #953: the engine hands the host `operationInputs`, so this holds for the
  // operations whose handler parses nothing of its own — `workorder/get` reads
  // `input.orderId` straight into an entity ref and a row lookup.
  //
  // A principal with NO permission is what makes the assertion mean something:
  // the host parses BEFORE the permission check, so a malformed call is refused
  // for being malformed. Drop `operationInputs` and the same call comes back
  // "permission denied" — the handler was reached, and a permitted caller would
  // have been handed the unparsed value.
  it('the HOST parses an invocation, before the permission check and for handlers that do not', async () => {
    const order = await create();
    const nobody = await h.as([]);
    await expect(nobody.invoke('workorder/get', { orderId: 42 })).rejects.toThrow(/invalid|expected/i);
    await expect(nobody.invoke('workorder/get', {})).rejects.toThrow(/invalid|required|expected/i);
    // The well-formed call is refused for the reason it should be.
    await expect(nobody.invoke('workorder/get', { orderId: order.id })).rejects.toThrow(/permission denied/);

    // What the parse DOES to the value once it applies — unknown keys stripped,
    // declared defaults set, the page trio let through — is the host's behaviour
    // and is asserted against every adapter in
    // `packages/contract-tests/src/input-parse-suite.ts`. Restating it here would
    // pass whether or not this engine declared anything, which is the one thing
    // this test exists to detect.
    const got = await staff.invoke<{ order: WorkOrder }>('workorder/get', { orderId: order.id });
    expect(got.order.id).toBe(order.id);
  });

  it('composes inside one transaction: assign, start and report together, and all of it rolls back together', async () => {
    const order = await create();

    // The happy path a vertical would write: three engine calls in ITS operation.
    const started = await h.run((ctx) => {
      assignWorkOrder(ctx, { orderId: order.id, technician: TECHNICIAN });
      const s = startWorkOrder(ctx, { orderId: order.id });
      reportTime(ctx, { orderId: order.id, hours: '0.5' });
      return s;
    });
    expect(started.status).toBe('in_progress');
    expect(started.assignedTo).toBe(TECHNICIAN);

    // A second order: the vertical's own step fails AFTER the engine wrote. No
    // `ctx.atomic`, so the whole operation — engine rows and events included —
    // is gone, which is what "same transaction" promises.
    const other = await create('andra');
    await expect(
      h.run((ctx) => {
        startWorkOrder(ctx, { orderId: other.id });
        reportMaterial(ctx, { orderId: other.id, article: 'packning', qty: '1' });
        throw new Error('the vertical refused');
      }),
    ).rejects.toThrow('the vertical refused');
    const untouched = await h.run((ctx) => getWorkOrder(ctx, other.id));
    expect(untouched.status).toBe('planned');
    const lines = await h.run((ctx) => getReportedLines(ctx, other.id));
    expect(lines.material).toHaveLength(0);
    expect(h.eventsOfType('workorder.started')).toHaveLength(1);
    expect(h.eventsOfType('workorder.material-reported')).toHaveLength(0);
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
