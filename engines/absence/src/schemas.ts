import { compareDecimal, dataSubjectId, entityRef, z } from '@substrat-run/contracts';

/**
 * engine-absence' schemas — what it ACCEPTS and what it ANSWERS (#707/#896).
 *
 * The inputs were exported from `index.ts` beside the in-scope functions that
 * parse them; the published projections were three hand-written
 * `export interface`s. Both moved here because `defineOperations` declares an
 * operation's `input` and `output` as schemas and a TypeScript interface cannot
 * be one — the alternative is a zod schema next to each interface saying the same
 * thing twice, which is the two-descriptions defect the model exists to delete.
 *
 * Own file rather than inside `operations.ts`, for the reason `entities.ts` is
 * one: `index.ts` needs these too, and a declaration file importing the
 * implementation is a cycle. Nothing here imports `index.ts`.
 *
 * Row versus published, the distinction `entities.ts` already draws: a
 * `LeaveTypeRow` stores `active` as 0/1 because SQLite has no boolean, and the
 * ledger stores a subject as `subject_type` / `subject_id`. What is ANSWERED is
 * `active: boolean` and one `EntityRef` — `toLeaveType` / `toEntry` / `toRequest`
 * in `index.ts` are the one crossing.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
export const posDecimal = z.string().regex(/^\d+(\.\d{1,6})?$/, 'must be a non-negative decimal');
export const signedDecimal = z.string().regex(/^-?\d+(\.\d{1,6})?$/, 'must be a decimal');

/**
 * Every write names its subject: the vertical's opaque noun + the erasure key.
 *
 * The `ref` here is what #896 is about. Its `entityType` is the VERTICAL's —
 * Meridian passes `employee` — and this engine has no name for it, cannot declare
 * one, and is built not to know: *"It knows NOTHING about who a subject is (the
 * vertical owns the directory)."* An operation narrowing to it declares
 * `refFrom` and points at the field, because the field carries the type.
 */
export const absenceSubject = z.object({
  ref: entityRef,
  dataSubjectId,
});
export type AbsenceSubject = z.infer<typeof absenceSubject>;

// ---------------------------------------------------------------------------
// What it answers
// ---------------------------------------------------------------------------

export const leaveType = z.object({
  key: z.string(),
  floor: z.string(),
  active: z.boolean(),
  createdAt: z.string(),
});
export type LeaveType = z.infer<typeof leaveType>;

export const entryKind = z.enum(['accrual', 'booking', 'correction', 'carryover', 'reversal']);

export const absenceEntry = z.object({
  id: z.string(),
  subject: entityRef,
  leaveTypeKey: z.string(),
  entryKind,
  delta: z.string(),
  effectiveDate: z.string(),
  requestId: z.string().nullable(),
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type AbsenceEntry = z.infer<typeof absenceEntry>;

export const requestStatus = z.enum(['requested', 'approved', 'rejected', 'cancelled']);

export const absenceRequest = z.object({
  id: z.string(),
  subject: entityRef,
  leaveTypeKey: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  days: z.string(),
  status: requestStatus,
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type AbsenceRequest = z.infer<typeof absenceRequest>;

/** One calendar day an approved request covers (D-C). */
export const absenceDay = z.object({
  date: z.string(),
  leaveTypeKey: z.string(),
  requestId: z.string(),
});
export type AbsenceDay = z.infer<typeof absenceDay>;

export const balanceAnswer = z.object({ balance: z.string() });
export const decideAnswer = z.object({
  request: absenceRequest,
  booking: absenceEntry.nullable(),
});
export const cancelAnswer = z.object({
  request: absenceRequest,
  reversal: absenceEntry.nullable(),
});
export const availabilityAnswer = z.object({
  days: z.array(absenceDay),
  requests: z.array(absenceRequest),
});
export const expiredAnswer = z.object({ expired: z.number() });

// ---------------------------------------------------------------------------
// What it accepts
// ---------------------------------------------------------------------------

export const configureLeaveTypeInput = z.object({
  key: z.string().min(1),
  floor: signedDecimal.optional(),
  active: z.boolean().optional(),
});
export type ConfigureLeaveTypeInput = z.infer<typeof configureLeaveTypeInput>;

export const recordEntryInput = z.object({
  subject: absenceSubject,
  leaveTypeKey: z.string().min(1),
  entryKind: z.enum(['accrual', 'correction', 'carryover']),
  delta: signedDecimal,
  effectiveDate: isoDate,
  note: z.string().optional(),
});
export type RecordEntryInput = z.infer<typeof recordEntryInput>;

export const requestAbsenceInput = z.object({
  subject: absenceSubject,
  leaveTypeKey: z.string().min(1),
  startDate: isoDate,
  endDate: isoDate,
  days: posDecimal.refine((d) => compareDecimal(d, '0') > 0, 'days must be positive'),
  note: z.string().optional(),
});
export type RequestAbsenceInput = z.infer<typeof requestAbsenceInput>;

export const decideAbsenceInput = z.object({
  requestId: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  note: z.string().optional(),
});
export type DecideAbsenceInput = z.infer<typeof decideAbsenceInput>;

export const cancelAbsenceInput = z.object({
  requestId: z.string().min(1),
  reason: z.string().optional(),
});
export type CancelAbsenceInput = z.infer<typeof cancelAbsenceInput>;

/** The reads. Each carries the subject WHOLE, which is what `refFrom` names. */
export const balanceInput = z.object({
  subject: entityRef,
  leaveTypeKey: z.string().min(1),
  asOf: isoDate.optional(),
});

export const availabilityInput = z.object({
  subject: entityRef,
  from: isoDate,
  to: isoDate,
});

export const listEntriesInput = z.object({
  subject: entityRef,
  leaveTypeKey: z.string().min(1).optional(),
});

/**
 * `subject` is OPTIONAL here, and that is why this read declares a node check
 * rather than a narrowed one — see the note in `operations.ts`.
 */
export const listRequestsInput = z.object({
  subject: entityRef.optional(),
  status: requestStatus.optional(),
});
