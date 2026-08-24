import { z } from '@substrat-run/contracts';

/**
 * What Meridian's operations ACCEPT (#707/#865/#891).
 *
 * Moved out of `module.ts` unchanged. `operations.ts` declares each operation's
 * `input` as the SAME schema the handler parses, and a declaration file that
 * imports the implementation would close a cycle — so the schemas live below
 * both, the way `entities.ts` and `schemas.ts` do. `module.ts` re-exports every
 * one of them, so nothing that imported an input schema from there had to change.
 */

const posDecimal = z.string().regex(/^\d+(\.\d{1,6})?$/, 'must be a non-negative decimal');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'must be an ISO date');

export const createEmployeeInput = z.object({
  number: z.string().min(1),
  name: z.string().min(1),
  email: z.string().optional(),
  nationalId: z.string().optional(),
  principalRef: z.string().optional(),
  startedAt: isoDate.optional(),
});

export const defineLeaveTypeInput = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  kind: z.string().min(1),
  annualDays: posDecimal.optional(),
});

export const employeeIdInput = z.object({ employeeId: z.string().min(1) });

export const employeeFilterInput = z.object({ employeeId: z.string().min(1).optional() });

export const statusFilterInput = z.object({ status: z.string().optional() });

export const instanceIdInput = z.object({ instanceId: z.string().min(1) });

/**
 * Meridian's policy: the spine is read per employee (#890).
 *
 * `entityType` was `z.string().min(1)`, which made `hr/timeline`'s declared
 * `entity: 'employee'` narrower than the input it described — the declaration
 * names one type, the schema accepted any. Every caller passes `'employee'`, so
 * the literal is what was always true, and the conformance kit reads it off this
 * schema rather than being handed it by the fixture.
 *
 * Callout's and Handlebar's timelines went the other way in the same change: they
 * genuinely serve two types, so they declare `entityFrom` and enumerate the pair.
 * One type is a literal; several are an enum; an open string is neither, and is
 * the shape #890 refused to keep.
 */
export const timelineInput = z.object({
  entityType: z.literal('employee'),
  entityId: z.string().min(1),
});

export const accrueInput = z.object({
  employeeId: z.string().min(1),
  leaveTypeKey: z.string().min(1),
  days: posDecimal,
  effectiveDate: isoDate.optional(),
  note: z.string().optional(),
});

export const requestLeaveInput = z.object({
  employeeId: z.string().min(1),
  leaveTypeKey: z.string().min(1),
  startDate: isoDate,
  endDate: isoDate,
  days: posDecimal,
  note: z.string().optional(),
});

export const decideLeaveInput = z.object({
  requestId: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  note: z.string().optional(),
});

export const createProjectInput = z.object({ code: z.string().min(1), name: z.string().min(1) });

export const logTimeInput = z.object({
  employeeId: z.string().min(1),
  projectId: z.string().optional(),
  workDate: isoDate,
  hours: posDecimal,
  note: z.string().optional(),
});

export const submitExpenseInput = z.object({
  employeeId: z.string().min(1),
  description: z.string().min(1),
  amount: posDecimal,
  currency: z.string().regex(/^[A-Z]{3}$/).default('SEK'),
  category: z.string().min(1),
  projectId: z.string().optional(),
});

export const decideExpenseInput = z.object({
  expenseId: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
});

export const payrollExportInput = z.object({ fromDate: isoDate, toDate: isoDate });

export const setTermsInput = z.object({
  employeeId: z.string().min(1),
  roleTitle: z.string().min(1),
  monthlySalary: posDecimal,
  currency: z.string().length(3),
  scopePct: posDecimal,
  startDate: isoDate,
  noticeMonths: posDecimal,
});

export const issueContractInput = z.object({
  templateKey: z.string().min(1),
  employeeId: z.string().min(1),
});

export const startOnboardingInput = z.object({
  templateKey: z.string().min(1),
  employeeId: z.string().min(1),
});