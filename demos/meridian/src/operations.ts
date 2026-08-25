/**
 * Meridian's declared operation surface (#707/#865/#891).
 *
 * ## Why this file exists now
 *
 * Twenty-seven handlers registered as `'hr/create-employee': createEmployeeOp as
 * never`, and the only description of what each one checked was its body.
 * Thirteen of those checks narrow to an entity, and `entityCheckConformanceSuite`
 * derives its behavioural pair from an operation's `permission` — so undeclared,
 * they were not merely untested but **undeclarable**. To a compiler
 * `ctx.check(HR_PERM.timeRead, employeeRef(id))` and `ctx.check(HR_PERM.timeRead)`
 * are the same, and the second lets anyone holding `time:read` read every
 * employee's timesheet. Meridian mints nine keys narrowed per employee (§4 of its
 * `PERMISSIONS.md`), so that is the difference between an employee seeing their
 * own record and seeing everyone's.
 *
 * ## Three shapes the declaration format cannot state, named rather than hidden
 *
 * **1. The conditional narrow.** `hr/list-leave-types` and `hr/list-projects` do
 * `input.employeeId ? employeeRef(input.employeeId) : undefined` — a narrowed
 * check when the caller scopes the read, a NODE check when they do not. Declaring
 * `idFrom: 'employeeId'` on an optional field would claim narrowing that a caller
 * omitting the field does not get, which is the unsafe direction for a review
 * artifact to be wrong in. They declare the bare key: true of the unscoped call,
 * and an understatement for a narrowed-grant holder. The kit therefore does not
 * drive them, and that is a real gap rather than a covered case.
 *
 * **2. The second authority.** `hr/issue-employment-contract` opens with
 * `employee:manage`, then checks `protocol:bind` and `protocol:request-signature`
 * against the instance it just created. `permission` names ONE key, so the
 * declaration carries the gate the operation opens with; the other two are
 * `resolved` — their entity id is minted inside the handler and is not in the
 * input, so the kit could not reach them even if the format could hold them.
 *
 * **3. The caller-named entity type — settled (#890).** `hr/timeline` took
 * `{ entityType, entityId }` with `entityType` a free string, so its declared
 * `entity: 'employee'` was accurate to every caller and narrower than the input.
 * The answer was not a format that can say "the caller names the type": the set
 * of types was never wider than one, so `timelineInput` pins the literal and the
 * declaration is now exact. Callout's and Handlebar's timelines went the same
 * way. What remains open is the ENGINE case, where the type genuinely is the
 * caller's — `engines/absence` narrows to a subject whose noun only the vertical
 * knows — and no `entity` name in absence's own registry can describe it.
 */
import { defineOperations, z } from '@substrat-run/contracts';
import { protocolEntities } from '@substrat-run/engine-protocol';
import { meridianEntities } from './entities.js';
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
import {
  employeeRow,
  employmentTermsRow,
  expenseRow,
  leaveRequestRow,
  leaveTypeRow,
  ledgerRow,
  payrollExport,
  projectRow,
  protocolInstanceRow,
  rosterRow,
  timeEntryRow,
  timelineEntry,
  whoAmI,
} from './schemas.js';

/**
 * Every key these operations check — Meridian's own, plus the engine keys it
 * enforces on the engines' behalf.
 *
 * `absence:*` belongs to engine-absence and `protocol:*` to engine-protocol
 * (both are aliased at their reference sites in `manifest.ts` so the ownership is
 * visible). They appear here because `defineOperations` checks each declared
 * `permission` against this list, and an operation that checks a key the list
 * does not carry should not compile. The MANIFEST still declares only the eight
 * keys Meridian owns — a vertical restating another module's permissions is the
 * two-descriptions defect `checksDeclaredElsewhere` exists to prevent.
 */
export const MERIDIAN_PERMISSIONS = [
  'employee:manage',
  'time:report',
  'time:read',
  'project:manage',
  'expense:submit',
  'expense:approve',
  'expense:read',
  'payroll:export',
  'absence:configure',
  'absence:request',
  'absence:approve',
  'absence:read',
  'protocol:create',
  'protocol:bind',
  'protocol:request-signature',
  'protocol:read',
] as const;

/** The narrowed check seven employee-facing operations share. */
const onEmployee = (key: (typeof MERIDIAN_PERMISSIONS)[number]) =>
  ({ key, entity: 'employee', idFrom: 'employeeId' }) as const;

export const meridianOperations = defineOperations(
  meridianEntities,
  MERIDIAN_PERMISSIONS,
  // The composed engine, so an operation may narrow to an entity the ENGINE
  // owns — `hr/verify-contract` checks `protocol:read` on a protocol instance.
  [protocolEntities],
)({
  'hr/create-employee': {
    summary: 'Create an employee record',
    permission: 'employee:manage',
    input: createEmployeeInput,
    output: employeeRow,
  },

  'hr/list-employees': {
    summary: 'Every employee, including the columns only HR may see',
    permission: 'employee:manage',
    output: employeeRow,
    paged: {
      over: { entity: 'employee', sortable: ['number', 'name', 'created_at'], filterable: [] },
    },
  },

  'hr/roster': {
    summary: 'The employee roster, without the columns only HR may see',
    permission: 'time:read',
    output: rosterRow,
    paged: {
      over: { entity: 'employee', sortable: ['number', 'name', 'created_at'], filterable: [] },
    },
  },

  'hr/whoami': {
    summary: 'Which role and employee record the caller is',
    // Node, and deliberately the weakest key: this read is how the app decides
    // which screens to render, so anyone who may see any of them may ask.
    permission: 'time:read',
    output: whoAmI,
  },

  'hr/define-leave-type': {
    summary: 'Define or update a leave type',
    permission: 'absence:configure',
    input: defineLeaveTypeInput,
    output: leaveTypeRow,
  },

  'hr/list-leave-types': {
    summary: 'Leave types, optionally scoped to one employee',
    // Conditional narrow — see the header. The bare key is the honest statement.
    permission: 'absence:read',
    input: employeeFilterInput,
    inputOptional: true,
    output: leaveTypeRow,
    paged: { sortKey: 'key' },
  },

  'hr/accrue': {
    summary: 'Record an accrual, correction or carryover against a balance',
    permission: 'absence:configure',
    input: accrueInput,
    output: ledgerRow,
  },

  'hr/balance': {
    summary: "One employee's leave balances",
    permission: onEmployee('absence:read'),
    input: employeeIdInput,
    output: z.object({
      employeeId: z.string(),
      balances: z.array(z.object({ leaveTypeKey: z.string(), balance: z.string() })),
    }),
  },

  'hr/request-leave': {
    summary: 'Request leave for an employee',
    permission: onEmployee('absence:request'),
    input: requestLeaveInput,
    output: leaveRequestRow,
  },

  'hr/decide-leave': {
    summary: 'Approve or reject a leave request',
    permission: 'absence:approve',
    input: decideLeaveInput,
    output: z.object({ request: leaveRequestRow, booking: ledgerRow.nullable() }),
  },

  'hr/list-requests': {
    summary: 'Leave requests, optionally filtered by status',
    permission: 'absence:read',
    input: statusFilterInput,
    inputOptional: true,
    output: leaveRequestRow,
    paged: { sortKey: 'id' },
  },

  'hr/my-requests': {
    summary: "One employee's own leave requests",
    permission: onEmployee('absence:read'),
    input: employeeIdInput,
    output: leaveRequestRow,
    paged: { sortKey: 'id' },
  },

  'hr/create-project': {
    summary: 'Create a project time books against',
    permission: 'project:manage',
    input: createProjectInput,
    output: projectRow,
  },

  'hr/list-projects': {
    summary: 'Projects, optionally scoped to one employee',
    // Conditional narrow — see the header.
    permission: 'time:read',
    input: employeeFilterInput,
    inputOptional: true,
    output: projectRow,
    // `code` is UNIQUE in the schema and is the order this list shipped with.
    paged: { sortKey: 'code' },
  },

  'hr/log-time': {
    summary: 'Log worked hours for an employee',
    permission: onEmployee('time:report'),
    input: logTimeInput,
    output: timeEntryRow,
  },

  'hr/timesheet': {
    summary: "One employee's time entries and total",
    permission: onEmployee('time:read'),
    input: employeeIdInput,
    output: z.object({
      employeeId: z.string(),
      entries: z.array(timeEntryRow),
      totalHours: z.string(),
    }),
  },

  'hr/submit-expense': {
    summary: 'Submit an expense for an employee',
    permission: onEmployee('expense:submit'),
    input: submitExpenseInput,
    output: expenseRow,
  },

  'hr/decide-expense': {
    summary: 'Approve or reject an expense',
    permission: 'expense:approve',
    input: decideExpenseInput,
    output: expenseRow,
  },

  'hr/list-expenses': {
    summary: 'Expenses, optionally filtered by status',
    permission: 'expense:read',
    input: statusFilterInput,
    inputOptional: true,
    output: expenseRow,
    paged: { sortKey: 'id' },
  },

  'hr/my-expenses': {
    summary: "One employee's own expenses",
    permission: onEmployee('expense:read'),
    input: employeeIdInput,
    output: expenseRow,
    // Newest first, as this list shipped. Ids are ULIDs, so an `id` walk is a
    // `created_at` walk without the tie a shared timestamp would bring.
    paged: { sortKey: 'id', order: 'desc' },
  },

  'hr/payroll-export': {
    summary: 'The variable-pay export for a period',
    permission: 'payroll:export',
    input: payrollExportInput,
    output: payrollExport,
  },

  'hr/set-employment-terms': {
    summary: 'Set an employment terms record',
    permission: 'employee:manage',
    input: setTermsInput,
    output: employmentTermsRow,
  },

  'hr/employment-terms': {
    summary: "An employee's latest employment terms",
    permission: 'employee:manage',
    input: employeeIdInput,
    output: employmentTermsRow.nullable(),
  },

  'hr/issue-employment-contract': {
    summary: 'Issue the employment contract for signature',
    // The gate this opens with. It then checks `protocol:bind` and
    // `protocol:request-signature` on the instance it mints — see the header.
    permission: 'employee:manage',
    input: issueContractInput,
    output: z.object({ instance: protocolInstanceRow, contentHash: z.string() }),
  },

  'hr/verify-contract': {
    summary: 'Replay the contract hash against the terms row it was bound to',
    permission: { key: 'protocol:read', entity: 'protocol', idFrom: 'instanceId' },
    input: instanceIdInput,
    output: z.object({
      matches: z.boolean(),
      boundHash: z.string().nullable(),
      replayedHash: z.string().nullable(),
      status: z.string(),
    }),
  },

  'hr/start-onboarding': {
    summary: 'Start the onboarding checklist for an employee',
    permission: 'employee:manage',
    input: startOnboardingInput,
    output: protocolInstanceRow,
  },

  'hr/timeline': {
    summary: 'The spine, for one entity',
    // The constant every call site passes, and since #890 the only thing the
    // input accepts — see the header, and `timelineInput`.
    permission: { key: 'absence:read', entity: 'employee', idFrom: 'entityId' },
    input: timelineInput,
    output: timelineEntry,
    // The cursor is `id` — the event's ULID, and this employee's version at that
    // point (#901). It said `occurred_at`, and the handler walked `occurred_at`
    // too, which is how the page came to drop every event sharing an instant
    // (#800): a truthful declaration of a broken cursor.
    paged: { sortKey: 'id' },
  },
});
