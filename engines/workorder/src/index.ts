import { z } from 'zod';
import {
  addMoney,
  dataSubjectId,
  entityRef,
  money,
  moduleManifest,
  moneyOf,
  permissionKey,
  type EntityRef,
  type EntityRow,
  type Money,
} from '@substrat-run/contracts';
import { workorderEntities } from './entities.js';

// The entity registry is PUBLIC: a composing vertical imports it to check
// relation edges naming this engine's entities, and to declare an operation's
// output without transcribing this engine's shape.
export { workorderEntities, workorderRow } from './entities.js';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';

// ============================================================================
// The work-order engine (demos/callout/spec/testrun.md §4.2/§5.2). Owns the state
// machine and the append-only invariants; knows NOTHING about pricing (the
// vertical's job) or invoicing (a sibling engine, reached only via events).
// ============================================================================

export const PERM = {
  create: permissionKey.parse('workorder:create'),
  read: permissionKey.parse('workorder:read'),
  assign: permissionKey.parse('workorder:assign'),
  report: permissionKey.parse('workorder:report'),
  complete: permissionKey.parse('workorder:complete'),
  close: permissionKey.parse('workorder:close'),
};

export const workorderManifest = moduleManifest.parse({
  id: '@substrat-run/engine-workorder',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'workorder:create', description: 'Create work orders' },
    { key: 'workorder:read', description: 'Read work orders, time and material' },
    { key: 'workorder:assign', description: 'Assign a technician' },
    { key: 'workorder:report', description: 'Start work, report time and material' },
    { key: 'workorder:complete', description: 'Complete a work order (with billable lines)' },
    { key: 'workorder:close', description: 'Close a completed work order' },
  ],
  events: {
    emits: [
      { type: 'workorder.created', schemaVersion: 1 },
      { type: 'workorder.assigned', schemaVersion: 1 },
      { type: 'workorder.started', schemaVersion: 1 },
      { type: 'workorder.time-reported', schemaVersion: 1 },
      { type: 'workorder.material-reported', schemaVersion: 1 },
      { type: 'workorder.completed', schemaVersion: 1 },
      { type: 'workorder.closed', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [{ entityType: 'workorder', readPermission: 'workorder:read' }],
  entityRelations: [{ entityType: 'workorder', parentType: 'facility' }],
  entitlementKey: 'workorder',
  ui: {
    routes: [
      { path: 'workorders', screen: './ui/WorkOrderList', permission: 'workorder:read' },
      { path: 'workorders/:id', screen: './ui/WorkOrderDetail', permission: 'workorder:read' },
    ],
    nav: [{ label: 'workorder.nav', icon: 'wrench', to: 'workorders', permission: 'workorder:read' }],
    entityViews: [{ entityType: 'workorder', view: './ui/WorkOrderCard' }],
  },
});

export const workorderMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE workorder_orders (
        id            TEXT PRIMARY KEY,
        number        INTEGER NOT NULL UNIQUE,
        facility_type TEXT NOT NULL,
        facility_id   TEXT NOT NULL,
        customer_type TEXT NOT NULL,
        customer_id   TEXT NOT NULL,
        kind          TEXT NOT NULL,
        title         TEXT NOT NULL,
        description   TEXT,
        status        TEXT NOT NULL CHECK (status IN ('planned','in_progress','completed','closed')),
        assigned_to   TEXT,
        created_by    TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        completed_at  TEXT
      );
      CREATE TABLE workorder_time_entries (
        id          TEXT PRIMARY KEY,
        order_id    TEXT NOT NULL REFERENCES workorder_orders(id),
        technician  TEXT NOT NULL,
        hours       TEXT NOT NULL,
        note        TEXT,
        reported_at TEXT NOT NULL
      );
      CREATE TABLE workorder_material_lines (
        id          TEXT PRIMARY KEY,
        order_id    TEXT NOT NULL REFERENCES workorder_orders(id),
        article     TEXT NOT NULL,
        qty         TEXT NOT NULL,
        note        TEXT,
        reported_by TEXT NOT NULL,
        reported_at TEXT NOT NULL
      );
    `,
  },
];

// ---------------------------------------------------------------------------
// Schemas & shapes
// ---------------------------------------------------------------------------

const decimal = z.string().regex(/^\d+(\.\d{1,6})?$/);

export const billableLine = z.object({
  article: z.string().min(1),
  description: z.string().min(1),
  qty: decimal,
  unit: z.string().min(1),
  unitPrice: money,
  lineTotal: money,
  sourceType: z.enum(['time', 'material']),
  sourceId: z.string().min(1),
});
export type BillableLine = z.infer<typeof billableLine>;

export const createWorkOrderInput = z.object({
  facility: entityRef,
  customer: entityRef,
  kind: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
});
export type CreateWorkOrderInput = z.infer<typeof createWorkOrderInput>;

/**
 * DERIVED from the entity registry (`entities.ts`) rather than written beside
 * it. The registry is what a vertical imports for the row's Zod schema, and two
 * descriptions of one row is how they come to disagree.
 */
type OrderRow = EntityRow<typeof workorderEntities, 'workorder'>;

export interface WorkOrder {
  id: string;
  number: number;
  facility: EntityRef;
  customer: EntityRef;
  kind: string;
  title: string;
  description: string | null;
  status: OrderRow['status'];
  assignedTo: string | null;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}

export interface TimeEntry {
  id: string;
  order_id: string;
  technician: string;
  hours: string;
  note: string | null;
  reported_at: string;
}

export interface MaterialLine {
  id: string;
  order_id: string;
  article: string;
  qty: string;
  note: string | null;
  reported_by: string;
  reported_at: string;
}

const toWorkOrder = (r: OrderRow): WorkOrder => ({
  id: r.id,
  number: r.number,
  facility: { entityType: r.facility_type, entityId: r.facility_id },
  customer: { entityType: r.customer_type, entityId: r.customer_id },
  kind: r.kind,
  title: r.title,
  description: r.description,
  status: r.status,
  assignedTo: r.assigned_to,
  createdBy: r.created_by,
  createdAt: r.created_at,
  completedAt: r.completed_at,
});

const orderRef = (id: string): EntityRef => ({ entityType: 'workorder', entityId: id });

function getRow(ctx: OperationContext, orderId: string): OrderRow {
  const row = ctx.sql.query<OrderRow>('SELECT * FROM workorder_orders WHERE id = ?', [
    orderId,
  ])[0];
  if (!row) throw new Error(`work order not found: ${orderId}`);
  return row;
}

function requireStatus(row: OrderRow, ...allowed: OrderRow['status'][]): void {
  if (!allowed.includes(row.status)) {
    throw new Error(
      `invalid transition: work order ${row.number} is '${row.status}', requires ${allowed.join('|')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// In-scope functions (K-16) — composable from vertical operations, same
// transaction. The registered operations below are their default bindings.
// The CALLER is responsible for the permission check.
// ---------------------------------------------------------------------------

export function createWorkOrder(ctx: OperationContext, rawInput: CreateWorkOrderInput): WorkOrder {
  const input = createWorkOrderInput.parse(rawInput);
  const number =
    (ctx.sql.query<{ n: number }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM workorder_orders')[0]
      ?.n as number) ?? 1;
  const id = ulid();
  const createdAt = new Date().toISOString();
  ctx.sql.exec(
    `INSERT INTO workorder_orders
       (id, number, facility_type, facility_id, customer_type, customer_id,
        kind, title, description, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
    [
      id,
      number,
      input.facility.entityType,
      input.facility.entityId,
      input.customer.entityType,
      input.customer.entityId,
      input.kind,
      input.title,
      input.description ?? null,
      ctx.principal,
      createdAt,
    ],
  );
  ctx.link(orderRef(id), input.facility);
  ctx.emit({
    type: 'workorder.created',
    schemaVersion: 1,
    entity: orderRef(id),
    piiClass: 'none',
    payload: {
      orderId: id,
      number,
      facility: input.facility,
      customer: input.customer,
      kind: input.kind,
      title: input.title,
    },
  });
  return toWorkOrder(getRow(ctx, id));
}

export function getReportedLines(
  ctx: OperationContext,
  orderId: string,
): { time: TimeEntry[]; material: MaterialLine[] } {
  return {
    time: ctx.sql.query<TimeEntry>(
      'SELECT * FROM workorder_time_entries WHERE order_id = ? ORDER BY id',
      [orderId],
    ),
    material: ctx.sql.query<MaterialLine>(
      'SELECT * FROM workorder_material_lines WHERE order_id = ? ORDER BY id',
      [orderId],
    ),
  };
}

export function listOrders(ctx: OperationContext, status?: string): WorkOrder[] {
  const rows = status
    ? ctx.sql.query<OrderRow>(
        'SELECT * FROM workorder_orders WHERE status = ? ORDER BY number DESC',
        [status],
      )
    : ctx.sql.query<OrderRow>('SELECT * FROM workorder_orders ORDER BY number DESC');
  return rows.map(toWorkOrder);
}

export function completeWorkOrder(
  ctx: OperationContext,
  input: { orderId: string; billable: BillableLine[] },
): { order: WorkOrder; total: Money } {
  const row = getRow(ctx, input.orderId);
  requireStatus(row, 'in_progress');
  const billable = z.array(billableLine).parse(input.billable);
  const total = billable.reduce(
    (sum, line) => addMoney(sum, line.lineTotal),
    moneyOf('0', billable[0]?.lineTotal.currency ?? 'SEK'),
  );
  const completedAt = new Date().toISOString();
  ctx.sql.exec(`UPDATE workorder_orders SET status = 'completed', completed_at = ? WHERE id = ?`, [
    completedAt,
    row.id,
  ]);
  ctx.emit({
    type: 'workorder.completed',
    schemaVersion: 1,
    entity: orderRef(row.id),
    piiClass: 'none',
    payload: {
      orderId: row.id,
      number: row.number,
      facility: { entityType: row.facility_type, entityId: row.facility_id },
      customer: { entityType: row.customer_type, entityId: row.customer_id },
      billable,
      total,
    },
  });
  return { order: toWorkOrder(getRow(ctx, row.id)), total };
}

/**
 * completed → closed. In-scope (K-16) so a vertical can compose the close into
 * its own operation — e.g. a pickup ceremony that must satisfy a manifest guard
 * first. `workorder/close` below is this function's default binding; the CALLER
 * owns the permission check.
 */
export function closeWorkOrder(ctx: OperationContext, input: { orderId: string }): WorkOrder {
  const row = getRow(ctx, input.orderId);
  requireStatus(row, 'completed');
  ctx.sql.exec(`UPDATE workorder_orders SET status = 'closed' WHERE id = ?`, [row.id]);
  ctx.emit({
    type: 'workorder.closed',
    schemaVersion: 1,
    entity: orderRef(row.id),
    piiClass: 'none',
    payload: { orderId: row.id },
  });
  return toWorkOrder(getRow(ctx, row.id));
}

// ---------------------------------------------------------------------------
// Default operation bindings — each starts with the permission check.
// ---------------------------------------------------------------------------

const getOp: OperationHandler<
  { orderId: string },
  { order: WorkOrder; time: TimeEntry[]; material: MaterialLine[] }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.read, orderRef(input.orderId)));
  const order = toWorkOrder(getRow(ctx, input.orderId));
  return { order, ...getReportedLines(ctx, input.orderId) };
};

const listOp: OperationHandler<{ status?: string } | undefined, WorkOrder[]> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(PERM.read));
  return listOrders(ctx, input?.status);
};

const assignOp: OperationHandler<{ orderId: string; technician: string }, WorkOrder> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(PERM.assign));
  const row = getRow(ctx, input.orderId);
  requireStatus(row, 'planned');
  ctx.sql.exec('UPDATE workorder_orders SET assigned_to = ? WHERE id = ?', [
    input.technician,
    row.id,
  ]);
  ctx.emit({
    type: 'workorder.assigned',
    schemaVersion: 1,
    entity: orderRef(row.id),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(input.technician),
    payload: { orderId: row.id, technician: input.technician },
  });
  return toWorkOrder(getRow(ctx, row.id));
};

const startOp: OperationHandler<{ orderId: string }, WorkOrder> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.report));
  const row = getRow(ctx, input.orderId);
  requireStatus(row, 'planned');
  ctx.sql.exec(`UPDATE workorder_orders SET status = 'in_progress' WHERE id = ?`, [row.id]);
  ctx.emit({
    type: 'workorder.started',
    schemaVersion: 1,
    entity: orderRef(row.id),
    piiClass: 'none',
    payload: { orderId: row.id },
  });
  return toWorkOrder(getRow(ctx, row.id));
};

const reportTimeOp: OperationHandler<
  { orderId: string; hours: string; note?: string },
  TimeEntry
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.report));
  const hours = decimal.parse(input.hours);
  const row = getRow(ctx, input.orderId);
  requireStatus(row, 'planned', 'in_progress');
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO workorder_time_entries (id, order_id, technician, hours, note, reported_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, row.id, ctx.principal, hours, input.note ?? null, new Date().toISOString()],
  );
  ctx.emit({
    type: 'workorder.time-reported',
    schemaVersion: 1,
    entity: orderRef(row.id),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(ctx.principal),
    payload: { orderId: row.id, entryId: id, hours },
  });
  return ctx.sql.query<TimeEntry>('SELECT * FROM workorder_time_entries WHERE id = ?', [id])[0]!;
};

const reportMaterialOp: OperationHandler<
  { orderId: string; article: string; qty: string; note?: string },
  MaterialLine
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.report));
  const qty = decimal.parse(input.qty);
  const row = getRow(ctx, input.orderId);
  requireStatus(row, 'planned', 'in_progress');
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO workorder_material_lines (id, order_id, article, qty, note, reported_by, reported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, row.id, input.article, qty, input.note ?? null, ctx.principal, new Date().toISOString()],
  );
  ctx.emit({
    type: 'workorder.material-reported',
    schemaVersion: 1,
    entity: orderRef(row.id),
    piiClass: 'none',
    payload: { orderId: row.id, lineId: id, article: input.article, qty },
  });
  return ctx.sql.query<MaterialLine>('SELECT * FROM workorder_material_lines WHERE id = ?', [
    id,
  ])[0]!;
};

const completeOp: OperationHandler<
  { orderId: string; billable: BillableLine[] },
  { order: WorkOrder; total: Money }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.complete));
  return completeWorkOrder(ctx, input);
};

const closeOp: OperationHandler<{ orderId: string }, WorkOrder> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.close));
  return closeWorkOrder(ctx, input);
};

export const workorderModule: ModuleRegistration = {
  manifest: workorderManifest,
  migrations: workorderMigrations,
  operations: {
    'workorder/get': getOp as OperationHandler<never, unknown>,
    'workorder/list': listOp as OperationHandler<never, unknown>,
    'workorder/assign': assignOp as OperationHandler<never, unknown>,
    'workorder/start': startOp as OperationHandler<never, unknown>,
    'workorder/report-time': reportTimeOp as OperationHandler<never, unknown>,
    'workorder/report-material': reportMaterialOp as OperationHandler<never, unknown>,
    'workorder/complete': completeOp as OperationHandler<never, unknown>,
    'workorder/close': closeOp as OperationHandler<never, unknown>,
  },
};
