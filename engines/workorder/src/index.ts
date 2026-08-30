import { z } from 'zod';
import {
  addMoney,
  assertTransition,
  INVALID_TRANSITION,
  dataSubjectId,
  entityRef,
  money,
  mapPage,
  moduleManifest,
  moneyOf,
  operationInputsOf,
  permissionKey,
  listsDeclaredBy,
  type EntityRef,
  type Page,
  type EntityRow,
  type Money,
  substratError,
} from '@substrat-run/contracts';
import type { PageParams } from '@substrat-run/kernel';

/**
 * The conflict reasons this engine raises — its own vocabulary, narrowing the platform's
 * `conflict` code (#113). Exported so a vertical can branch on WHY a refusal happened
 * without importing this engine's types or matching on its prose; `as const` so a typo
 * is a compile error here rather than a slug nobody ever matches.
 *
 * Additive only, like every other engine surface: new reasons may appear, existing ones
 * do not change spelling.
 */
export const WORKORDER_CONFLICT_REASONS = [
  // Raised by `assertTransition` from the declared lifecycle (#844), not by this
  // file — so it is the shared constant rather than a second spelling of it.
  INVALID_TRANSITION,
] as const;
export type WorkorderConflictReason = (typeof WORKORDER_CONFLICT_REASONS)[number];

import {
  billableLine,
  decimal,
  workOrder,
  timeEntry,
  materialLine,
  type BillableLine,
  type WorkOrder,
  type TimeEntry,
  type MaterialLine,
} from './schemas.js';
import { workorderEntities, workorderRow } from './entities.js';
import { workorderOperations } from './operations.js';
import { workorderLifecycle } from './lifecycle.js';
import { columnsOf, returns } from './seam.js';

// The entity registry is PUBLIC: a composing vertical imports it to check
// relation edges naming this engine's entities, and to declare an operation's
// output without transcribing this engine's shape.
export { workorderEntities, workorderRow } from './entities.js';
export {
  billableLine,
  decimal,
  workOrder,
  timeEntry,
  materialLine,
  type BillableLine,
  type WorkOrder,
  type TimeEntry,
  type MaterialLine,
} from './schemas.js';
export { workorderOperations, WORKORDER_PERMISSIONS } from './operations.js';
// The declared state machine (#844). PUBLIC: a composing vertical reads it to
// render available actions, and `substrat.model` emits it into `model.json`.
export { workorderLifecycles, workorderLifecycle } from './lifecycle.js';
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
  // #811: DERIVED from the operations' own `paged.over`, never written twice —
  // the index the kernel provisions and the vocabulary the operation offers are
  // one fact. `table` and `idColumn` come from the entity registry.
  lists: listsDeclaredBy(workorderOperations, workorderEntities),
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



export const createWorkOrderInput = z.object({
  facility: entityRef,
  customer: entityRef,
  kind: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
});
export type CreateWorkOrderInput = z.infer<typeof createWorkOrderInput>;

/**
 * The inputs of the four in-scope functions extracted in #975 are the schemas
 * their default operation bindings DECLARE — read from `operations.ts`, never
 * restated here. One description of each input, parsed on the way in whether
 * the call arrives through the operation or from a vertical's own code.
 */
export const assignWorkOrderInput = workorderOperations['workorder/assign'].input;
export type AssignWorkOrderInput = z.infer<typeof assignWorkOrderInput>;
export const startWorkOrderInput = workorderOperations['workorder/start'].input;
export type StartWorkOrderInput = z.infer<typeof startWorkOrderInput>;
export const reportTimeInput = workorderOperations['workorder/report-time'].input;
export type ReportTimeInput = z.infer<typeof reportTimeInput>;
export const reportMaterialInput = workorderOperations['workorder/report-material'].input;
export type ReportMaterialInput = z.infer<typeof reportMaterialInput>;

/**
 * DERIVED from the entity registry (`entities.ts`) rather than written beside
 * it. The registry is what a vertical imports for the row's Zod schema, and two
 * descriptions of one row is how they come to disagree.
 */
type OrderRow = EntityRow<typeof workorderEntities, 'workorder'>;

/**
 * A work order as this engine PUBLISHES it — not as it stores it.
 *
 * Schema first, interface derived, matching `billableLine` and
 * `createWorkOrderInput` above. A vertical declaring an operation that returns a
 * work order uses this schema for its `output`; without it the vertical would
 * have to transcribe this shape into Zod, which is a description held in
 * agreement by nothing.
 *
 * Deliberately NOT the row (`workorderRow`). The stored row carries
 * `facility_type` / `facility_id` as two snake_case columns; the published type
 * carries one `EntityRef` and camelCase names. `status` is taken from the
 * registry so storage and domain cannot disagree about the state set.
 */



/**
 * The SELECT lists, derived from the schemas that describe what is read (#771).
 *
 * Never `SELECT *`: that pins the shape a read returns to whatever the physical
 * table currently holds, which is the same trust-TypeScript hole `returns` closes
 * from the other side. The order row comes from the entity registry (it is the
 * STORED shape); time entries and material lines come from the schemas this
 * engine publishes, since for those two the stored and published shapes are one.
 */
const ORDER_COLUMNS = columnsOf(workorderRow);
const TIME_ENTRY_COLUMNS = columnsOf(timeEntry);
const MATERIAL_LINE_COLUMNS = columnsOf(materialLine);

const timeEntries = z.array(timeEntry);
const materialLines = z.array(materialLine);

/**
 * A stored row, published (#771).
 *
 * The projection AND the parse, in one place, because every path out of this
 * engine that returns a work order goes through here — the in-scope reads, the
 * page walk, and each operation binding. `returns` refuses a row that no longer
 * matches `workOrder`, which is the shape a composing vertical declared its
 * `output` with when it compiled against some earlier version of this engine.
 */
const toWorkOrder = (r: OrderRow): WorkOrder =>
  returns(workOrder, `work order ${r.id}`, {
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
  const row = ctx.sql.query<OrderRow>(
    `SELECT ${ORDER_COLUMNS} FROM workorder_orders WHERE id = ?`,
    [orderId],
  )[0];
  if (!row) throw substratError('not_found', `work order not found: ${orderId}`);
  return row;
}

/**
 * The declared machine, applied (#844).
 *
 * This used to be a guard taking the states that admitted the verb, restated at
 * each of its six call sites and held to the `status` enum by nothing. The
 * states now live in `lifecycle.ts`, where the compiler holds them to that enum,
 * and each call site names the VERB instead of re-deriving the set permitting it.
 *
 * The throw is the platform's own `conflict` carrying `reason:
 * 'invalid_transition'` — the same code, the same reason and the same
 * `invalid transition: ...` prefix this engine raised before, now raised from
 * one place for every module that adopts a lifecycle.
 */
function requireTransition(row: OrderRow, operation: string): void {
  assertTransition(workorderLifecycle, `work order ${row.number}`, row.status, operation);
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
  const createdAt = ctx.now();
  ctx.sql.exec(
    `INSERT INTO workorder_orders
       (id, number, facility_type, facility_id, customer_type, customer_id,
        kind, title, description, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      // Not the literal `'planned'`: the declaration owns where a row starts, so
      // the machine and the INSERT cannot disagree about it.
      workorderLifecycle.initial,
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

/**
 * Everything reported against one order — the read a vertical prices FROM (§4).
 *
 * Both halves name their columns and parse their rows (#771). This function was
 * the sharpest case of the seam being typed by assertion alone: `SELECT *` typed
 * `<TimeEntry>` returned whatever the table held, so a column added upstream
 * crossed the seam and a column renamed arrived as `undefined` — in a shape a
 * vertical had already declared an operation `output` with.
 */
export function getReportedLines(
  ctx: OperationContext,
  orderId: string,
): { time: TimeEntry[]; material: MaterialLine[] } {
  return {
    time: returns(
      timeEntries,
      `time entries of ${orderId}`,
      ctx.sql.query<TimeEntry>(
        `SELECT ${TIME_ENTRY_COLUMNS} FROM workorder_time_entries WHERE order_id = ? ORDER BY id`,
        [orderId],
      ),
    ),
    material: returns(
      materialLines,
      `material lines of ${orderId}`,
      ctx.sql.query<MaterialLine>(
        `SELECT ${MATERIAL_LINE_COLUMNS} FROM workorder_material_lines WHERE order_id = ? ORDER BY id`,
        [orderId],
      ),
    ),
  };
}

/**
 * A page of work orders (#811).
 *
 * The `WHERE`, the `ORDER BY`, the keyset comparison and the `LIMIT` are the
 * kernel's, composed from this operation's declared `paged.over` vocabulary and
 * running over indexes it provisioned. What stays here is the projection — a
 * stored row is not a `WorkOrder` — which is why `mapPage` exists: it re-shapes
 * the entries and leaves the walk alone.
 *
 * The old positional `status?` is gone rather than kept beside this. It filtered
 * on one hard-coded column with a hand-written `ORDER BY number DESC` and no
 * bound at all, which is the shape #811 was filed against; a vertical wanting a
 * different sort had no path but to fork.
 */
export function listOrders(ctx: OperationContext, page: PageParams): Page<WorkOrder> {
  return mapPage(ctx.page<OrderRow>('workorder', page), toWorkOrder);
}

/**
 * One work order, by id (#811).
 *
 * Added because paging exposed two verticals doing `listOrders(ctx).find(o => o.id
 * === …)` — reading every row in the scope to return one, which was wasteful when
 * the list was unbounded and is WRONG once it is a page: the row you want is
 * simply not on page one. There was no exported single-order read to reach for,
 * which is why both reached for the list.
 *
 * Throws rather than returning undefined, like every other read here: an id that
 * names nothing is a caller's mistake, and `getRow` already refuses it.
 */
export function getWorkOrder(ctx: OperationContext, orderId: string): WorkOrder {
  return toWorkOrder(getRow(ctx, orderId));
}

/**
 * Assign a technician. Records and emits; the order stays `planned` (§3).
 *
 * In-scope (K-16) since #975: `assignWorkOrder`, `startWorkOrder`, `reportTime`
 * and `reportMaterial` used to live inline in their operation handlers, so a
 * vertical could not assign, start or report inside its own transaction without
 * forking — the exact failure the by-call shape exists to prevent. Each is now a
 * plain export, and `workorder/assign` … `workorder/report-material` below are
 * their default bindings. The CALLER owns the permission check, as with every
 * other function in this section.
 */
export function assignWorkOrder(ctx: OperationContext, rawInput: AssignWorkOrderInput): WorkOrder {
  const input = assignWorkOrderInput.parse(rawInput);
  const row = getRow(ctx, input.orderId);
  requireTransition(row, 'workorder/assign');
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
}

/** planned → in_progress. See `assignWorkOrder` for why this is exported. */
export function startWorkOrder(ctx: OperationContext, rawInput: StartWorkOrderInput): WorkOrder {
  const input = startWorkOrderInput.parse(rawInput);
  const row = getRow(ctx, input.orderId);
  requireTransition(row, 'workorder/start');
  ctx.sql.exec(`UPDATE workorder_orders SET status = 'in_progress' WHERE id = ?`, [row.id]);
  ctx.emit({
    type: 'workorder.started',
    schemaVersion: 1,
    entity: orderRef(row.id),
    piiClass: 'none',
    payload: { orderId: row.id },
  });
  return toWorkOrder(getRow(ctx, row.id));
}

/**
 * Append a time entry, attributed to the acting principal. Append-only: there
 * is no update path, so a correction is another entry (§2).
 */
export function reportTime(ctx: OperationContext, rawInput: ReportTimeInput): TimeEntry {
  const input = reportTimeInput.parse(rawInput);
  const hours = decimal.parse(input.hours);
  const row = getRow(ctx, input.orderId);
  requireTransition(row, 'workorder/report-time');
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO workorder_time_entries (id, order_id, technician, hours, note, reported_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, row.id, ctx.principal, hours, input.note ?? null, ctx.now()],
  );
  ctx.emit({
    type: 'workorder.time-reported',
    schemaVersion: 1,
    entity: orderRef(row.id),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(ctx.principal),
    payload: { orderId: row.id, entryId: id, hours },
  });
  return returns(
    timeEntry,
    `time entry ${id}`,
    ctx.sql.query<TimeEntry>(
      `SELECT ${TIME_ENTRY_COLUMNS} FROM workorder_time_entries WHERE id = ?`,
      [id],
    )[0],
  );
}

/** Append a material line, reported by the acting principal. Append-only, as above. */
export function reportMaterial(ctx: OperationContext, rawInput: ReportMaterialInput): MaterialLine {
  const input = reportMaterialInput.parse(rawInput);
  const qty = decimal.parse(input.qty);
  const row = getRow(ctx, input.orderId);
  requireTransition(row, 'workorder/report-material');
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO workorder_material_lines (id, order_id, article, qty, note, reported_by, reported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, row.id, input.article, qty, input.note ?? null, ctx.principal, ctx.now()],
  );
  ctx.emit({
    type: 'workorder.material-reported',
    schemaVersion: 1,
    entity: orderRef(row.id),
    piiClass: 'none',
    payload: { orderId: row.id, lineId: id, article: input.article, qty },
  });
  return returns(
    materialLine,
    `material line ${id}`,
    ctx.sql.query<MaterialLine>(
      `SELECT ${MATERIAL_LINE_COLUMNS} FROM workorder_material_lines WHERE id = ?`,
      [id],
    )[0],
  );
}

export function completeWorkOrder(
  ctx: OperationContext,
  input: { orderId: string; billable: BillableLine[] },
): { order: WorkOrder; total: Money } {
  const row = getRow(ctx, input.orderId);
  requireTransition(row, 'workorder/complete');
  const billable = z.array(billableLine).parse(input.billable);
  const total = billable.reduce(
    (sum, line) => addMoney(sum, line.lineTotal),
    moneyOf('0', billable[0]?.lineTotal.currency ?? 'SEK'),
  );
  const completedAt = ctx.now();
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
  // Both halves parsed: the order by `toWorkOrder`, the total here. `billable`
  // was parsed on the way in, one screen up — the seam is checked in both
  // directions or it is only checked in the easy one (#771).
  return { order: toWorkOrder(getRow(ctx, row.id)), total: returns(money, 'completion total', total) };
}

/**
 * completed → closed. In-scope (K-16) so a vertical can compose the close into
 * its own operation — e.g. a pickup ceremony that must satisfy a manifest guard
 * first. `workorder/close` below is this function's default binding; the CALLER
 * owns the permission check.
 */
export function closeWorkOrder(ctx: OperationContext, input: { orderId: string }): WorkOrder {
  const row = getRow(ctx, input.orderId);
  requireTransition(row, 'workorder/close');
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

const listOp: OperationHandler<
  ({ status?: string } & PageParams) | undefined,
  Page<WorkOrder>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.read));
  // `input` is genuinely absent when invoked with no body at all (`inputOptional`).
  return listOrders(ctx, { ...input, filters: { status: input?.status } });
};

const assignOp: OperationHandler<AssignWorkOrderInput, WorkOrder> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.assign));
  return assignWorkOrder(ctx, input);
};

const startOp: OperationHandler<StartWorkOrderInput, WorkOrder> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.report));
  return startWorkOrder(ctx, input);
};

const reportTimeOp: OperationHandler<ReportTimeInput, TimeEntry> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.report));
  return reportTime(ctx, input);
};

const reportMaterialOp: OperationHandler<ReportMaterialInput, MaterialLine> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.report));
  return reportMaterial(ctx, input);
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
  // The host parses every invocation against the same declaration the manifest
  // and the routes come from, so "parse, don't trust" holds on every path in
  // rather than in the handlers that remembered (#953).
  operationInputs: operationInputsOf(workorderOperations),
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
