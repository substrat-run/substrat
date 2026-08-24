import { z } from '@substrat-run/contracts';
import { protocolEntities } from '@substrat-run/engine-protocol';
import { meridianEntities } from './entities.js';

/**
 * What Meridian's operations ANSWER, as schemas (#707/#865/#891).
 *
 * These were nine hand-written `export interface`s in `module.ts`. They became
 * schemas because `defineOperations` declares an operation's `output`, and a
 * TypeScript interface cannot be one.
 *
 * The two that back a DECLARED entity are derived from the registry rather than
 * restated — `hr_employees` and `hr_employment_terms` are described once, in
 * `entities.ts`, and a column added there reaches the published row without
 * anyone remembering to. The other seven are tables this vertical owns that are
 * deliberately not entities (`entities.ts` says why: none is ever the subject of
 * an `EntityRef`), so there is no registry entry to derive them from and they are
 * written out here.
 *
 * `module.ts` re-exports every type below, so nothing that imported a row shape
 * from there had to change.
 */

export const employeeRow = meridianEntities.employee.fields;
export type EmployeeRow = z.infer<typeof employeeRow>;

export const employmentTermsRow = meridianEntities['employment-terms'].fields;
export type EmploymentTermsRow = z.infer<typeof employmentTermsRow>;

/**
 * The roster is the employee list minus the one column that is nobody's business
 * but HR's. Derived by `omit` so a new column on `employee` is visible here as a
 * decision to make, rather than silently absent.
 */
export const rosterRow = employeeRow.omit({ national_id: true });
export type RosterRow = z.infer<typeof rosterRow>;

export const leaveTypeRow = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.string(),
  annual_days: z.string().nullable(),
  created_at: z.string(),
});
export type LeaveTypeRow = z.infer<typeof leaveTypeRow>;

export const ledgerRow = z.object({
  id: z.string(),
  employee_id: z.string(),
  leave_type_key: z.string(),
  entry_kind: z.enum(['accrual', 'booking', 'correction', 'carryover', 'reversal']),
  delta: z.string(),
  effective_date: z.string(),
  request_id: z.string().nullable(),
  note: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
});
export type LedgerRow = z.infer<typeof ledgerRow>;

export const leaveRequestRow = z.object({
  id: z.string(),
  employee_id: z.string(),
  leave_type_key: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  days: z.string(),
  status: z.enum(['requested', 'approved', 'rejected', 'cancelled']),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  note: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
});
export type LeaveRequestRow = z.infer<typeof leaveRequestRow>;

export const projectRow = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  created_at: z.string(),
});
export type ProjectRow = z.infer<typeof projectRow>;

export const timeEntryRow = z.object({
  id: z.string(),
  employee_id: z.string(),
  project_id: z.string().nullable(),
  work_date: z.string(),
  hours: z.string(),
  note: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
});
export type TimeEntryRow = z.infer<typeof timeEntryRow>;

export const expenseRow = z.object({
  id: z.string(),
  employee_id: z.string(),
  project_id: z.string().nullable(),
  description: z.string(),
  amount: z.string(),
  currency: z.string(),
  category: z.string(),
  status: z.enum(['submitted', 'approved', 'rejected', 'exported']),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
});
export type ExpenseRow = z.infer<typeof expenseRow>;

export const whoAmI = z.object({
  role: z.enum(['hr-admin', 'manager', 'employee', 'none']),
  country: z.enum(['SE', 'ES']),
  employeeId: z.string().nullable(),
});
export type WhoAmI = z.infer<typeof whoAmI>;

export const payrollExport = z.object({
  fromDate: z.string(),
  toDate: z.string(),
  expenses: z.array(
    z.object({
      employeeId: z.string(),
      amount: z.string(),
      currency: z.string(),
      category: z.string(),
    }),
  ),
  absence: z.array(
    z.object({ employeeId: z.string(), leaveTypeKey: z.string(), days: z.string() }),
  ),
});
export type PayrollExport = z.infer<typeof payrollExport>;

/**
 * The engine's row, taken from the engine's own registry.
 *
 * `ProtocolInstanceRow` is already `EntityRow<typeof protocolEntities,
 * 'protocol'>`, so this is the schema behind the type a vertical operation
 * already returns — not a second description of it.
 */
export const protocolInstanceRow = protocolEntities.protocol.fields;

/** One entry of the spine, as `hr/timeline` answers it. */
export const timelineEntry = z.object({
  type: z.string(),
  occurred_at: z.string(),
  actor: z.string(),
});
export type TimelineEntry = z.infer<typeof timelineEntry>;
