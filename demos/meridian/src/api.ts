import { buildOpenApiDocument, type ApiCatalog } from '@substrat-run/contracts';
import { meridianManifest } from './manifest.js';
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
  meridianModule,
  payrollExportInput,
  requestLeaveInput,
  setTermsInput,
  startOnboardingInput,
  statusFilterInput,
  submitExpenseInput,
  timelineInput,
} from './module.js';

/**
 * The operation catalog (design/api-surface.md §2.1): every registered
 * operation, documented against the SAME Zod schema its handler parses. This
 * is the authoring surface for the vertical's OpenAPI document — served live
 * at `/openapi.json`, rendered at `/api/docs`, and written to the checked-in
 * `openapi.json` that `pnpm lint:api --check` holds against drift.
 *
 * **This catalog now overlaps `operations.ts`, and that is a known seam, not a
 * design.** `defineOperations` arrived with #891 and declares each operation's
 * summary, input and output; this file still declares the summary, the input and
 * the `tag`/`description` the OpenAPI document groups by, which the operation
 * format has no field for. So two files describe one surface until the API
 * document is derived from the declaration — the convergence #756 is about.
 * Until then, an operation added to one and not the other is the drift to watch;
 * `pnpm lint:api --check` catches it only for the half that reaches `openapi.json`.
 *
 * A missing `output` here documents the 200 generically. The row schemas that
 * would fill them now exist in `schemas.ts` — they were TS interfaces when this
 * note was written.
 */
export const API: ApiCatalog = {
  'hr/create-employee': {
    tag: 'Directory',
    summary: 'Create an employee record.',
    description: 'Requires `employee:manage`. PII (national id) stays in the record — it is never emitted on the event spine.',
    input: createEmployeeInput,
  },
  'hr/list-employees': {
    tag: 'Directory',
    summary: 'List all employees, including PII fields.',
    description: 'Requires `employee:manage` (HR admin). Managers use `hr/roster` instead.',
  },
  'hr/roster': {
    tag: 'Directory',
    summary: 'The roster — employment facts only, no national id, no compensation.',
    description: 'Requires `absence:read` held at the node (managers, HR). An employee’s own-record grant does not enumerate the team.',
  },
  'hr/whoami': {
    tag: 'Directory',
    summary: 'The caller’s own role hint and linked employee id.',
    description: 'No permission gate: reveals only the caller’s own facts. The kernel still enforces the real permission on every operation regardless of this hint.',
  },
  'hr/define-leave-type': {
    tag: 'Leave',
    summary: 'Define (or redefine) a leave type.',
    description: 'Requires `absence:configure`.',
    input: defineLeaveTypeInput,
  },
  'hr/list-leave-types': {
    tag: 'Leave',
    summary: 'List leave types.',
    description: 'Requires `absence:read` — at the node, or via the caller’s own-record grant when `employeeId` names their own record.',
    input: employeeFilterInput,
    inputOptional: true,
  },
  'hr/accrue': {
    tag: 'Leave',
    summary: 'Grant an accrual to an employee’s absence ledger.',
    description: 'Requires `absence:configure`. The ledger is append-only: an accrual is a new row, never an edit.',
    input: accrueInput,
  },
  'hr/balance': {
    tag: 'Leave',
    summary: 'One employee’s balance per leave type (a fold of the ledger).',
    description: 'Requires `absence:read` for the named employee — node holders pass for anyone, employees only for themselves.',
    input: employeeIdInput,
  },
  'hr/request-leave': {
    tag: 'Leave',
    summary: 'Request time off.',
    description: 'Requires `absence:request` for the named employee (self-service via the own-record grant).',
    input: requestLeaveInput,
  },
  'hr/decide-leave': {
    tag: 'Leave',
    summary: 'Approve or reject a leave request.',
    description: 'Requires `absence:approve`. Only a `requested` leave can be decided; approval books the ledger and cannot overdraw the balance.',
    input: decideLeaveInput,
  },
  'hr/list-requests': {
    tag: 'Leave',
    summary: 'List leave requests, optionally by status.',
    description: 'Requires `absence:read` at the node.',
    input: statusFilterInput,
    inputOptional: true,
  },
  'hr/my-requests': {
    tag: 'Leave',
    summary: 'One employee’s own leave requests (the self-service path).',
    description: 'Requires `absence:read` for the named employee.',
    input: employeeIdInput,
  },
  'hr/create-project': {
    tag: 'Time',
    summary: 'Create a project for time to book against.',
    description: 'Requires `project:manage`.',
    input: createProjectInput,
  },
  'hr/list-projects': {
    tag: 'Time',
    summary: 'The project catalogue.',
    description: 'Requires `time:read` — at the node, or via the caller’s own-record grant when `employeeId` names their own record.',
    input: employeeFilterInput,
    inputOptional: true,
  },
  'hr/log-time': {
    tag: 'Time',
    summary: 'Log worked hours (append-only).',
    description: 'Requires `time:report` for the named employee.',
    input: logTimeInput,
  },
  'hr/timesheet': {
    tag: 'Time',
    summary: 'One employee’s time entries and total.',
    description: 'Requires `time:read` for the named employee.',
    input: employeeIdInput,
  },
  'hr/submit-expense': {
    tag: 'Expenses',
    summary: 'Submit an expense.',
    description: 'Requires `expense:submit` for the named employee.',
    input: submitExpenseInput,
  },
  'hr/decide-expense': {
    tag: 'Expenses',
    summary: 'Approve or reject a submitted expense.',
    description: 'Requires `expense:approve`. Only a `submitted` expense can be decided.',
    input: decideExpenseInput,
  },
  'hr/list-expenses': {
    tag: 'Expenses',
    summary: 'List expenses, optionally by status.',
    description: 'Requires `expense:read` at the node.',
    input: statusFilterInput,
    inputOptional: true,
  },
  'hr/my-expenses': {
    tag: 'Expenses',
    summary: 'One employee’s own expenses (the self-service path).',
    description: 'Requires `expense:read` for the named employee.',
    input: employeeIdInput,
  },
  'hr/payroll-export': {
    tag: 'Payroll',
    summary: 'The variable-pay export: approved expenses + booked absence in the window.',
    description: 'Requires `payroll:export`. Exported expenses are marked so a re-run never double-counts.',
    input: payrollExportInput,
  },
  'hr/set-employment-terms': {
    tag: 'Contracts',
    summary: 'Set an employee’s employment terms (append-only; latest wins).',
    description: 'Requires `employee:manage`. A signed contract pins the hash of the terms row current when it was issued.',
    input: setTermsInput,
  },
  'hr/employment-terms': {
    tag: 'Contracts',
    summary: 'The latest employment terms for one employee.',
    description: 'Requires `employee:manage`.',
    input: employeeIdInput,
  },
  'hr/issue-employment-contract': {
    tag: 'Contracts',
    summary: 'Issue the employment contract for signature (instantiate, bind, dispatch — one transaction).',
    description: 'Requires `employee:manage` plus the protocol engine’s create/bind/request-signature permissions.',
    input: issueContractInput,
  },
  'hr/verify-contract': {
    tag: 'Contracts',
    summary: 'Re-derive the terms hash and compare it to what the protocol froze.',
    description: 'Requires protocol read on the instance. `matches: false` means the terms row moved after issue — a finding, not an invalid signature.',
    input: instanceIdInput,
  },
  'hr/start-onboarding': {
    tag: 'Onboarding',
    summary: 'Start an onboarding checklist for an employee (protocol engine, composed).',
    description: 'Requires the protocol engine’s create permission.',
    input: startOnboardingInput,
  },
  'hr/timeline': {
    tag: 'Timeline',
    summary: 'The event-spine timeline for one entity.',
    description: 'Requires `absence:read` for the entity.',
    input: timelineInput,
  },
};

// Catalog/registration parity — checked at import time so the worker, the dev
// server, and the emit tool all refuse to run with an undocumented operation
// (or a documented ghost). This is what makes "every operation appears in the
// PR diff" structural rather than diligent.
{
  const registered = Object.keys(meridianModule.operations ?? {});
  const documented = new Set(Object.keys(API));
  const missing = registered.filter((op) => !documented.has(op));
  const ghosts = [...documented].filter((op) => !registered.includes(op));
  if (missing.length || ghosts.length) {
    throw new Error(
      `api catalog drift — undocumented: [${missing.join(', ')}], not registered: [${ghosts.join(', ')}]`,
    );
  }
}

/** The OpenAPI 3.1 document — deterministic, versioned by the module manifest. */
export const API_DOCUMENT = buildOpenApiDocument(
  {
    title: 'Meridian HR API',
    version: meridianManifest.version,
    description:
      'The Meridian demo vertical (employees, leave, time, expenses, payroll, employment contracts, onboarding) on the Substrat kernel. Every operation checks a permission for the calling principal; a 403 here is the permission system working, not a bug.',
  },
  API,
);
