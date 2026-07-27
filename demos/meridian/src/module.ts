import { z } from 'zod';
import {
  addDecimal,
  compareDecimal,
  dataSubjectId,
  moduleManifest,
  permissionKey,
  type EntityRef,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';
import {
  bindDocument,
  getProtocol,
  instantiateProtocol,
  requestSignatures,
  PROTOCOL_PERM as PROTO,
  type ProtocolInstanceRow,
} from '@substrat-run/engine-protocol';

// ============================================================================
// The Meridian vertical (spec/concept.md): employees, leave types, the
// APPEND-ONLY absence ledger, the leave-approval state machine, project time
// reporting, expenses, and the payroll export. Onboarding is the protocol
// engine, composed. Nothing here is engine-owned yet — the absence/time ledger
// is the extraction candidate (§5), written vertical-first so consumer #2
// (Callout/bikeshop wanting vacation) can force it out cleanly.
//
// The line kept honest now (§5.1): every ledger entry binds to an opaque
// `(employee, id)` ref the VERTICAL owns, never an engine-owned employee table.
// ============================================================================

export const HR_PERM = {
  employeeManage: permissionKey.parse('employee:manage'),
  absenceConfigure: permissionKey.parse('absence:configure'),
  absenceRequest: permissionKey.parse('absence:request'),
  absenceApprove: permissionKey.parse('absence:approve'),
  absenceRead: permissionKey.parse('absence:read'),
  timeReport: permissionKey.parse('time:report'),
  timeRead: permissionKey.parse('time:read'),
  projectManage: permissionKey.parse('project:manage'),
  expenseSubmit: permissionKey.parse('expense:submit'),
  expenseApprove: permissionKey.parse('expense:approve'),
  expenseRead: permissionKey.parse('expense:read'),
  payrollExport: permissionKey.parse('payroll:export'),
};

export const meridianManifest = moduleManifest.parse({
  id: '@substrat-run/demo-meridian',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'employee:manage', description: 'Create and read employee records, including salary/national id (HR admin)' },
    { key: 'absence:configure', description: 'Define leave types and grant accruals to employees (HR admin)' },
    { key: 'absence:request', description: 'Request time off (employees, narrowed to their own record)' },
    { key: 'absence:approve', description: 'Approve or reject a leave request — approval books the ledger (managers, HR admin)' },
    { key: 'absence:read', description: 'Read absence balances, ledger, and requests' },
    { key: 'time:report', description: 'Log worked hours to a project (employees, narrowed to their own record)' },
    { key: 'time:read', description: 'Read time entries and utilization' },
    { key: 'project:manage', description: 'Manage the projects time books against (HR admin)' },
    { key: 'expense:submit', description: 'Submit an expense (employees, narrowed to their own record)' },
    { key: 'expense:approve', description: 'Approve or reject an expense (managers, HR admin)' },
    { key: 'expense:read', description: 'Read expenses' },
    { key: 'payroll:export', description: 'Generate the variable-pay export and mark expenses exported (payroll operator)' },
  ],
  events: {
    emits: [
      { type: 'hr.employee-created', schemaVersion: 1 },
      { type: 'hr.employment-terms-set', schemaVersion: 1 },
      { type: 'hr.absence-accrued', schemaVersion: 1 },
      { type: 'hr.leave-requested', schemaVersion: 1 },
      { type: 'hr.leave-decided', schemaVersion: 1 },
      { type: 'hr.time-logged', schemaVersion: 1 },
      { type: 'hr.expense-submitted', schemaVersion: 1 },
      { type: 'hr.expense-decided', schemaVersion: 1 },
      { type: 'hr.payroll-exported', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [{ entityType: 'employee', readPermission: 'absence:read' }],
  entityRelations: [
    // Onboarding checklists (protocol engine) hang off employees; THIS vertical
    // owns that vocabulary, so it declares the permission-walk edge — which is
    // also what lets an employee's own-record grant reach their onboarding fill.
    { entityType: 'protocol', parentType: 'employee' },
  ],
  entitlementKey: 'meridian',
});

export const meridianMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE hr_employees (
        id            TEXT PRIMARY KEY,
        number        TEXT NOT NULL UNIQUE,
        name          TEXT NOT NULL,
        email         TEXT,
        national_id   TEXT,            -- PII: crypto-shred target (spec §8)
        principal_ref TEXT,            -- the login principal, if this person has one
        started_at    TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE TABLE hr_leave_types (
        key         TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        kind        TEXT NOT NULL,     -- vacation | sick | vab | parental | ...
        annual_days TEXT,             -- statutory entitlement, decimal string
        created_at  TEXT NOT NULL
      );
      -- The absence ledger is APPEND-ONLY: an accrual, a booking, a correction,
      -- or a carryover is a new row, never an edit. Balance is a fold of delta.
      CREATE TABLE hr_absence_ledger (
        id             TEXT PRIMARY KEY,
        employee_id    TEXT NOT NULL REFERENCES hr_employees(id),
        leave_type_key TEXT NOT NULL REFERENCES hr_leave_types(key),
        entry_kind     TEXT NOT NULL CHECK (entry_kind IN ('accrual','booking','correction','carryover')),
        delta          TEXT NOT NULL, -- signed decimal days; balance = SUM(delta)
        effective_date TEXT NOT NULL,
        request_id     TEXT,          -- the approved request that produced a booking
        note           TEXT,
        created_by     TEXT NOT NULL,
        created_at     TEXT NOT NULL
      );
      CREATE TABLE hr_leave_requests (
        id             TEXT PRIMARY KEY,
        employee_id    TEXT NOT NULL REFERENCES hr_employees(id),
        leave_type_key TEXT NOT NULL REFERENCES hr_leave_types(key),
        start_date     TEXT NOT NULL,
        end_date       TEXT NOT NULL,
        days           TEXT NOT NULL, -- decimal
        status         TEXT NOT NULL CHECK (status IN ('requested','approved','rejected','cancelled')),
        decided_by     TEXT,
        decided_at     TEXT,
        note           TEXT,
        created_by     TEXT NOT NULL,
        created_at     TEXT NOT NULL
      );
      CREATE TABLE hr_projects (
        id         TEXT PRIMARY KEY,
        code       TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      -- Time entries are APPEND-ONLY too — the second ledger of the same shape.
      CREATE TABLE hr_time_entries (
        id          TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES hr_employees(id),
        project_id  TEXT REFERENCES hr_projects(id),
        work_date   TEXT NOT NULL,
        hours       TEXT NOT NULL,   -- decimal
        note        TEXT,
        created_by  TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE hr_expenses (
        id          TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES hr_employees(id),
        project_id  TEXT REFERENCES hr_projects(id),
        description TEXT NOT NULL,
        amount      TEXT NOT NULL,   -- decimal
        currency    TEXT NOT NULL,
        category    TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('submitted','approved','rejected','exported')),
        decided_by  TEXT,
        decided_at  TEXT,
        created_by  TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE hr_holidays (
        id           TEXT PRIMARY KEY,
        holiday_date TEXT NOT NULL,
        name         TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
    `,
  },
  // 0002 — the anställningsavtal's TERMS. This vertical owns the content of the
  // employment contract; the protocol engine only ever sees its hash.
  //
  // Append-only, like the absence ledger: renegotiated terms are a NEW row and
  // latest-per-employee wins. A signed contract pinned the hash of the row that
  // was current when it was issued, so an edit-in-place would silently move what
  // somebody signed — the same reason protocol templates version rather than
  // update.
  {
    version: '0002-employment-terms',
    sql: `
      CREATE TABLE hr_employment_terms (
        id             TEXT PRIMARY KEY,
        employee_id    TEXT NOT NULL,
        role_title     TEXT NOT NULL,
        monthly_salary TEXT NOT NULL,   -- decimal string, never a float (K-14)
        currency       TEXT NOT NULL,
        scope_pct      TEXT NOT NULL,   -- sysselsättningsgrad: '100', '80'
        start_date     TEXT NOT NULL,
        notice_months  TEXT NOT NULL,
        created_by     TEXT NOT NULL,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX hr_employment_terms_by_employee
        ON hr_employment_terms (employee_id);
    `,
  },
];

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface EmployeeRow {
  id: string;
  number: string;
  name: string;
  email: string | null;
  national_id: string | null;
  principal_ref: string | null;
  started_at: string | null;
  created_at: string;
}

export interface EmploymentTermsRow {
  id: string;
  employee_id: string;
  role_title: string;
  monthly_salary: string;
  currency: string;
  scope_pct: string;
  start_date: string;
  notice_months: string;
  created_by: string;
  created_at: string;
}

export interface LeaveTypeRow {
  key: string;
  label: string;
  kind: string;
  annual_days: string | null;
  created_at: string;
}

export interface LedgerRow {
  id: string;
  employee_id: string;
  leave_type_key: string;
  entry_kind: 'accrual' | 'booking' | 'correction' | 'carryover';
  delta: string;
  effective_date: string;
  request_id: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
}

export interface LeaveRequestRow {
  id: string;
  employee_id: string;
  leave_type_key: string;
  start_date: string;
  end_date: string;
  days: string;
  status: 'requested' | 'approved' | 'rejected' | 'cancelled';
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  code: string;
  name: string;
  created_at: string;
}

export interface TimeEntryRow {
  id: string;
  employee_id: string;
  project_id: string | null;
  work_date: string;
  hours: string;
  note: string | null;
  created_by: string;
  created_at: string;
}

export interface ExpenseRow {
  id: string;
  employee_id: string;
  project_id: string | null;
  description: string;
  amount: string;
  currency: string;
  category: string;
  status: 'submitted' | 'approved' | 'rejected' | 'exported';
  decided_by: string | null;
  decided_at: string | null;
  created_by: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const employeeRef = (id: string): EntityRef => ({ entityType: 'employee', entityId: id });
const posDecimal = z.string().regex(/^\d+(\.\d{1,6})?$/, 'must be a non-negative decimal');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'must be an ISO date');
/** Negate a signed decimal string ('5' → '-5', '-5' → '5', '0' → '0'). */
const negate = (d: string): string =>
  compareDecimal(d, '0') === 0 ? '0' : d.startsWith('-') ? d.slice(1) : `-${d}`;

function getEmployee(ctx: OperationContext, id: string): EmployeeRow {
  const row = ctx.sql.query<EmployeeRow>('SELECT * FROM hr_employees WHERE id = ?', [id])[0];
  if (!row) throw new Error(`employee not found: ${id}`);
  return row;
}

function leaveTypeMustExist(ctx: OperationContext, key: string): LeaveTypeRow {
  const row = ctx.sql.query<LeaveTypeRow>('SELECT * FROM hr_leave_types WHERE key = ?', [key])[0];
  if (!row) throw new Error(`leave type not found: ${key}`);
  return row;
}

/** Balance for one (employee, leave type) = fold of ledger deltas. Pure. */
function balanceOf(ctx: OperationContext, employeeId: string, leaveTypeKey: string): string {
  return ctx.sql
    .query<{ delta: string }>(
      'SELECT delta FROM hr_absence_ledger WHERE employee_id = ? AND leave_type_key = ?',
      [employeeId, leaveTypeKey],
    )
    .reduce((sum, r) => addDecimal(sum, r.delta), '0');
}

// ---------------------------------------------------------------------------
// Directory (HR admin)
// ---------------------------------------------------------------------------

export const createEmployeeInput = z.object({
  number: z.string().min(1),
  name: z.string().min(1),
  email: z.string().optional(),
  nationalId: z.string().optional(),
  principalRef: z.string().optional(),
  startedAt: isoDate.optional(),
});

const createEmployeeOp: OperationHandler<z.infer<typeof createEmployeeInput>, EmployeeRow> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(HR_PERM.employeeManage));
  const input = createEmployeeInput.parse(raw);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO hr_employees (id, number, name, email, national_id, principal_ref, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.number,
      input.name,
      input.email ?? null,
      input.nationalId ?? null,
      input.principalRef ?? null,
      input.startedAt ?? null,
      new Date().toISOString(),
    ],
  );
  // PII stays out of the event payload; the record carries it, the spine does not.
  ctx.emit({
    type: 'hr.employee-created',
    schemaVersion: 1,
    entity: employeeRef(id),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(id),
    payload: { employeeId: id, number: input.number },
  });
  return getEmployee(ctx, id);
}

const listEmployeesOp: OperationHandler<undefined, EmployeeRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(HR_PERM.employeeManage));
  return ctx.sql.query<EmployeeRow>('SELECT * FROM hr_employees ORDER BY number');
};

/**
 * The manager/HR roster — employment facts only, no `national_id` and no
 * compensation (managers "see their department but never salary"). A node
 * `absence:read` holder passes (managers at scope, HR at tenant); employees,
 * holding it only as an entity grant, cannot enumerate the team.
 */
export type RosterRow = Omit<EmployeeRow, 'national_id'>;
const rosterOp: OperationHandler<undefined, RosterRow[]> = async (ctx) => {
  assertAllowed(await ctx.check(HR_PERM.absenceRead));
  return ctx.sql.query<RosterRow>(
    'SELECT id, number, name, email, principal_ref, started_at, created_at FROM hr_employees ORDER BY number',
  );
};

/**
 * "Who am I" for the app shell — the caller's own role hint + linked employee, resolved
 * from THIS scope. No permission gate: every principal in the scope may ask about
 * themselves (it reveals only their own role + own employee id, both already theirs). The
 * role is a UI hint derived by probing the caller's own grants — the kernel still enforces
 * the real permission on every operation regardless of what this returns. `country` is a
 * per-instance display default (currency + labels) until a scope carries its own; the
 * demo's SE/ES split is a per-scope seed concern, not a field here.
 */
export interface WhoAmI {
  role: 'hr-admin' | 'manager' | 'employee' | 'none';
  country: 'SE' | 'ES';
  employeeId: string | null;
}
const whoamiOp: OperationHandler<undefined, WhoAmI> = async (ctx) => {
  const employeeId =
    ctx.sql.query<{ id: string }>('SELECT id FROM hr_employees WHERE principal_ref = ? LIMIT 1', [ctx.principal])[0]?.id ??
    null;
  const role: WhoAmI['role'] = (await ctx.check(HR_PERM.employeeManage)).allowed
    ? 'hr-admin'
    : (await ctx.check(HR_PERM.absenceApprove)).allowed
      ? 'manager'
      : employeeId
        ? 'employee'
        : 'none';
  return { role, country: 'SE', employeeId };
};

// ---------------------------------------------------------------------------
// Leave types + accrual (HR admin)
// ---------------------------------------------------------------------------

export const defineLeaveTypeInput = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  kind: z.string().min(1),
  annualDays: posDecimal.optional(),
});

const defineLeaveTypeOp: OperationHandler<z.infer<typeof defineLeaveTypeInput>, LeaveTypeRow> =
  async (ctx, raw) => {
    assertAllowed(await ctx.check(HR_PERM.absenceConfigure));
    const input = defineLeaveTypeInput.parse(raw);
    ctx.sql.exec(
      `INSERT OR REPLACE INTO hr_leave_types (key, label, kind, annual_days, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [input.key, input.label, input.kind, input.annualDays ?? null, new Date().toISOString()],
    );
    return ctx.sql.query<LeaveTypeRow>('SELECT * FROM hr_leave_types WHERE key = ?', [input.key])[0]!;
  };

// The shared read selectors. Named (and exported) so the API catalog documents
// the SAME objects the handlers parse — schemas an operation shares with
// another operation are still one object, one contract (design/api-surface.md).
export const employeeIdInput = z.object({ employeeId: z.string().min(1) });
export const employeeFilterInput = z.object({ employeeId: z.string().min(1).optional() });
export const statusFilterInput = z.object({ status: z.string().optional() });
export const instanceIdInput = z.object({ instanceId: z.string().min(1) });
export const timelineInput = z.object({ entityType: z.string().min(1), entityId: z.string().min(1) });

// Leave types are scope vocabulary every absence-reader needs (an employee to
// see their own balances, HR/managers at the node). Optional employee entity:
// a node holder passes with none; an employee passes with their own record.
const listLeaveTypesOp: OperationHandler<z.infer<typeof employeeFilterInput> | undefined, LeaveTypeRow[]> = async (
  ctx,
  raw,
) => {
  const input = employeeFilterInput.parse(raw ?? {});
  const entity = input.employeeId ? employeeRef(input.employeeId) : undefined;
  assertAllowed(await ctx.check(HR_PERM.absenceRead, entity));
  return ctx.sql.query<LeaveTypeRow>('SELECT * FROM hr_leave_types ORDER BY key');
};

export const accrueInput = z.object({
  employeeId: z.string().min(1),
  leaveTypeKey: z.string().min(1),
  days: posDecimal,
  effectiveDate: isoDate.optional(),
  note: z.string().optional(),
});

const accrueOp: OperationHandler<z.infer<typeof accrueInput>, LedgerRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(HR_PERM.absenceConfigure));
  const input = accrueInput.parse(raw);
  getEmployee(ctx, input.employeeId);
  leaveTypeMustExist(ctx, input.leaveTypeKey);
  const id = ulid();
  const now = new Date().toISOString();
  ctx.sql.exec(
    `INSERT INTO hr_absence_ledger
       (id, employee_id, leave_type_key, entry_kind, delta, effective_date, request_id, note, created_by, created_at)
     VALUES (?, ?, ?, 'accrual', ?, ?, NULL, ?, ?, ?)`,
    [id, input.employeeId, input.leaveTypeKey, input.days, input.effectiveDate ?? now.slice(0, 10), input.note ?? null, ctx.principal, now],
  );
  ctx.emit({
    type: 'hr.absence-accrued',
    schemaVersion: 1,
    entity: employeeRef(input.employeeId),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(input.employeeId),
    payload: { ledgerId: id, employeeId: input.employeeId, leaveTypeKey: input.leaveTypeKey, days: input.days },
  });
  return ctx.sql.query<LedgerRow>('SELECT * FROM hr_absence_ledger WHERE id = ?', [id])[0]!;
};

// ---------------------------------------------------------------------------
// Balances + the leave-request approval state machine
// ---------------------------------------------------------------------------

const balanceOp: OperationHandler<
  z.infer<typeof employeeIdInput>,
  { employeeId: string; balances: { leaveTypeKey: string; balance: string }[] }
> = async (ctx, input) => {
  const { employeeId } = employeeIdInput.parse(input);
  // Per-entity check: HR admin/manager pass on the node role; an employee passes
  // only for their OWN record, via the entity-narrowed grant.
  assertAllowed(await ctx.check(HR_PERM.absenceRead, employeeRef(employeeId)));
  const keys = ctx.sql.query<{ leave_type_key: string }>(
    'SELECT DISTINCT leave_type_key FROM hr_absence_ledger WHERE employee_id = ? ORDER BY leave_type_key',
    [employeeId],
  );
  return {
    employeeId,
    balances: keys.map((k) => ({
      leaveTypeKey: k.leave_type_key,
      balance: balanceOf(ctx, employeeId, k.leave_type_key),
    })),
  };
};

export const requestLeaveInput = z.object({
  employeeId: z.string().min(1),
  leaveTypeKey: z.string().min(1),
  startDate: isoDate,
  endDate: isoDate,
  days: posDecimal,
  note: z.string().optional(),
});

const requestLeaveOp: OperationHandler<z.infer<typeof requestLeaveInput>, LeaveRequestRow> = async (
  ctx,
  raw,
) => {
  const input = requestLeaveInput.parse(raw);
  assertAllowed(await ctx.check(HR_PERM.absenceRequest, employeeRef(input.employeeId)));
  getEmployee(ctx, input.employeeId);
  leaveTypeMustExist(ctx, input.leaveTypeKey);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO hr_leave_requests
       (id, employee_id, leave_type_key, start_date, end_date, days, status, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
    [id, input.employeeId, input.leaveTypeKey, input.startDate, input.endDate, input.days, input.note ?? null, ctx.principal, new Date().toISOString()],
  );
  ctx.emit({
    type: 'hr.leave-requested',
    schemaVersion: 1,
    entity: employeeRef(input.employeeId),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(input.employeeId),
    payload: { requestId: id, employeeId: input.employeeId, leaveTypeKey: input.leaveTypeKey, days: input.days, startDate: input.startDate, endDate: input.endDate },
  });
  return ctx.sql.query<LeaveRequestRow>('SELECT * FROM hr_leave_requests WHERE id = ?', [id])[0]!;
};

export const decideLeaveInput = z.object({
  requestId: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  note: z.string().optional(),
});

const decideLeaveOp: OperationHandler<
  z.infer<typeof decideLeaveInput>,
  { request: LeaveRequestRow; booking: LedgerRow | null }
> = async (ctx, raw) => {
  assertAllowed(await ctx.check(HR_PERM.absenceApprove));
  const input = decideLeaveInput.parse(raw);
  const req = ctx.sql.query<LeaveRequestRow>('SELECT * FROM hr_leave_requests WHERE id = ?', [
    input.requestId,
  ])[0];
  if (!req) throw new Error(`leave request not found: ${input.requestId}`);
  // The state machine cannot skip: only a 'requested' leave can be decided.
  if (req.status !== 'requested') {
    throw new Error(`leave request ${req.id} is '${req.status}' — only a requested leave can be decided`);
  }
  const now = new Date().toISOString();

  if (input.decision === 'reject') {
    ctx.sql.exec(
      `UPDATE hr_leave_requests SET status = 'rejected', decided_by = ?, decided_at = ?, note = COALESCE(?, note) WHERE id = ?`,
      [ctx.principal, now, input.note ?? null, req.id],
    );
    ctx.emit({
      type: 'hr.leave-decided',
      schemaVersion: 1,
      entity: employeeRef(req.employee_id),
      piiClass: 'pseudonymous',
      subjectId: dataSubjectId.parse(req.employee_id),
      payload: { requestId: req.id, employeeId: req.employee_id, decision: 'rejected', bookingId: null },
    });
    return { request: getRequest(ctx, req.id), booking: null };
  }

  // Approve: the no-negative-beyond-policy invariant (floor = 0). Only the
  // booking of an APPROVED request touches the ledger.
  const balance = balanceOf(ctx, req.employee_id, req.leave_type_key);
  if (compareDecimal(addDecimal(balance, negate(req.days)), '0') < 0) {
    throw new Error(
      `insufficient balance: ${balance} day(s) of '${req.leave_type_key}', request needs ${req.days}`,
    );
  }
  const bookingId = ulid();
  ctx.sql.exec(
    `INSERT INTO hr_absence_ledger
       (id, employee_id, leave_type_key, entry_kind, delta, effective_date, request_id, note, created_by, created_at)
     VALUES (?, ?, ?, 'booking', ?, ?, ?, ?, ?, ?)`,
    [bookingId, req.employee_id, req.leave_type_key, negate(req.days), req.start_date, req.id, input.note ?? null, ctx.principal, now],
  );
  ctx.sql.exec(
    `UPDATE hr_leave_requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?`,
    [ctx.principal, now, req.id],
  );
  ctx.emit({
    type: 'hr.leave-decided',
    schemaVersion: 1,
    entity: employeeRef(req.employee_id),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(req.employee_id),
    payload: { requestId: req.id, employeeId: req.employee_id, decision: 'approved', bookingId, days: req.days },
  });
  return {
    request: getRequest(ctx, req.id),
    booking: ctx.sql.query<LedgerRow>('SELECT * FROM hr_absence_ledger WHERE id = ?', [bookingId])[0]!,
  };
};

function getRequest(ctx: OperationContext, id: string): LeaveRequestRow {
  return ctx.sql.query<LeaveRequestRow>('SELECT * FROM hr_leave_requests WHERE id = ?', [id])[0]!;
}

const listRequestsOp: OperationHandler<z.infer<typeof statusFilterInput> | undefined, LeaveRequestRow[]> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(HR_PERM.absenceRead));
  const { status } = statusFilterInput.parse(raw ?? {});
  return status
    ? ctx.sql.query<LeaveRequestRow>(
        'SELECT * FROM hr_leave_requests WHERE status = ? ORDER BY created_at',
        [status],
      )
    : ctx.sql.query<LeaveRequestRow>('SELECT * FROM hr_leave_requests ORDER BY created_at');
};

/** One employee's own requests — the self-service path (entity-checked). */
const myRequestsOp: OperationHandler<z.infer<typeof employeeIdInput>, LeaveRequestRow[]> = async (ctx, input) => {
  const { employeeId } = employeeIdInput.parse(input);
  assertAllowed(await ctx.check(HR_PERM.absenceRead, employeeRef(employeeId)));
  return ctx.sql.query<LeaveRequestRow>(
    'SELECT * FROM hr_leave_requests WHERE employee_id = ? ORDER BY created_at DESC',
    [employeeId],
  );
};

// ---------------------------------------------------------------------------
// Projects + time reporting (the second append-only ledger)
// ---------------------------------------------------------------------------

export const createProjectInput = z.object({ code: z.string().min(1), name: z.string().min(1) });

const createProjectOp: OperationHandler<z.infer<typeof createProjectInput>, ProjectRow> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(HR_PERM.projectManage));
  const input = createProjectInput.parse(raw);
  const id = ulid();
  ctx.sql.exec(`INSERT INTO hr_projects (id, code, name, created_at) VALUES (?, ?, ?, ?)`, [
    id,
    input.code,
    input.name,
    new Date().toISOString(),
  ]);
  return ctx.sql.query<ProjectRow>('SELECT * FROM hr_projects WHERE id = ?', [id])[0]!;
};

/**
 * The project catalogue — readable by any time-reporter. A node holder (HR,
 * manager) passes with no entity; an employee passes with their own record,
 * whose grant carries `time:read`. Same op, two ways in.
 */
const listProjectsOp: OperationHandler<z.infer<typeof employeeFilterInput> | undefined, ProjectRow[]> = async (
  ctx,
  raw,
) => {
  const input = employeeFilterInput.parse(raw ?? {});
  const entity = input.employeeId ? employeeRef(input.employeeId) : undefined;
  assertAllowed(await ctx.check(HR_PERM.timeRead, entity));
  return ctx.sql.query<ProjectRow>('SELECT * FROM hr_projects ORDER BY code');
};

export const logTimeInput = z.object({
  employeeId: z.string().min(1),
  projectId: z.string().optional(),
  workDate: isoDate,
  hours: posDecimal,
  note: z.string().optional(),
});

const logTimeOp: OperationHandler<z.infer<typeof logTimeInput>, TimeEntryRow> = async (ctx, raw) => {
  const input = logTimeInput.parse(raw);
  assertAllowed(await ctx.check(HR_PERM.timeReport, employeeRef(input.employeeId)));
  getEmployee(ctx, input.employeeId);
  if (input.projectId) {
    const p = ctx.sql.query<ProjectRow>('SELECT id FROM hr_projects WHERE id = ?', [input.projectId])[0];
    if (!p) throw new Error(`project not found: ${input.projectId}`);
  }
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO hr_time_entries (id, employee_id, project_id, work_date, hours, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.employeeId, input.projectId ?? null, input.workDate, input.hours, input.note ?? null, ctx.principal, new Date().toISOString()],
  );
  ctx.emit({
    type: 'hr.time-logged',
    schemaVersion: 1,
    entity: employeeRef(input.employeeId),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(input.employeeId),
    payload: { entryId: id, employeeId: input.employeeId, projectId: input.projectId ?? null, workDate: input.workDate, hours: input.hours },
  });
  return ctx.sql.query<TimeEntryRow>('SELECT * FROM hr_time_entries WHERE id = ?', [id])[0]!;
};

const timesheetOp: OperationHandler<
  z.infer<typeof employeeIdInput>,
  { employeeId: string; entries: TimeEntryRow[]; totalHours: string }
> = async (ctx, input) => {
  const { employeeId } = employeeIdInput.parse(input);
  assertAllowed(await ctx.check(HR_PERM.timeRead, employeeRef(employeeId)));
  const entries = ctx.sql.query<TimeEntryRow>(
    'SELECT * FROM hr_time_entries WHERE employee_id = ? ORDER BY work_date, rowid',
    [employeeId],
  );
  return {
    employeeId,
    entries,
    totalHours: entries.reduce((sum, e) => addDecimal(sum, e.hours), '0'),
  };
};

// ---------------------------------------------------------------------------
// Expenses (submit → approve → export)
// ---------------------------------------------------------------------------

export const submitExpenseInput = z.object({
  employeeId: z.string().min(1),
  description: z.string().min(1),
  amount: posDecimal,
  currency: z.string().regex(/^[A-Z]{3}$/).default('SEK'),
  category: z.string().min(1),
  projectId: z.string().optional(),
});

const submitExpenseOp: OperationHandler<z.infer<typeof submitExpenseInput>, ExpenseRow> = async (
  ctx,
  raw,
) => {
  const input = submitExpenseInput.parse(raw);
  assertAllowed(await ctx.check(HR_PERM.expenseSubmit, employeeRef(input.employeeId)));
  getEmployee(ctx, input.employeeId);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO hr_expenses (id, employee_id, project_id, description, amount, currency, category, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)`,
    [id, input.employeeId, input.projectId ?? null, input.description, input.amount, input.currency, input.category, ctx.principal, new Date().toISOString()],
  );
  ctx.emit({
    type: 'hr.expense-submitted',
    schemaVersion: 1,
    entity: employeeRef(input.employeeId),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(input.employeeId),
    payload: { expenseId: id, employeeId: input.employeeId, amount: input.amount, currency: input.currency, category: input.category },
  });
  return ctx.sql.query<ExpenseRow>('SELECT * FROM hr_expenses WHERE id = ?', [id])[0]!;
};

export const decideExpenseInput = z.object({
  expenseId: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
});

const decideExpenseOp: OperationHandler<z.infer<typeof decideExpenseInput>, ExpenseRow> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(HR_PERM.expenseApprove));
  const input = decideExpenseInput.parse(raw);
  const exp = ctx.sql.query<ExpenseRow>('SELECT * FROM hr_expenses WHERE id = ?', [input.expenseId])[0];
  if (!exp) throw new Error(`expense not found: ${input.expenseId}`);
  if (exp.status !== 'submitted') {
    throw new Error(`expense ${exp.id} is '${exp.status}' — only a submitted expense can be decided`);
  }
  const status = input.decision === 'approve' ? 'approved' : 'rejected';
  ctx.sql.exec(`UPDATE hr_expenses SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`, [
    status,
    ctx.principal,
    new Date().toISOString(),
    exp.id,
  ]);
  ctx.emit({
    type: 'hr.expense-decided',
    schemaVersion: 1,
    entity: employeeRef(exp.employee_id),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(exp.employee_id),
    payload: { expenseId: exp.id, employeeId: exp.employee_id, decision: status },
  });
  return ctx.sql.query<ExpenseRow>('SELECT * FROM hr_expenses WHERE id = ?', [exp.id])[0]!;
};

const listExpensesOp: OperationHandler<z.infer<typeof statusFilterInput> | undefined, ExpenseRow[]> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(HR_PERM.expenseRead));
  const { status } = statusFilterInput.parse(raw ?? {});
  return status
    ? ctx.sql.query<ExpenseRow>('SELECT * FROM hr_expenses WHERE status = ? ORDER BY created_at', [status])
    : ctx.sql.query<ExpenseRow>('SELECT * FROM hr_expenses ORDER BY created_at');
};

/** One employee's own expenses — the self-service path (entity-checked). */
const myExpensesOp: OperationHandler<z.infer<typeof employeeIdInput>, ExpenseRow[]> = async (ctx, input) => {
  const { employeeId } = employeeIdInput.parse(input);
  assertAllowed(await ctx.check(HR_PERM.expenseRead, employeeRef(employeeId)));
  return ctx.sql.query<ExpenseRow>(
    'SELECT * FROM hr_expenses WHERE employee_id = ? ORDER BY created_at DESC',
    [employeeId],
  );
};

// ---------------------------------------------------------------------------
// Payroll export — the variable-pay handoff (the invoice basis pattern, §7).
// Approved-but-unexported expenses + booked absence in the window → one file,
// then the expenses are marked exported so the next run never double-counts.
// ---------------------------------------------------------------------------

export const payrollExportInput = z.object({ fromDate: isoDate, toDate: isoDate });

interface PayrollExport {
  fromDate: string;
  toDate: string;
  expenses: { employeeId: string; amount: string; currency: string; category: string }[];
  absence: { employeeId: string; leaveTypeKey: string; days: string }[];
}

const payrollExportOp: OperationHandler<z.infer<typeof payrollExportInput>, PayrollExport> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(HR_PERM.payrollExport));
  const input = payrollExportInput.parse(raw);
  const expenses = ctx.sql.query<ExpenseRow>(
    `SELECT * FROM hr_expenses WHERE status = 'approved' ORDER BY created_at`,
  );
  const absenceRows = ctx.sql.query<{ employee_id: string; leave_type_key: string; days: string }>(
    `SELECT employee_id, leave_type_key, delta AS days FROM hr_absence_ledger
     WHERE entry_kind = 'booking' AND effective_date >= ? AND effective_date <= ?
     ORDER BY employee_id`,
    [input.fromDate, input.toDate],
  );
  // Mark the exported expenses so a re-run never double-counts them.
  for (const e of expenses) {
    ctx.sql.exec(`UPDATE hr_expenses SET status = 'exported' WHERE id = ?`, [e.id]);
  }
  ctx.emit({
    type: 'hr.payroll-exported',
    schemaVersion: 1,
    entity: { entityType: 'payroll-run', entityId: ulid() },
    piiClass: 'none',
    payload: { fromDate: input.fromDate, toDate: input.toDate, expenseCount: expenses.length, absenceBookings: absenceRows.length },
  });
  return {
    fromDate: input.fromDate,
    toDate: input.toDate,
    expenses: expenses.map((e) => ({ employeeId: e.employee_id, amount: e.amount, currency: e.currency, category: e.category })),
    absence: absenceRows.map((a) => ({ employeeId: a.employee_id, leaveTypeKey: a.leave_type_key, days: negate(a.days) })),
  };
};

// ---------------------------------------------------------------------------
// The anställningsavtal — a DOCUMENT protocol, and the reason the protocol
// engine has a second content kind.
//
// An employment contract is not checklist-shaped. It has articles: a role, a
// salary, an occupancy rate, a start date, a notice period. Those live HERE,
// in this vertical's own table, because they are this vertical's vocabulary —
// and the engine never sees them. What the engine gets is a hash.
//
// The honest limit, stated where a reader will meet it: the engine proves a
// signature was made over exactly this hash and that the hash has not moved.
// It CANNOT prove that `hr_employment_terms` still hashes to it, because it
// never read that table. Re-deriving the hash is this vertical's obligation —
// which is why `hr/verify-contract` exists below and why the template's
// `hashRecipe` spells the recipe out.
//
// The alternative — one checklist item reading "I accept this contract" — was
// rejected upstream: the engine would attest to that sentence and nothing else,
// producing a signature that looks like evidence and is not.
// ---------------------------------------------------------------------------

/** Latest terms win; the history stays as audit material (append-only). */
function latestTerms(ctx: OperationContext, employeeId: string): EmploymentTermsRow | undefined {
  return ctx.sql.query<EmploymentTermsRow>(
    'SELECT * FROM hr_employment_terms WHERE employee_id = ? ORDER BY rowid DESC LIMIT 1',
    [employeeId],
  )[0];
}

// Web Crypto + TextEncoder are runtime globals everywhere this runs (Node,
// Workers, browsers). Node-only imports never — and never a hand-rolled hash.
declare const crypto: {
  subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> };
};
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

/**
 * THE RECIPE. Must match `hashRecipe` on the template word for word, because
 * that string is what an auditor gets handed years later — and a signature over
 * a hash nobody can reproduce is worth nothing.
 *
 * Fields in fixed order, one per line, `key=value`, terminated by a newline.
 * Money stays a decimal string (K-14): a float here would make the hash depend
 * on IEEE rounding, and two systems would disagree about what was signed.
 */
export async function employmentTermsHash(terms: EmploymentTermsRow): Promise<string> {
  const input =
    `anstallningsavtal/1\n` +
    `employee=${terms.employee_id}\n` +
    `role=${terms.role_title}\n` +
    `salary=${terms.monthly_salary} ${terms.currency}\n` +
    `scope=${terms.scope_pct}\n` +
    `start=${terms.start_date}\n` +
    `notice=${terms.notice_months}\n`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const setTermsInput = z.object({
  employeeId: z.string().min(1),
  roleTitle: z.string().min(1),
  monthlySalary: posDecimal,
  currency: z.string().length(3),
  scopePct: posDecimal,
  startDate: isoDate,
  noticeMonths: posDecimal,
});

const setTermsOp: OperationHandler<z.infer<typeof setTermsInput>, EmploymentTermsRow> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(HR_PERM.employeeManage));
  const input = setTermsInput.parse(raw);
  getEmployee(ctx, input.employeeId);
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO hr_employment_terms
       (id, employee_id, role_title, monthly_salary, currency, scope_pct,
        start_date, notice_months, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.employeeId,
      input.roleTitle,
      input.monthlySalary,
      input.currency,
      input.scopePct,
      input.startDate,
      input.noticeMonths,
      ctx.principal,
      new Date().toISOString(),
    ],
  );
  // Compensation is not spine material: the event says terms exist, not what
  // they are. Same rule `hr.employee-created` follows for national_id.
  ctx.emit({
    type: 'hr.employment-terms-set',
    schemaVersion: 1,
    entity: employeeRef(input.employeeId),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(input.employeeId),
    payload: { employeeId: input.employeeId, termsId: id, roleTitle: input.roleTitle },
  });
  return ctx.sql.query<EmploymentTermsRow>('SELECT * FROM hr_employment_terms WHERE id = ?', [
    id,
  ])[0]!;
};

const termsOp: OperationHandler<z.infer<typeof employeeIdInput>, EmploymentTermsRow | null> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(HR_PERM.employeeManage));
  return latestTerms(ctx, employeeIdInput.parse(input).employeeId) ?? null;
};

export const issueContractInput = z.object({
  templateKey: z.string().min(1),
  employeeId: z.string().min(1),
});

/**
 * Issue the contract for signature — instantiate, bind, dispatch, in ONE
 * transaction.
 *
 * The two signatories are deliberately different in kind, and that asymmetry is
 * the whole point of the engine change:
 *
 *   arbetsgivaren — a `principal`. Someone with an account, who signs as
 *     themselves. This is the issuing party, so `primary`.
 *   den anställde — `external`. A new hire on their first day has NO account
 *     (see `hr_employees.principal_ref`, nullable for exactly this), and will
 *     sign with BankID through a provider, days from now.
 *
 * Their ref is the EMPLOYEE ID — an opaque `DataSubjectId`, the same one
 * `hr.employee-created` already shreds on. NOT `national_id`. That column is
 * this vertical's declared crypto-shred target, and writing it into a signature
 * row would make `direct` PII permanent in a table whose whole purpose is that
 * nothing in it can ever be edited.
 */
const issueContractOp: OperationHandler<
  z.infer<typeof issueContractInput>,
  { instance: ProtocolInstanceRow; contentHash: string }
> = async (ctx, raw) => {
  assertAllowed(await ctx.check(HR_PERM.employeeManage));
  assertAllowed(await ctx.check(PROTO.create));
  const input = issueContractInput.parse(raw);
  const employee = getEmployee(ctx, input.employeeId);
  const terms = latestTerms(ctx, employee.id);
  if (!terms) throw new Error(`no employment terms set for ${employee.number} — set them first`);

  const instance = instantiateProtocol(ctx, {
    templateKey: input.templateKey,
    entity: employeeRef(employee.id),
  });

  assertAllowed(await ctx.check(PROTO.bind, { entityType: 'protocol', entityId: instance.id }));
  bindDocument(ctx, {
    instanceId: instance.id,
    contentRef: { entityType: 'employment-terms', entityId: terms.id },
    contentHash: await employmentTermsHash(terms),
  });

  assertAllowed(
    await ctx.check(PROTO.requestSignature, { entityType: 'protocol', entityId: instance.id }),
  );
  const sent = await requestSignatures(ctx, {
    instanceId: instance.id,
    method: 'scrive',
    parties: [
      { label: 'Arbetsgivare', kind: 'principal', ref: ctx.principal, signatureKind: 'primary' },
      { label: 'Anställd', kind: 'external', ref: employee.id },
    ],
  });
  return { instance: sent.instance, contentHash: sent.contentHash };
};

/**
 * Re-derive the hash from this vertical's own rows and compare it to what the
 * protocol froze — the check the ENGINE cannot do for us.
 *
 * `matches: false` does not mean the signature is invalid. It means the terms
 * row moved after the contract was issued, and what somebody signed is no
 * longer what this table says. That is a real finding, and the only reason it
 * is findable is that the recipe is written down.
 */
const verifyContractOp: OperationHandler<
  z.infer<typeof instanceIdInput>,
  { matches: boolean; boundHash: string | null; replayedHash: string | null; status: string }
> = async (ctx, input) => {
  const { instanceId } = instanceIdInput.parse(input);
  assertAllowed(await ctx.check(PROTO.read, { entityType: 'protocol', entityId: instanceId }));
  const detail = getProtocol(ctx, instanceId);
  const termsId = detail.instance.content_ref_id;
  const terms = termsId
    ? ctx.sql.query<EmploymentTermsRow>('SELECT * FROM hr_employment_terms WHERE id = ?', [
        termsId,
      ])[0]
    : undefined;
  const replayedHash = terms ? await employmentTermsHash(terms) : null;
  return {
    // Compare against `bound_hash` — the hash WE computed over our own rows —
    // not `frozen_hash`, which is the engine's recipe run over it. The two are
    // different values and conflating them would make this check vacuous.
    matches: replayedHash !== null && replayedHash === detail.instance.bound_hash,
    boundHash: detail.instance.bound_hash,
    replayedHash,
    status: detail.instance.status,
  };
};

// ---------------------------------------------------------------------------
// Onboarding — the protocol engine, composed. Vertical policy: checklists hang
// off employees. The invariants (version pinning, sign→immutable, events) live
// in the engine's in-scope function; fill/sign/read use the engine's default
// `protocol/*` bindings directly.
// ---------------------------------------------------------------------------

export const startOnboardingInput = z.object({
  templateKey: z.string().min(1),
  employeeId: z.string().min(1),
});

const startOnboardingOp: OperationHandler<z.infer<typeof startOnboardingInput>, ProtocolInstanceRow> =
  async (ctx, raw) => {
    assertAllowed(await ctx.check(PROTO.create));
    const input = startOnboardingInput.parse(raw);
    getEmployee(ctx, input.employeeId);
    return instantiateProtocol(ctx, {
      templateKey: input.templateKey,
      entity: employeeRef(input.employeeId),
    });
  };

// ---------------------------------------------------------------------------
// Timeline — a read of the spine for one entity (reads of _substrat_* are fine).
// ---------------------------------------------------------------------------

const timelineOp: OperationHandler<
  z.infer<typeof timelineInput>,
  { type: string; occurred_at: string; actor: string }[]
> = async (ctx, input) => {
  const entity: EntityRef = timelineInput.parse(input);
  assertAllowed(await ctx.check(HR_PERM.absenceRead, entity));
  return ctx.sql.query(
    `SELECT type, occurred_at, actor FROM _substrat_outbox
     WHERE entity_type = ? AND entity_id = ? ORDER BY rowid`,
    [entity.entityType, entity.entityId],
  );
};

export const meridianModule: ModuleRegistration = {
  manifest: meridianManifest,
  migrations: meridianMigrations,
  operations: {
    'hr/create-employee': createEmployeeOp as never,
    'hr/list-employees': listEmployeesOp as never,
    'hr/roster': rosterOp as never,
    'hr/whoami': whoamiOp as never,
    'hr/define-leave-type': defineLeaveTypeOp as never,
    'hr/list-leave-types': listLeaveTypesOp as never,
    'hr/accrue': accrueOp as never,
    'hr/balance': balanceOp as never,
    'hr/request-leave': requestLeaveOp as never,
    'hr/decide-leave': decideLeaveOp as never,
    'hr/list-requests': listRequestsOp as never,
    'hr/my-requests': myRequestsOp as never,
    'hr/create-project': createProjectOp as never,
    'hr/list-projects': listProjectsOp as never,
    'hr/log-time': logTimeOp as never,
    'hr/timesheet': timesheetOp as never,
    'hr/submit-expense': submitExpenseOp as never,
    'hr/decide-expense': decideExpenseOp as never,
    'hr/list-expenses': listExpensesOp as never,
    'hr/my-expenses': myExpensesOp as never,
    'hr/payroll-export': payrollExportOp as never,
    'hr/set-employment-terms': setTermsOp as never,
    'hr/employment-terms': termsOp as never,
    'hr/issue-employment-contract': issueContractOp as never,
    'hr/verify-contract': verifyContractOp as never,
    'hr/start-onboarding': startOnboardingOp as never,
    'hr/timeline': timelineOp as never,
  },
};
