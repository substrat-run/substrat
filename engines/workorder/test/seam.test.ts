import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { errorCodeOf, type EntityRef, type Page } from '@substrat-run/contracts';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  PERM,
  createWorkOrder,
  getReportedLines,
  getWorkOrder,
  workorderModule,
  type TimeEntry,
  type WorkOrder,
} from '../src/index.js';
import { columnsOf } from '../src/seam.js';
import { materialLine, timeEntry } from '../src/schemas.js';
import { workorderRow } from '../src/entities.js';

/**
 * The seam, under drift (#771).
 *
 * Every test here answers one question: when the stored row stops matching the
 * shape this engine PUBLISHES, does the caller get a throw or wrong data? Before
 * this, the answer was wrong data — the return values crossed the seam typed by a
 * TypeScript assertion that is not there at runtime, and `SELECT *` pinned the
 * published shape to whatever the physical table happened to hold.
 *
 * The drift is simulated the only honest way available: by moving the table under
 * a running engine, which is what a vertical compiled against 0.3 and running
 * against 0.4 is actually looking at.
 */

const FACILITY: EntityRef = { entityType: 'facility', entityId: '01JFACILITY0000000000000000' };
const CUSTOMER: EntityRef = { entityType: 'customer', entityId: '01JCUSTOMER0000000000000000' };

describe('engine-workorder — the seam is parsed, not asserted', () => {
  let h: EngineHarness;
  let staff: Awaited<ReturnType<EngineHarness['as']>>;

  beforeEach(async () => {
    h = await engineHarness({ modules: [workorderModule] });
    staff = await h.as([PERM.create, PERM.read, PERM.assign, PERM.report, PERM.complete, PERM.close]);
  });
  afterEach(async () => {
    await h.close();
  });

  const create = (title = 'Byt termostat') =>
    h.run((ctx) =>
      createWorkOrder(ctx, { facility: FACILITY, customer: CUSTOMER, kind: 'service', title }),
    );

  const reportTime = async (orderId: string) => {
    await staff.invoke('workorder/start', { orderId });
    await staff.invoke('workorder/report-time', { orderId, hours: '1.5', note: 'bytte ventil' });
  };

  /** Move the table under the engine, the way a version bump would. */
  const drift = (sql: string) => h.run((ctx) => void ctx.sql.exec(sql));

  // -- the SELECT list is derived from the published schema -------------------

  it('names the columns a schema publishes, in its order', () => {
    expect(columnsOf(timeEntry)).toBe('id, order_id, technician, hours, note, reported_at');
    expect(columnsOf(materialLine)).toBe(
      'id, order_id, article, qty, note, reported_by, reported_at',
    );
    expect(columnsOf(workorderRow)).toContain('facility_type, facility_id');
  });

  it('a column that vanished fails AT THE READ, naming itself', async () => {
    const order = await create();
    await reportTime(order.id);
    // The published shape still says `technician`; the table no longer does.
    await drift('ALTER TABLE workorder_time_entries DROP COLUMN technician');

    // `SELECT *` would have returned a row quietly missing the field. Naming the
    // columns makes the read itself refuse, and say which column it wanted.
    await expect(h.run((ctx) => getReportedLines(ctx, order.id))).rejects.toThrow(
      /no such column: technician/,
    );
  });

  it('a column added upstream never crosses the seam', async () => {
    const order = await create();
    await drift('ALTER TABLE workorder_time_entries ADD COLUMN internal_cost TEXT');
    await reportTime(order.id);
    await drift(`UPDATE workorder_time_entries SET internal_cost = '199'`);

    const entry = await staff.invoke<TimeEntry>('workorder/report-time', {
      orderId: order.id,
      hours: '0.5',
    });
    const { time } = await h.run((ctx) => getReportedLines(ctx, order.id));

    for (const row of [entry, ...time]) {
      expect(Object.keys(row)).toEqual([
        'id',
        'order_id',
        'technician',
        'hours',
        'note',
        'reported_at',
      ]);
      expect(row).not.toHaveProperty('internal_cost');
    }
  });

  // -- a drifted row throws instead of surfacing as wrong data ----------------

  it('a work order whose row drifted throws at the seam', async () => {
    const order = await create();
    // `number` is INTEGER in the table and `z.number()` in the published shape;
    // SQLite keeps a non-numeric literal as text, which is exactly the retype an
    // additive-only rule exists to forbid and nothing at runtime enforced.
    await drift(`UPDATE workorder_orders SET number = 'A-17'`);

    await expect(h.run((ctx) => getWorkOrder(ctx, order.id))).rejects.toThrow(
      /does not match the shape this engine publishes.*number/s,
    );
  });

  it('the page walk parses every entry it publishes, not just the first read', async () => {
    await create('ett');
    await create('två');
    await drift(`UPDATE workorder_orders SET number = 'A-17' WHERE title = 'två'`);

    // Wrong data on page one is the failure this closes: the entry rendered fine
    // and its number was a string nobody declared.
    await expect(staff.invoke<Page<WorkOrder>>('workorder/list')).rejects.toThrow(
      /does not match the shape this engine publishes/,
    );
  });

  it('a reported line whose row drifted throws at the seam', async () => {
    const order = await create();
    await reportTime(order.id);
    // Engine 0.4 makes `technician` nullable; a vertical compiled against 0.3
    // declared its operation output as a string.
    await drift('ALTER TABLE workorder_time_entries RENAME TO workorder_time_entries_v0');
    await drift(`CREATE TABLE workorder_time_entries (
        id          TEXT PRIMARY KEY,
        order_id    TEXT NOT NULL REFERENCES workorder_orders(id),
        technician  TEXT,
        hours       TEXT NOT NULL,
        note        TEXT,
        reported_at TEXT NOT NULL
      )`);
    await drift(`INSERT INTO workorder_time_entries (id, order_id, technician, hours, note, reported_at)
        SELECT id, order_id, NULL, hours, note, reported_at FROM workorder_time_entries_v0`);

    await expect(h.run((ctx) => getReportedLines(ctx, order.id))).rejects.toThrow(
      /does not match the shape this engine publishes.*technician/s,
    );
    // The whole read refuses — a half-published set would be the wrong-data
    // failure wearing an exception.
    await expect(staff.invoke('workorder/get', { orderId: order.id })).rejects.toThrow(
      /does not match the shape/,
    );
  });

  it('blames the engine, not the caller: a drifted row is `internal`', async () => {
    const order = await create();
    await drift(`UPDATE workorder_orders SET number = 'A-17'`);

    // The caller's input was already parsed and is not what went wrong, so this
    // must not answer 400 `validation_failed` — that is a lie a client acts on.
    const err = await h.run((ctx) => getWorkOrder(ctx, order.id)).catch((e: unknown) => e);
    expect(errorCodeOf(err)).toBe('internal');
  });
});
