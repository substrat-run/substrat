import { z } from 'zod';
import {
  addDecimal,
  compareDecimal,
  dataSubjectId,
  type EntityRef,
  operationInputsOf,
  substratError,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  readTimeline,
  type OperationContext,
  type OperationHandler,
  type PageParams,
} from '@substrat-run/kernel';

/**
 * Meridian's own conflicts — `conflict` is the platform's code, the reason is this
 * vertical's (§2 of the error model: a module never invents a code, it narrows one).
 */
type MeridianConflictReason = 'not_submitted' | 'no_terms' | 'no_email';
const conflict = (reason: MeridianConflictReason, message: string) =>
  substratError('conflict', message, { reason });
import {
  bindDocument,
  getProtocol,
  instantiateProtocol,
  requestSignatures,
  PROTOCOL_PERM as PROTO,
  type ProtocolInstanceRow,
} from '@substrat-run/engine-protocol';
import {
  balanceAsOf,
  configureLeaveType,
  decideAbsence,
  entriesInWindow,
  listEntries,
  listRequests as listAbsenceRequests,
  recordEntry,
  requestAbsence,
  type AbsenceEntry,
  type AbsenceRequest,
  type AbsenceSubject,
} from '@substrat-run/engine-absence';
import {
  LIST_PAGE_DEFAULT,
  LIST_PAGE_MAX,
  listsDeclaredBy,
  mapPage,
  pageOf,
  type ListPage,
  type Page,
} from '@substrat-run/contracts';
import { protocolEntities } from '@substrat-run/engine-protocol';
import { meridianOperations } from './operations.js';
import { HR_PERM, meridianManifest } from './manifest.js';
import { meridianMigrations } from './migrations.js';

// ============================================================================
// The Meridian vertical (spec/concept.md): employees, leave types, project
// time reporting, expenses, and the payroll export. Onboarding is the protocol
// engine, composed — and absence IS `engine-absence` now (§5's extraction,
// forced by consumer #2, #634): the append-only ledger, the approval state
// machine, the balance floor and the absence.* events live in the engine.
// This vertical keeps the directory, the leave-type VOCABULARY
// (hr_leave_types: labels, kinds, statutory days), and the screens.
//
// The §5.1 line, now structural: every engine call names its subject as the
// opaque `(employee, id)` ref this vertical owns — the engine never reads
// hr_employees, and this module never touches absence_* tables.
//
// The declarative surface (HR_PERM, manifest) lives in manifest.ts; the
// migration journal in migrations.ts. This file is operations + wiring.
// ============================================================================

// The inputs and the row shapes are re-exported unchanged: they were declared
// here until `defineOperations` needed them below `module.ts` (see inputs.ts and
// schemas.ts for why the direction had to flip).
import {
  accrueInput,
  createEmployeeInput,
  createProjectInput,
  decideExpenseInput,
  decideLeaveInput,
  defineLeaveTypeInput,
  employeeFilterInput,
  employeeIdInput,
  instanceIdInput,
  issueContractInput,
  logTimeInput,
  payrollExportInput,
  requestLeaveInput,
  setTermsInput,
  startOnboardingInput,
  statusFilterInput,
  submitExpenseInput,
  timelineInput,
} from './inputs.js';
import type {
  TimelineEntry,
  EmployeeRow,
  EmploymentTermsRow,
  ExpenseRow,
  LeaveRequestRow,
  LeaveTypeRow,
  LedgerRow,
  PayrollExport,
  ProjectRow,
  RosterRow,
  TimeEntryRow,
  WhoAmI,
} from './schemas.js';

export * from './inputs.js';
export * from './schemas.js';
export { meridianOperations, MERIDIAN_PERMISSIONS } from './operations.js';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------









// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const employeeRef = (id: string): EntityRef => ({ entityType: 'employee', entityId: id });

/** Negate a signed decimal string ('5' → '-5', '-5' → '5', '0' → '0'). */
const negate = (d: string): string =>
  compareDecimal(d, '0') === 0 ? '0' : d.startsWith('-') ? d.slice(1) : `-${d}`;

function getEmployee(ctx: OperationContext, id: string): EmployeeRow {
  const row = ctx.sql.query<EmployeeRow>('SELECT * FROM hr_employees WHERE id = ?', [id])[0];
  if (!row) throw substratError('not_found', `employee not found: ${id}`);
  return row;
}

function leaveTypeMustExist(ctx: OperationContext, key: string): LeaveTypeRow {
  const row = ctx.sql.query<LeaveTypeRow>('SELECT * FROM hr_leave_types WHERE key = ?', [key])[0];
  if (!row) throw substratError('not_found', `leave type not found: ${key}`);
  return row;
}

/**
 * The engine-absence subject for one employee (D-B in engine-absence.md): the
 * opaque ref this vertical owns, plus the employee id as the DataSubjectId —
 * the SAME id every hr.* event already shreds on, so erasure stays one key.
 */
const absenceSubjectOf = (employeeId: string): AbsenceSubject => ({
  ref: employeeRef(employeeId),
  dataSubjectId: dataSubjectId.parse(employeeId),
});

// The engine speaks camelCase records; this vertical's API shipped snake_case
// rows. The mappers keep the HTTP surface byte-stable across the extraction.
const ledgerRowOf = (e: AbsenceEntry): LedgerRow => ({
  id: e.id,
  employee_id: e.subject.entityId,
  leave_type_key: e.leaveTypeKey,
  entry_kind: e.entryKind,
  delta: e.delta,
  effective_date: e.effectiveDate,
  request_id: e.requestId,
  note: e.note,
  created_by: e.createdBy,
  created_at: e.createdAt,
});

const requestRowOf = (r: AbsenceRequest): LeaveRequestRow => ({
  id: r.id,
  employee_id: r.subject.entityId,
  leave_type_key: r.leaveTypeKey,
  start_date: r.startDate,
  end_date: r.endDate,
  days: r.days,
  status: r.status,
  decided_by: r.decidedBy,
  decided_at: r.decidedAt,
  note: r.note,
  created_by: r.createdBy,
  created_at: r.createdAt,
});

// ---------------------------------------------------------------------------
// Directory (HR admin)
// ---------------------------------------------------------------------------


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
      ctx.now(),
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

/**
 * Page a list this vertical already has in memory, on one of its own fields.
 *
 * Used where the rows come from a FOLD rather than a table walk — an engine's
 * in-scope `listRequests`, for instance, which returns what it returns. There is
 * no partial computation to push into SQL, so the fold runs and the page is taken
 * off it. The SQL-backed reads below use a real keyset `LIMIT` instead.
 *
 * The cursor field must be UNIQUE among the rows, which each call site's
 * declaration in `operations.ts` states and this cannot check.
 */
function pageBy<T>(rows: T[], page: ListPage, key: (row: T) => string): Page<T> {
  const limit = Math.min(page.limit ?? LIST_PAGE_DEFAULT, LIST_PAGE_MAX);
  const cursor = page.cursor;
  const after =
    cursor === undefined
      ? 0
      : (() => {
          const i = rows.findIndex((r) => key(r) > cursor);
          return i < 0 ? rows.length : i;
        })();
  return pageOf(rows.slice(after, after + limit), limit, key);
}

const listEmployeesOp: OperationHandler<PageParams | undefined, Page<EmployeeRow>> = async (
  ctx,
  page,
) => {
  assertAllowed(await ctx.check(HR_PERM.employeeManage));
  // Kernel-composed (#811): the `WHERE`, `ORDER BY`, keyset tie-break, `LIMIT`
  // and the indexes behind them come from this operation's declared `paged.over`.
  return ctx.page<EmployeeRow>('employee', page ?? {});
};

/**
 * The manager/HR roster — employment facts only, no `national_id` and no
 * compensation (managers "see their department but never salary"). A node
 * `absence:read` holder passes (managers at scope, HR at tenant); employees,
 * holding it only as an entity grant, cannot enumerate the team.
 */
const rosterOp: OperationHandler<PageParams | undefined, Page<RosterRow>> = async (ctx, page) => {
  assertAllowed(await ctx.check(HR_PERM.absenceRead));
  // The kernel walks `employee`; dropping `national_id` is this operation's job
  // and stays here, which is what `mapPage` is for.
  return mapPage(ctx.page<EmployeeRow>('employee', page ?? {}), ({ national_id, ...rest }) => rest);
};

/**
 * "Who am I" for the app shell — the caller's own role hint + linked employee, resolved
 * from THIS scope. No permission gate: every principal in the scope may ask about
 * themselves (it reveals only their own role + own employee id, both already theirs). The
 * role is a UI hint derived by probing the caller's own grants — the kernel still enforces
 * the real permission on every operation regardless of what this returns.
 *
 * `country` is a per-instance display DEFAULT (currency + labels) and is hardcoded `SE` —
 * a known gap, not an oversight: no scope carries its own country yet, and giving it one is
 * a migration. Until then Pablo reads as Swedish here, and always did in a hosted install.
 * What changed is that it is now visible: the dev persona cast used to carry the country
 * beside each name, so the SE/ES split looked like it worked locally while the operation
 * behind it never answered anything but SE.
 */
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


const defineLeaveTypeOp: OperationHandler<z.infer<typeof defineLeaveTypeInput>, LeaveTypeRow> =
  async (ctx, raw) => {
    assertAllowed(await ctx.check(HR_PERM.absenceConfigure));
    const input = defineLeaveTypeInput.parse(raw);
    ctx.sql.exec(
      `INSERT OR REPLACE INTO hr_leave_types (key, label, kind, annual_days, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [input.key, input.label, input.kind, input.annualDays ?? null, ctx.now()],
    );
    // Same transaction: the vocabulary row here, the POLICY registration in the
    // engine (floor 0 — Sweden's förskottssemester would be a negative floor).
    configureLeaveType(ctx, { key: input.key });
    return ctx.sql.query<LeaveTypeRow>('SELECT * FROM hr_leave_types WHERE key = ?', [input.key])[0]!;
  };

// The shared read selectors. Named (and exported) so the API catalog documents
// the SAME objects the handlers parse — schemas an operation shares with
// another operation are still one object, one contract (design/api-surface.md).

// Leave types are scope vocabulary every absence-reader needs (an employee to
// see their own balances, HR/managers at the node). Optional employee entity:
// a node holder passes with none; an employee passes with their own record.
const listLeaveTypesOp: OperationHandler<
  (z.infer<typeof employeeFilterInput> & ListPage) | undefined,
  Page<LeaveTypeRow>
> = async (
  ctx,
  raw,
) => {
  const input = employeeFilterInput.parse(raw ?? {});
  const entity = input.employeeId ? employeeRef(input.employeeId) : undefined;
  assertAllowed(await ctx.check(HR_PERM.absenceRead, entity));
  const limit = Math.min(raw?.limit ?? LIST_PAGE_DEFAULT, LIST_PAGE_MAX);
  const rows = raw?.cursor
    ? ctx.sql.query<LeaveTypeRow>(
        'SELECT * FROM hr_leave_types WHERE key > ? ORDER BY key LIMIT ?',
        [raw.cursor, limit],
      )
    : ctx.sql.query<LeaveTypeRow>('SELECT * FROM hr_leave_types ORDER BY key LIMIT ?', [limit]);
  return pageOf(rows, limit, (r) => r.key);
};


const accrueOp: OperationHandler<z.infer<typeof accrueInput>, LedgerRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(HR_PERM.absenceConfigure));
  const input = accrueInput.parse(raw);
  // Directory + vocabulary checks stay HERE — the engine cannot dereference the
  // subject ref and never reads hr_employees/hr_leave_types.
  getEmployee(ctx, input.employeeId);
  leaveTypeMustExist(ctx, input.leaveTypeKey);
  const entry = recordEntry(ctx, {
    subject: absenceSubjectOf(input.employeeId),
    leaveTypeKey: input.leaveTypeKey,
    entryKind: 'accrual',
    delta: input.days,
    effectiveDate: input.effectiveDate ?? ctx.now().slice(0, 10),
    note: input.note,
  });
  return ledgerRowOf(entry);
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
  const keys = [
    ...new Set(listEntries(ctx, { subject: employeeRef(employeeId) }).map((e) => e.leaveTypeKey)),
  ].sort();
  return {
    employeeId,
    balances: keys.map((leaveTypeKey) => ({
      leaveTypeKey,
      balance: balanceAsOf(ctx, { subject: employeeRef(employeeId), leaveTypeKey }),
    })),
  };
};


const requestLeaveOp: OperationHandler<z.infer<typeof requestLeaveInput>, LeaveRequestRow> = async (
  ctx,
  raw,
) => {
  const input = requestLeaveInput.parse(raw);
  assertAllowed(await ctx.check(HR_PERM.absenceRequest, employeeRef(input.employeeId)));
  getEmployee(ctx, input.employeeId);
  leaveTypeMustExist(ctx, input.leaveTypeKey);
  return requestRowOf(
    requestAbsence(ctx, {
      subject: absenceSubjectOf(input.employeeId),
      leaveTypeKey: input.leaveTypeKey,
      startDate: input.startDate,
      endDate: input.endDate,
      days: input.days,
      note: input.note,
    }),
  );
};


const decideLeaveOp: OperationHandler<
  z.infer<typeof decideLeaveInput>,
  { request: LeaveRequestRow; booking: LedgerRow | null }
> = async (ctx, raw) => {
  assertAllowed(await ctx.check(HR_PERM.absenceApprove));
  const input = decideLeaveInput.parse(raw);
  // The engine owns the whole transition: the no-skip guard, the floor check at
  // decision time, and the rule that only an APPROVED request books the ledger.
  const { request, booking } = decideAbsence(ctx, input);
  return { request: requestRowOf(request), booking: booking ? ledgerRowOf(booking) : null };
};

// The stale-request expiry (#383) moved to the engine with the ledger: the
// engine's manifest declares the `absence/expire-stale` schedule, so the sweep
// cancels an unapproved leave past its start date under
// `{ system: '@substrat-run/engine-absence' }` — no vertical code involved.

const requestStatus = z.enum(['requested', 'approved', 'rejected', 'cancelled']);

const listRequestsOp: OperationHandler<
  (z.infer<typeof statusFilterInput> & ListPage) | undefined,
  Page<LeaveRequestRow>
> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(HR_PERM.absenceRead));
  const { status } = statusFilterInput.parse(raw ?? {});
  const rows = listAbsenceRequests(ctx, {
    status: status === undefined ? undefined : requestStatus.parse(status),
  }).map(requestRowOf);
  rows.reverse(); // the shipped order: created_at ascending
  return pageBy(rows, raw ?? {}, (r) => r.id);
};

/** One employee's own requests — the self-service path (entity-checked). */
const myRequestsOp: OperationHandler<
  z.infer<typeof employeeIdInput> & ListPage,
  Page<LeaveRequestRow>
> = async (ctx, input) => {
  const { employeeId } = employeeIdInput.parse(input);
  assertAllowed(await ctx.check(HR_PERM.absenceRead, employeeRef(employeeId)));
  const rows = listAbsenceRequests(ctx, { subject: employeeRef(employeeId) }).map(requestRowOf);
  return pageBy(rows, input, (r) => r.id);
};

// ---------------------------------------------------------------------------
// Projects + time reporting (the second append-only ledger)
// ---------------------------------------------------------------------------


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
    ctx.now(),
  ]);
  return ctx.sql.query<ProjectRow>('SELECT * FROM hr_projects WHERE id = ?', [id])[0]!;
};

/**
 * The project catalogue — readable by any time-reporter. A node holder (HR,
 * manager) passes with no entity; an employee passes with their own record,
 * whose grant carries `time:read`. Same op, two ways in.
 */
const listProjectsOp: OperationHandler<
  (z.infer<typeof employeeFilterInput> & ListPage) | undefined,
  Page<ProjectRow>
> = async (
  ctx,
  raw,
) => {
  const input = employeeFilterInput.parse(raw ?? {});
  const entity = input.employeeId ? employeeRef(input.employeeId) : undefined;
  assertAllowed(await ctx.check(HR_PERM.timeRead, entity));
  const limit = Math.min(raw?.limit ?? LIST_PAGE_DEFAULT, LIST_PAGE_MAX);
  const rows = raw?.cursor
    ? ctx.sql.query<ProjectRow>('SELECT * FROM hr_projects WHERE code > ? ORDER BY code LIMIT ?', [
        raw.cursor,
        limit,
      ])
    : ctx.sql.query<ProjectRow>('SELECT * FROM hr_projects ORDER BY code LIMIT ?', [limit]);
  return pageOf(rows, limit, (r) => r.code);
};


const logTimeOp: OperationHandler<z.infer<typeof logTimeInput>, TimeEntryRow> = async (ctx, raw) => {
  const input = logTimeInput.parse(raw);
  assertAllowed(await ctx.check(HR_PERM.timeReport, employeeRef(input.employeeId)));
  getEmployee(ctx, input.employeeId);
  if (input.projectId) {
    const p = ctx.sql.query<ProjectRow>('SELECT id FROM hr_projects WHERE id = ?', [input.projectId])[0];
    if (!p) throw substratError('not_found', `project not found: ${input.projectId}`);
  }
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO hr_time_entries (id, employee_id, project_id, work_date, hours, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.employeeId, input.projectId ?? null, input.workDate, input.hours, input.note ?? null, ctx.principal, ctx.now()],
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
    [id, input.employeeId, input.projectId ?? null, input.description, input.amount, input.currency, input.category, ctx.principal, ctx.now()],
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


const decideExpenseOp: OperationHandler<z.infer<typeof decideExpenseInput>, ExpenseRow> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(HR_PERM.expenseApprove));
  const input = decideExpenseInput.parse(raw);
  const exp = ctx.sql.query<ExpenseRow>('SELECT * FROM hr_expenses WHERE id = ?', [input.expenseId])[0];
  if (!exp) throw substratError('not_found', `expense not found: ${input.expenseId}`);
  if (exp.status !== 'submitted') {
    throw conflict(
      'not_submitted',
      `expense ${exp.id} is '${exp.status}' — only a submitted expense can be decided`,
    );
  }
  const status = input.decision === 'approve' ? 'approved' : 'rejected';
  ctx.sql.exec(`UPDATE hr_expenses SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`, [
    status,
    ctx.principal,
    ctx.now(),
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

const listExpensesOp: OperationHandler<
  (z.infer<typeof statusFilterInput> & ListPage) | undefined,
  Page<ExpenseRow>
> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(HR_PERM.expenseRead));
  const { status } = statusFilterInput.parse(raw ?? {});
  const limit = Math.min(raw?.limit ?? LIST_PAGE_DEFAULT, LIST_PAGE_MAX);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (raw?.cursor) {
    where.push('id > ?');
    params.push(raw.cursor);
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  // Ids are ULIDs, so an `id` walk is the `created_at` walk this shipped with,
  // minus the tie a shared timestamp would bring.
  const rows = ctx.sql.query<ExpenseRow>(
    `SELECT * FROM hr_expenses${clause} ORDER BY id LIMIT ?`,
    [...params, limit],
  );
  return pageOf(rows, limit, (r) => r.id);
};

/** One employee's own expenses — the self-service path (entity-checked). */
const myExpensesOp: OperationHandler<
  z.infer<typeof employeeIdInput> & ListPage,
  Page<ExpenseRow>
> = async (ctx, input) => {
  const { employeeId } = employeeIdInput.parse(input);
  assertAllowed(await ctx.check(HR_PERM.expenseRead, employeeRef(employeeId)));
  const limit = Math.min(input.limit ?? LIST_PAGE_DEFAULT, LIST_PAGE_MAX);
  // Descending, as this list shipped — so the cursor walks strictly BEFORE.
  const rows = input.cursor
    ? ctx.sql.query<ExpenseRow>(
        'SELECT * FROM hr_expenses WHERE employee_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        [employeeId, input.cursor, limit],
      )
    : ctx.sql.query<ExpenseRow>(
        'SELECT * FROM hr_expenses WHERE employee_id = ? ORDER BY id DESC LIMIT ?',
        [employeeId, limit],
      );
  return pageOf(rows, limit, (r) => r.id);
};

// ---------------------------------------------------------------------------
// Payroll export — the variable-pay handoff (the invoice basis pattern, §7).
// Approved-but-unexported expenses + booked absence in the window → one file,
// then the expenses are marked exported so the next run never double-counts.
// ---------------------------------------------------------------------------



const payrollExportOp: OperationHandler<z.infer<typeof payrollExportInput>, PayrollExport> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(HR_PERM.payrollExport));
  const input = payrollExportInput.parse(raw);
  const expenses = ctx.sql.query<ExpenseRow>(
    `SELECT * FROM hr_expenses WHERE status = 'approved' ORDER BY created_at`,
  );
  // Booked absence in the window, through the engine's window read — the same
  // composition seam Egeryds' planner uses, pointed at payroll here.
  const absenceRows = entriesInWindow(ctx, {
    from: input.fromDate,
    to: input.toDate,
    entryKind: 'booking',
  });
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
    absence: absenceRows.map((a) => ({ employeeId: a.subject.entityId, leaveTypeKey: a.leaveTypeKey, days: negate(a.delta) })),
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
      ctx.now(),
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
  if (!terms)
    throw conflict('no_terms', `no employment terms set for ${employee.number} — set them first`);

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
  // #687: the employee's own address, so the contract reaches the person it is
  // for. The engine seals it to the Scrive connection before emitting, so this
  // vertical passes a plain email and nothing downstream — the outbox, the
  // platform intent, the console — ever holds a readable one.
  //
  // Refused here rather than there, because this is where the fact is missing: an
  // employee row with no email cannot be sent a contract, and saying so names the
  // employee instead of a party label.
  if (!employee.email) {
    throw conflict(
      'no_email',
      `employee ${employee.number} (${employee.name}) has no email, so the contract has ` +
        'nowhere to go — set one before issuing',
    );
  }
  // THE EMPLOYER SIGNS, AND IS INVITED LIKE ANYONE ELSE (#852).
  //
  // This party used to carry no address, on the reasoning that it was the document's
  // author and Scrive reached it as our own API account. That was true and it was the
  // bug: the author slot is bound to the ACCOUNT HOLDER, so whoever issued the contract
  // was silently replaced by whoever owns the Scrive account — and the return path could
  // never record their signature, because the substituted name never matched the label.
  // The connector now sends the account as a non-signing sender, which makes this an
  // ordinary signatory that needs an ordinary address.
  //
  // It is the issuing HR user's own, looked up the same way the employee's is, and
  // refused by name when it is missing rather than guessed at.
  const signer = ctx.sql.query<{ name: string; email: string | null }>(
    'SELECT name, email FROM hr_employees WHERE principal_ref = ? LIMIT 1',
    [ctx.principal],
  )[0];
  if (!signer?.email) {
    throw conflict(
      'no_email',
      'the issuing user has no email on their employee record — the employer signs the ' +
        'contract too and is invited by mail, so it cannot be sent without one',
    );
  }
  const sent = await requestSignatures(ctx, {
    instanceId: instance.id,
    method: 'scrive',
    parties: [
      {
        label: 'Arbetsgivare',
        kind: 'principal',
        ref: ctx.principal,
        signatureKind: 'primary',
        contact: { email: signer.email },
      },
      { label: 'Anställd', kind: 'external', ref: employee.id, contact: { email: employee.email } },
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

/**
 * #800. This hand-rolled the walk and PAGED IT WRONG: the cursor was
 * `occurred_at` and the step was `occurred_at > ?`, so every row sharing the last
 * one's timestamp was skipped. Sharing it is the norm rather than a rare tie —
 * `ctx.now()` does not move inside an operation (#812), so every event one
 * operation emits carries the identical instant, and a page boundary landing
 * inside them lost the rest. `readTimeline` walks the event id instead.
 */
const timelineOp: OperationHandler<
  z.infer<typeof timelineInput> & ListPage,
  Page<TimelineEntry>
> = async (ctx, input) => {
  const entity: EntityRef = timelineInput.parse(input);
  assertAllowed(await ctx.check(HR_PERM.absenceRead, entity));
  return readTimeline(ctx, entity, input);
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
  /**
   * #893: the host parses each operation's declared `input` before the guards
   * and the handler see it. Derived from the same declaration that produces the
   * manifest and the routes — the schema is written once, in `operations.ts`.
   *
   * Meridian is the one of the four that already parsed all 18 by hand, and its
   * suite stayed green through the change — which is the confirmation #893 asked
   * for. The handler-side calls are left where they are: a second parse of an
   * already-parsed value is a no-op, and removing eighteen of them is churn that
   * would bury the part of this diff worth reading.
   */
  operationInputs: operationInputsOf(meridianOperations),
};
