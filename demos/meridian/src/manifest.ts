import { moduleManifest, permissionKey } from '@substrat-run/contracts';

// ============================================================================
// The Meridian vertical's declarative surface: the permission keys and the
// manifest metadata (events, entity relations, entitlement). Everything a
// reader needs to grasp the SHAPE of the vertical, with nothing executable —
// operations live in module.ts, the migration journal in migrations.ts.
//
// HR_PERM and the manifest's `permissions` list are the same keys expressed
// twice; keep them side by side so "add a permission" is a single-file edit.
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
      { type: 'hr.leave-expired', schemaVersion: 1 },
      { type: 'hr.time-logged', schemaVersion: 1 },
      { type: 'hr.expense-submitted', schemaVersion: 1 },
      { type: 'hr.expense-decided', schemaVersion: 1 },
      { type: 'hr.payroll-exported', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  // #383: a recurring, date-triggered rule. The platform sweep invokes this on
  // every live Meridian scope daily, under a system actor holding exactly
  // `absence:approve` — cancelling leaves left unapproved past their start date.
  schedules: [
    { operation: 'hr/expire-stale-requests', cadence: { everyMinutes: 1440 }, permissions: ['absence:approve'] },
  ],
  attachmentTargets: [{ entityType: 'employee', readPermission: 'absence:read' }],
  entityRelations: [
    // Onboarding checklists (protocol engine) hang off employees; THIS vertical
    // owns that vocabulary, so it declares the permission-walk edge — which is
    // also what lets an employee's own-record grant reach their onboarding fill.
    { entityType: 'protocol', parentType: 'employee' },
  ],
  entitlementKey: 'meridian',
});
