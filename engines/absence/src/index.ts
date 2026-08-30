import { z } from 'zod';
import {
  addDecimal,
  compareDecimal,
  dataSubjectId,
  entityRef,
  listLimitOf,
  moduleManifest,
  operationInputsOf,
  pageOf,
  permissionKey,
  type EntityRef,
  type ListPage,
  type Page,
  substratError,
} from '@substrat-run/contracts';

/**
 * The conflict reasons this engine raises — its own vocabulary, narrowing the platform's
 * `conflict` code (#113). Exported so a vertical can branch on WHY a refusal happened
 * without importing this engine's types or matching on its prose; `as const` so a typo
 * is a compile error here rather than a slug nobody ever matches.
 *
 * Additive only, like every other engine surface: new reasons may appear, existing ones
 * do not change spelling.
 */
export const ABSENCE_CONFLICT_REASONS = [
  'insufficient_balance',
  'leave_type_inactive',
  'wrong_status',
] as const;
export type AbsenceConflictReason = (typeof ABSENCE_CONFLICT_REASONS)[number];

/** `conflict(reason, message)` — reason first, so the classification reads before the prose. */
const conflict = (reason: AbsenceConflictReason, message: string) => substratError('conflict', message, { reason });


// The entity registry is PUBLIC: a vertical composing this engine needs the
// entity-type constants its relation edges name, and the row schema to declare
// an operation's output against without retyping this engine's shape.
export { absenceEntities, leaveTypeRow } from './entities.js';
// The declared surface, and the shapes it names (#896). Re-exported from here so
// a composing vertical imports one module, as it did when these lived inline.
export { ABSENCE_PERMISSIONS, absenceOperations } from './operations.js';
export * from './schemas.js';
import { absenceOperations } from './operations.js';
import { leaveTypeRow } from './entities.js';
import { columnsOf, returns } from './seam.js';
import {
  absenceDay,
  absenceEntry,
  absenceRequest,
  absenceSubject,
  entryKind,
  isoDate,
  leaveType as leaveTypeShape,
  posDecimal,
  requestStatus,
  signedDecimal,
  cancelAbsenceInput,
  configureLeaveTypeInput,
  decideAbsenceInput,
  recordEntryInput,
  requestAbsenceInput,
  type AbsenceDay,
  type AbsenceEntry,
  type AbsenceRequest,
  type AbsenceSubject,
  type CancelAbsenceInput,
  type ConfigureLeaveTypeInput,
  type DecideAbsenceInput,
  type LeaveType,
  type RecordEntryInput,
  type RequestAbsenceInput,
} from './schemas.js';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';

// ============================================================================
// The absence engine (docs/engines/absence.md). Owns an APPEND-ONLY entry
// ledger over an OPAQUE subject ref, balance-as-of-date as a pure fold, a
// per-leave-type balance floor, and the approval state machine that is the only
// mint for 'booking' and 'reversal' entries.
//
// It knows NOTHING about who a subject is (the vertical owns the directory),
// nor about weekends, red days, holiday calendars, accrual formulas, carryover
// caps, or what 'vab' means — all vertical policy. The `days` decimal on a
// request is vertical-computed; the engine folds it, it never derives it.
// Dates are calendar days, INCLUSIVE on both ends (absence is day-shaped) —
// deliberately unlike engine-booking's half-open instants.
// ============================================================================

export const PERM = {
  read: permissionKey.parse('absence:read'),
  request: permissionKey.parse('absence:request'),
  approve: permissionKey.parse('absence:approve'),
  configure: permissionKey.parse('absence:configure'),
};

export const absenceManifest = moduleManifest.parse({
  id: '@substrat-run/engine-absence',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'absence:read', description: 'Read balances, requests, entries and availability' },
    { key: 'absence:request', description: 'Request absence (entity-narrowed: for one subject)' },
    { key: 'absence:approve', description: 'Decide requests; cancel an approved absence' },
    { key: 'absence:configure', description: 'Configure leave types; record accrual/correction/carryover entries' },
  ],
  events: {
    emits: [
      { type: 'absence.leave-type-configured', schemaVersion: 1 },
      { type: 'absence.entry-recorded', schemaVersion: 1 },
      { type: 'absence.requested', schemaVersion: 1 },
      { type: 'absence.decided', schemaVersion: 1 },
      { type: 'absence.cancelled', schemaVersion: 1 },
      { type: 'absence.expired', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [],
  entityRelations: [],
  entitlementKey: 'absence',
  // A request still 'requested' past its start date can no longer be approved —
  // a date-triggered rule (#383): the sweep cancels it under the system actor,
  // never under a manager who never touched it.
  schedules: [
    {
      operation: 'absence/expire-stale',
      cadence: { everyMinutes: 1440 },
      permissions: ['absence:approve'],
    },
  ],
});

export const absenceMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE absence_leave_types (
        key             TEXT PRIMARY KEY,
        floor           TEXT NOT NULL DEFAULT '0',
        active          INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL
      );
      CREATE TABLE absence_ledger (
        id              TEXT PRIMARY KEY,
        subject_type    TEXT NOT NULL,
        subject_id      TEXT NOT NULL,
        data_subject_id TEXT NOT NULL,
        leave_type_key  TEXT NOT NULL,
        entry_kind      TEXT NOT NULL CHECK (entry_kind IN
                          ('accrual','booking','correction','carryover','reversal')),
        delta           TEXT NOT NULL,
        effective_date  TEXT NOT NULL,
        request_id      TEXT,
        note            TEXT,
        created_by      TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE TABLE absence_requests (
        id              TEXT PRIMARY KEY,
        subject_type    TEXT NOT NULL,
        subject_id      TEXT NOT NULL,
        data_subject_id TEXT NOT NULL,
        leave_type_key  TEXT NOT NULL,
        start_date      TEXT NOT NULL,
        end_date        TEXT NOT NULL,
        days            TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN
                          ('requested','approved','rejected','cancelled')),
        note            TEXT,
        decided_by      TEXT,
        decided_at      TEXT,
        created_by      TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
    `,
  },
];

// ---------------------------------------------------------------------------
// Schemas & shapes
// ---------------------------------------------------------------------------

/**
 * The stored shapes. `leave-type` is the one entity, so its row schema comes
 * from the registry; the ledger and the request book are rows this engine owns
 * (entities.ts) and have no registry entry to borrow, so they are declared here.
 *
 * These describe what the migration PROMISED — they are not the published
 * projections. Holding a row to this shape before anything is made of it is what
 * keeps a retyped column from becoming a plausible-looking answer: `active` is
 * read as `=== 1`, and a `delta` is fed to `addDecimal`, both of which accept a
 * drifted value quietly.
 */
type LeaveTypeRow = z.infer<typeof leaveTypeRow>;

const entryRow = z.object({
  id: z.string(),
  subject_type: z.string(),
  subject_id: z.string(),
  data_subject_id: z.string(),
  leave_type_key: z.string(),
  entry_kind: entryKind,
  delta: signedDecimal,
  effective_date: isoDate,
  request_id: z.string().nullable(),
  note: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
});
type EntryRow = z.infer<typeof entryRow>;

const requestRow = z.object({
  id: z.string(),
  subject_type: z.string(),
  subject_id: z.string(),
  data_subject_id: z.string(),
  leave_type_key: z.string(),
  start_date: isoDate,
  end_date: isoDate,
  days: posDecimal,
  status: requestStatus,
  note: z.string().nullable(),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
});
type RequestRow = z.infer<typeof requestRow>;

/**
 * The SELECT lists, derived from the row schemas (#771).
 *
 * Never `SELECT *`: that pins the shape a read returns to whatever the physical
 * table currently holds, which is the same trust-TypeScript hole `returns` closes
 * from the other side. A column dropped from the table is then a SQL error naming
 * it; a column added to the table is simply never read.
 */
/** The single column `balanceAsOf` folds — a projection of `entryRow`, not a table. */
const ledgerDelta = entryRow.pick({ delta: true });

/** `availability`'s computed half, published as one array. */
const absenceDays = z.array(absenceDay);

const LEAVE_TYPE_COLUMNS = columnsOf(leaveTypeRow);
const ENTRY_COLUMNS = columnsOf(entryRow);
const REQUEST_COLUMNS = columnsOf(requestRow);

/** A stored row, parsed BEFORE anything is made of it. */
const storedLeaveType = (r: LeaveTypeRow): LeaveTypeRow =>
  returns(leaveTypeRow, `leave type row ${r.key}`, r);
const storedEntry = (r: EntryRow): EntryRow => returns(entryRow, `ledger row ${r.id}`, r);
const storedRequest = (r: RequestRow): RequestRow =>
  returns(requestRow, `absence request row ${r.id}`, r);

/**
 * A stored row, published (#771).
 *
 * The projection AND the parse in one place, because every path out of this
 * engine that returns an entry, a request or a leave type goes through one of
 * these three — the in-scope reads, the page walks, and each operation binding.
 * `returns` refuses a row that no longer matches the published schema, which is
 * the shape a composing vertical declared its `output` with when it compiled
 * against some earlier version of this engine.
 */
const toEntry = (raw: EntryRow): AbsenceEntry => {
  const r = storedEntry(raw);
  return returns(absenceEntry, `absence entry ${r.id}`, {
    id: r.id,
    subject: { entityType: r.subject_type, entityId: r.subject_id },
    leaveTypeKey: r.leave_type_key,
    entryKind: r.entry_kind,
    delta: r.delta,
    effectiveDate: r.effective_date,
    requestId: r.request_id,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  });
};

const toRequest = (raw: RequestRow): AbsenceRequest => {
  const r = storedRequest(raw);
  return returns(absenceRequest, `absence request ${r.id}`, {
    id: r.id,
    subject: { entityType: r.subject_type, entityId: r.subject_id },
    leaveTypeKey: r.leave_type_key,
    startDate: r.start_date,
    endDate: r.end_date,
    days: r.days,
    status: r.status,
    note: r.note,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
  });
};

const toLeaveType = (raw: LeaveTypeRow): LeaveType => {
  const r = storedLeaveType(raw);
  return returns(leaveTypeShape, `leave type ${r.key}`, {
    key: r.key,
    floor: r.floor,
    active: r.active === 1,
    createdAt: r.created_at,
  });
};

/** Negate a signed decimal string ('5' → '-5', '-5' → '5', '0' → '0'). */
const negate = (d: string): string =>
  compareDecimal(d, '0') === 0 ? '0' : d.startsWith('-') ? d.slice(1) : `-${d}`;

function getRequestRow(ctx: OperationContext, requestId: string): RequestRow {
  const row = ctx.sql.query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM absence_requests WHERE id = ?`,
    [requestId],
  )[0];
  if (!row) throw substratError('not_found', `absence request not found: ${requestId}`);
  return storedRequest(row);
}

function getLeaveTypeRow(ctx: OperationContext, key: string): LeaveTypeRow {
  const row = ctx.sql.query<LeaveTypeRow>(
    `SELECT ${LEAVE_TYPE_COLUMNS} FROM absence_leave_types WHERE key = ?`,
    [key],
  )[0];
  if (!row) throw substratError('not_found', `leave type not found: ${key}`);
  return storedLeaveType(row);
}

function getEntryRow(ctx: OperationContext, id: string): EntryRow {
  const row = ctx.sql.query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM absence_ledger WHERE id = ?`,
    [id],
  )[0];
  // Only ever called with an id this transaction just inserted, so this is a
  // ledger-integrity claim rather than a lookup — but it must stay a CLASSIFIED
  // engine error: `storedEntry` reads `r.id` to name the surface, so a bare `!`
  // would answer an unclassified TypeError that `errorCodeOf` cannot read.
  if (!row) throw substratError('internal', `ledger entry ${id} vanished after insert`);
  return storedEntry(row);
}

const subjectRefOf = (r: { subject_type: string; subject_id: string }): EntityRef => ({
  entityType: r.subject_type,
  entityId: r.subject_id,
});

function insertEntry(
  ctx: OperationContext,
  input: {
    subject: AbsenceSubject;
    leaveTypeKey: string;
    entryKind: EntryRow['entry_kind'];
    delta: string;
    effectiveDate: string;
    requestId?: string;
    note?: string;
  },
): AbsenceEntry {
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO absence_ledger
       (id, subject_type, subject_id, data_subject_id, leave_type_key,
        entry_kind, delta, effective_date, request_id, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.subject.ref.entityType,
      input.subject.ref.entityId,
      input.subject.dataSubjectId,
      input.leaveTypeKey,
      input.entryKind,
      input.delta,
      input.effectiveDate,
      input.requestId ?? null,
      input.note ?? null,
      ctx.principal,
      ctx.now(),
    ],
  );
  const entry = toEntry(getEntryRow(ctx, id));
  ctx.emit({
    type: 'absence.entry-recorded',
    schemaVersion: 1,
    entity: input.subject.ref,
    piiClass: 'pseudonymous',
    subjectId: input.subject.dataSubjectId,
    payload: {
      entryId: id,
      subject: input.subject.ref,
      leaveTypeKey: input.leaveTypeKey,
      entryKind: input.entryKind,
      delta: input.delta,
      effectiveDate: input.effectiveDate,
      requestId: input.requestId ?? null,
    },
  });
  return entry;
}

// ---------------------------------------------------------------------------
// In-scope functions (K-16) — composable from vertical operations, same
// transaction. The registered operations below are their default bindings.
// The CALLER is responsible for the permission check.
// ---------------------------------------------------------------------------

export function configureLeaveType(
  ctx: OperationContext,
  rawInput: ConfigureLeaveTypeInput,
): LeaveType {
  const input = configureLeaveTypeInput.parse(rawInput);
  ctx.sql.exec(
    `INSERT INTO absence_leave_types (key, floor, active, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       floor  = COALESCE(?, floor),
       active = COALESCE(?, active)`,
    [
      input.key,
      input.floor ?? '0',
      input.active === false ? 0 : 1,
      ctx.now(),
      input.floor ?? null,
      input.active === undefined ? null : input.active ? 1 : 0,
    ],
  );
  const row = getLeaveTypeRow(ctx, input.key);
  ctx.emit({
    type: 'absence.leave-type-configured',
    schemaVersion: 1,
    entity: { entityType: 'absence-leave-type', entityId: input.key },
    piiClass: 'none',
    payload: { key: row.key, floor: row.floor, active: row.active === 1 },
  });
  return toLeaveType(row);
}

export function listLeaveTypes(ctx: OperationContext): LeaveType[] {
  return ctx.sql
    .query<LeaveTypeRow>(`SELECT ${LEAVE_TYPE_COLUMNS} FROM absence_leave_types ORDER BY key`)
    .map(toLeaveType);
}

/**
 * The one write that bypasses the request flow, restricted to accrual /
 * correction / carryover — 'booking' and 'reversal' are mintable only through
 * decideAbsence/cancelAbsence, which is what makes "only an approved request
 * touches the ledger" a construction rather than a convention.
 *
 * No floor check here: a correction is the administrator's escape hatch, and
 * accrual/carryover only ever add. The floor guards bookings (D-D).
 */
export function recordEntry(ctx: OperationContext, rawInput: RecordEntryInput): AbsenceEntry {
  const input = recordEntryInput.parse(rawInput);
  getLeaveTypeRow(ctx, input.leaveTypeKey);
  return insertEntry(ctx, input);
}

/** Balance = pure fold over entries with effective_date <= asOf. No counter exists. */
export function balanceAsOf(
  ctx: OperationContext,
  input: { subject: EntityRef; leaveTypeKey: string; asOf?: string },
): string {
  const asOf = input.asOf === undefined ? undefined : isoDate.parse(input.asOf);
  const rows = asOf
    ? ctx.sql.query<{ delta: string }>(
        `SELECT delta FROM absence_ledger
          WHERE subject_type = ? AND subject_id = ? AND leave_type_key = ? AND effective_date <= ?`,
        [input.subject.entityType, input.subject.entityId, input.leaveTypeKey, asOf],
      )
    : ctx.sql.query<{ delta: string }>(
        `SELECT delta FROM absence_ledger
          WHERE subject_type = ? AND subject_id = ? AND leave_type_key = ?`,
        [input.subject.entityType, input.subject.entityId, input.leaveTypeKey],
      );
  // Each summand is parsed, not just the total: `addDecimal` over a drifted
  // `delta` is the one path here that answers a *plausible number* rather than
  // throwing — a balance nobody questions is exactly the wrong-data-on-a-screen
  // failure #771 is about.
  const balance = rows.reduce(
    (sum, r) => addDecimal(sum, returns(ledgerDelta, 'ledger delta', r).delta),
    '0',
  );
  return returns(signedDecimal, `balance of '${input.leaveTypeKey}'`, balance);
}

export function requestAbsence(ctx: OperationContext, rawInput: RequestAbsenceInput): AbsenceRequest {
  const input = requestAbsenceInput.parse(rawInput);
  if (input.endDate < input.startDate) {
    throw substratError('validation_failed', `endDate ${input.endDate} precedes startDate ${input.startDate}`);
  }
  const leaveType = getLeaveTypeRow(ctx, input.leaveTypeKey);
  if (leaveType.active !== 1) {
    throw conflict('leave_type_inactive', `leave type '${input.leaveTypeKey}' is inactive`);
  }
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO absence_requests
       (id, subject_type, subject_id, data_subject_id, leave_type_key,
        start_date, end_date, days, status, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
    [
      id,
      input.subject.ref.entityType,
      input.subject.ref.entityId,
      input.subject.dataSubjectId,
      input.leaveTypeKey,
      input.startDate,
      input.endDate,
      input.days,
      input.note ?? null,
      ctx.principal,
      ctx.now(),
    ],
  );
  ctx.emit({
    type: 'absence.requested',
    schemaVersion: 1,
    entity: input.subject.ref,
    piiClass: 'pseudonymous',
    subjectId: input.subject.dataSubjectId,
    payload: {
      requestId: id,
      subject: input.subject.ref,
      leaveTypeKey: input.leaveTypeKey,
      startDate: input.startDate,
      endDate: input.endDate,
      days: input.days,
    },
  });
  return toRequest(getRequestRow(ctx, id));
}

export function decideAbsence(
  ctx: OperationContext,
  rawInput: DecideAbsenceInput,
): { request: AbsenceRequest; booking: AbsenceEntry | null } {
  const input = decideAbsenceInput.parse(rawInput);
  const req = getRequestRow(ctx, input.requestId);
  // The state machine cannot skip: only a 'requested' absence can be decided.
  if (req.status !== 'requested') {
    throw conflict('wrong_status', `absence request ${req.id} is '${req.status}' — only a requested absence can be decided`);
  }
  const now = ctx.now();
  const subject: AbsenceSubject = {
    ref: subjectRefOf(req),
    dataSubjectId: dataSubjectId.parse(req.data_subject_id),
  };

  if (input.decision === 'reject') {
    ctx.sql.exec(
      `UPDATE absence_requests SET status = 'rejected', decided_by = ?, decided_at = ?, note = COALESCE(?, note) WHERE id = ?`,
      [ctx.principal, now, input.note ?? null, req.id],
    );
    ctx.emit({
      type: 'absence.decided',
      schemaVersion: 1,
      entity: subject.ref,
      piiClass: 'pseudonymous',
      subjectId: subject.dataSubjectId,
      payload: {
        requestId: req.id,
        subject: subject.ref,
        leaveTypeKey: req.leave_type_key,
        decision: 'rejected',
        bookingId: null,
      },
    });
    return { request: toRequest(getRequestRow(ctx, req.id)), booking: null };
  }

  // Approve. Re-fold at decision time — the world may have changed since the
  // request. A booking that would take the fold below the type's floor is
  // rejected by the engine, not the UI (D-D).
  const leaveType = getLeaveTypeRow(ctx, req.leave_type_key);
  const balance = balanceAsOf(ctx, { subject: subject.ref, leaveTypeKey: req.leave_type_key });
  if (compareDecimal(addDecimal(balance, negate(req.days)), leaveType.floor) < 0) {
    throw conflict('insufficient_balance', 
      `insufficient balance: ${balance} day(s) of '${req.leave_type_key}' (floor ${leaveType.floor}), request needs ${req.days}`,
    );
  }
  const booking = insertEntry(ctx, {
    subject,
    leaveTypeKey: req.leave_type_key,
    entryKind: 'booking',
    delta: negate(req.days),
    effectiveDate: req.start_date,
    requestId: req.id,
    note: input.note,
  });
  ctx.sql.exec(
    `UPDATE absence_requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?`,
    [ctx.principal, now, req.id],
  );
  ctx.emit({
    type: 'absence.decided',
    schemaVersion: 1,
    entity: subject.ref,
    piiClass: 'pseudonymous',
    subjectId: subject.dataSubjectId,
    payload: {
      requestId: req.id,
      subject: subject.ref,
      leaveTypeKey: req.leave_type_key,
      decision: 'approved',
      bookingId: booking.id,
      days: req.days,
      startDate: req.start_date,
      endDate: req.end_date,
    },
  });
  return { request: toRequest(getRequestRow(ctx, req.id)), booking };
}

/**
 * requested → cancelled (withdraw; no ledger touch), or approved → cancelled
 * with a COMPENSATING reversal entry — "Hugo came back" is a new entry, never
 * an edit (D-E). Rejected/cancelled rows are terminal.
 */
export function cancelAbsence(
  ctx: OperationContext,
  rawInput: CancelAbsenceInput,
): { request: AbsenceRequest; reversal: AbsenceEntry | null } {
  const input = cancelAbsenceInput.parse(rawInput);
  const req = getRequestRow(ctx, input.requestId);
  if (req.status !== 'requested' && req.status !== 'approved') {
    throw conflict('wrong_status', `absence request ${req.id} is '${req.status}' — only requested or approved can be cancelled`);
  }
  const now = ctx.now();
  const subject: AbsenceSubject = {
    ref: subjectRefOf(req),
    dataSubjectId: dataSubjectId.parse(req.data_subject_id),
  };

  let reversal: AbsenceEntry | null = null;
  if (req.status === 'approved') {
    const bookingRow = ctx.sql.query<EntryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM absence_ledger WHERE request_id = ? AND entry_kind = 'booking'`,
      [req.id],
    )[0];
    if (!bookingRow) throw substratError('internal', `approved request ${req.id} has no booking entry — ledger integrity violated`);
    const booking = storedEntry(bookingRow);
    reversal = insertEntry(ctx, {
      subject,
      leaveTypeKey: req.leave_type_key,
      entryKind: 'reversal',
      delta: negate(booking.delta),
      effectiveDate: booking.effective_date,
      requestId: req.id,
      note: input.reason,
    });
  }
  ctx.sql.exec(
    `UPDATE absence_requests SET status = 'cancelled', decided_at = ?, note = COALESCE(?, note) WHERE id = ?`,
    [now, input.reason ?? null, req.id],
  );
  ctx.emit({
    type: 'absence.cancelled',
    schemaVersion: 1,
    entity: subject.ref,
    piiClass: 'pseudonymous',
    subjectId: subject.dataSubjectId,
    payload: {
      requestId: req.id,
      subject: subject.ref,
      leaveTypeKey: req.leave_type_key,
      priorStatus: req.status,
      reversalId: reversal?.id ?? null,
    },
  });
  return { request: toRequest(getRequestRow(ctx, req.id)), reversal };
}

/**
 * A DATE-TRIGGERED rule with no caller but the passage of time (#383): a
 * request still 'requested' once its start date has passed can no longer be
 * approved, so the platform sweep cancels it — attributed to the schedule
 * (`{ system }`), never to a manager who never touched it. Idempotent (only
 * 'requested' rows past their start) and paged (a bounded batch per pass).
 */
export function expireStaleRequests(ctx: OperationContext): { expired: number } {
  const today = ctx.now().slice(0, 10);
  const stale = ctx.sql
    .query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM absence_requests
       WHERE status = 'requested' AND start_date < ?
       ORDER BY start_date LIMIT 100`,
      [today],
    )
    .map(storedRequest);
  const now = ctx.now();
  for (const req of stale) {
    ctx.sql.exec(
      `UPDATE absence_requests
          SET status = 'cancelled', decided_at = ?,
              note = COALESCE(note, 'auto-expired: start date passed before approval')
        WHERE id = ?`,
      [now, req.id],
    );
    ctx.emit({
      type: 'absence.expired',
      schemaVersion: 1,
      entity: subjectRefOf(req),
      piiClass: 'pseudonymous',
      subjectId: dataSubjectId.parse(req.data_subject_id),
      payload: { requestId: req.id, subject: subjectRefOf(req), startDate: req.start_date },
    });
  }
  return { expired: stale.length };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function listRequests(
  ctx: OperationContext,
  input?: { subject?: EntityRef; status?: RequestRow['status'] },
): AbsenceRequest[] {
  const where: string[] = [];
  const params: string[] = [];
  if (input?.subject) {
    where.push('subject_type = ? AND subject_id = ?');
    params.push(input.subject.entityType, input.subject.entityId);
  }
  if (input?.status) {
    where.push('status = ?');
    params.push(input.status);
  }
  const sql = `SELECT ${REQUEST_COLUMNS} FROM absence_requests${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC`;
  return ctx.sql.query<RequestRow>(sql, params).map(toRequest);
}

export function listEntries(
  ctx: OperationContext,
  input: { subject: EntityRef; leaveTypeKey?: string },
): AbsenceEntry[] {
  const rows = input.leaveTypeKey
    ? ctx.sql.query<EntryRow>(
        `SELECT ${ENTRY_COLUMNS} FROM absence_ledger
          WHERE subject_type = ? AND subject_id = ? AND leave_type_key = ?
          ORDER BY effective_date, id`,
        [input.subject.entityType, input.subject.entityId, input.leaveTypeKey],
      )
    : ctx.sql.query<EntryRow>(
        `SELECT ${ENTRY_COLUMNS} FROM absence_ledger
          WHERE subject_type = ? AND subject_id = ?
          ORDER BY effective_date, id`,
        [input.subject.entityType, input.subject.entityId],
      );
  return rows.map(toEntry);
}

/**
 * Cross-subject window read — the payroll/export composition: "all bookings in
 * this pay period", regardless of subject. In-scope only (no default binding):
 * the callers are vertical exports that hold their own permission gate.
 */
export function entriesInWindow(
  ctx: OperationContext,
  input: { from: string; to: string; entryKind?: EntryRow['entry_kind'] },
): AbsenceEntry[] {
  const from = isoDate.parse(input.from);
  const to = isoDate.parse(input.to);
  const rows = input.entryKind
    ? ctx.sql.query<EntryRow>(
        `SELECT ${ENTRY_COLUMNS} FROM absence_ledger
          WHERE effective_date >= ? AND effective_date <= ? AND entry_kind = ?
          ORDER BY subject_id, effective_date, id`,
        [from, to, input.entryKind],
      )
    : ctx.sql.query<EntryRow>(
        `SELECT ${ENTRY_COLUMNS} FROM absence_ledger
          WHERE effective_date >= ? AND effective_date <= ?
          ORDER BY subject_id, effective_date, id`,
        [from, to],
      );
  return rows.map(toEntry);
}

/** Walk YYYY-MM-DD dates inclusively without timezone drift (UTC arithmetic). */
function* eachDate(from: string, to: string): Generator<string> {
  const end = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  );
  let cur = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  while (cur <= end) {
    yield new Date(cur).toISOString().slice(0, 10);
    cur += 86_400_000;
  }
}

/**
 * The planner's read (D-C): every calendar day in an APPROVED request's
 * inclusive range, clamped to [from, to]. The verdict is "an approved absence
 * covers this date" — the engine does not know weekends or red days; the
 * vertical composes this with its own holiday calendar.
 */
export function availability(
  ctx: OperationContext,
  input: { subject: EntityRef; from: string; to: string },
): { days: AbsenceDay[]; requests: AbsenceRequest[] } {
  const from = isoDate.parse(input.from);
  const to = isoDate.parse(input.to);
  if (to < from) throw substratError('validation_failed', `to ${to} precedes from ${from}`);
  const rows = ctx.sql
    .query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM absence_requests
       WHERE subject_type = ? AND subject_id = ? AND status = 'approved'
         AND start_date <= ? AND end_date >= ?
       ORDER BY start_date, id`,
      [input.subject.entityType, input.subject.entityId, to, from],
    )
    .map(storedRequest);
  const days: AbsenceDay[] = [];
  for (const req of rows) {
    const start = req.start_date < from ? from : req.start_date;
    const end = req.end_date > to ? to : req.end_date;
    for (const date of eachDate(start, end)) {
      days.push({ date, leaveTypeKey: req.leave_type_key, requestId: req.id });
    }
  }
  // The days are COMPUTED rather than stored, so nothing else parses them: the
  // walk is driven by two stored dates, and a drifted one would answer a
  // plausible calendar. The requests are each parsed by `toRequest`.
  return {
    days: returns(absenceDays, `availability of ${input.subject.entityId}`, days),
    requests: rows.map(toRequest),
  };
}

// ---------------------------------------------------------------------------
// Default operation bindings — each starts with the permission check.
// ---------------------------------------------------------------------------

/**
 * Take a page off a fold (#811).
 *
 * None of this engine's three list reads is kernel-composed, and the reason is
 * structural rather than a shortcut: `absenceEntities` declares exactly one
 * entity, `leave-type`. The ledger and the request book are ROWS this engine
 * owns — an accrual is not something a grant narrows to — so `paged.over` has
 * nothing to name for them, and the leave-type read answers the PROJECTION
 * (`active` as a boolean) rather than the stored row. So the read runs and the
 * page is taken off it, exactly as rally's folds do.
 *
 * `key` must be UNIQUE among the rows and must move in the direction they are
 * sorted; each declaration in `operations.ts` says which field that is.
 */
function pageOverFold<T>(
  rows: T[],
  page: ListPage,
  key: (row: T) => string,
  direction: 'asc' | 'desc' = 'asc',
): Page<T> {
  const limit = listLimitOf(page.limit);
  const cursor = page.cursor;
  const past = (row: T) => (direction === 'asc' ? key(row) > cursor! : key(row) < cursor!);
  const after =
    cursor === undefined
      ? 0
      : (() => {
          const i = rows.findIndex(past);
          return i < 0 ? rows.length : i;
        })();
  return pageOf(rows.slice(after, after + limit), limit, key);
}

const configureLeaveTypeOp: OperationHandler<ConfigureLeaveTypeInput, LeaveType> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(PERM.configure));
  return configureLeaveType(ctx, input);
};

const listLeaveTypesOp: OperationHandler<ListPage | undefined, Page<LeaveType>> = async (
  ctx,
  page,
) => {
  assertAllowed(await ctx.check(PERM.read));
  // `key` is the primary key, so it is both the declared order and a unique cursor.
  return pageOverFold(listLeaveTypes(ctx), page ?? {}, (t) => t.key);
};

const recordEntryOp: OperationHandler<RecordEntryInput, AbsenceEntry> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.configure));
  return recordEntry(ctx, input);
};

const requestOp: OperationHandler<RequestAbsenceInput, AbsenceRequest> = async (ctx, raw) => {
  const input = requestAbsenceInput.parse(raw);
  // Entity-narrowed: a subject requests for THEMSELVES through a grant on their
  // own ref, holding no role; an unnarrowed holder may request for anyone.
  assertAllowed(await ctx.check(PERM.request, input.subject.ref));
  return requestAbsence(ctx, input);
};

const decideOp: OperationHandler<
  DecideAbsenceInput,
  { request: AbsenceRequest; booking: AbsenceEntry | null }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.approve));
  return decideAbsence(ctx, input);
};

const cancelOp: OperationHandler<
  CancelAbsenceInput,
  { request: AbsenceRequest; reversal: AbsenceEntry | null }
> = async (ctx, raw) => {
  const input = cancelAbsenceInput.parse(raw);
  // An approver cancels anything cancellable; the subject may WITHDRAW their
  // own still-requested row through the same entity-narrowed grant they
  // requested with.
  const asApprover = await ctx.check(PERM.approve);
  if (!asApprover.allowed) {
    const req = getRequestRow(ctx, input.requestId);
    if (req.status !== 'requested') assertAllowed(asApprover);
    assertAllowed(await ctx.check(PERM.request, subjectRefOf(req)));
  }
  return cancelAbsence(ctx, input);
};

const expireStaleOp: OperationHandler<undefined, { expired: number }> = async (ctx) => {
  assertAllowed(await ctx.check(PERM.approve));
  return expireStaleRequests(ctx);
};

const balanceOp: OperationHandler<
  { subject: EntityRef; leaveTypeKey: string; asOf?: string },
  { balance: string }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.read, entityRef.parse(input.subject)));
  return { balance: balanceAsOf(ctx, input) };
};

const availabilityOp: OperationHandler<
  { subject: EntityRef; from: string; to: string },
  { days: AbsenceDay[]; requests: AbsenceRequest[] }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.read, entityRef.parse(input.subject)));
  return availability(ctx, input);
};

const listRequestsOp: OperationHandler<
  ({ subject?: EntityRef; status?: RequestRow['status'] } & ListPage) | undefined,
  Page<AbsenceRequest>
> = async (ctx, input) => {
  // The conditional narrow. Declared as a node check (see `operations.ts`),
  // because `refFrom` on an optional field would claim a narrowing that a caller
  // omitting `subject` never gets.
  if (input?.subject) {
    assertAllowed(await ctx.check(PERM.read, entityRef.parse(input.subject)));
  } else {
    assertAllowed(await ctx.check(PERM.read));
  }
  // Newest first, so the walk descends. The id is a ULID: unique, and ordered the
  // same way `created_at` is.
  return pageOverFold(listRequests(ctx, input), input ?? {}, (r) => r.id, 'desc');
};

const listEntriesOp: OperationHandler<
  { subject: EntityRef; leaveTypeKey?: string } & ListPage,
  Page<AbsenceEntry>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.read, entityRef.parse(input.subject)));
  // `effectiveDate` is the order and is NOT unique — it is caller-supplied, so an
  // accrual dated last year may be written today. The cursor is the
  // (effectiveDate, id) pair the SQL already orders by; `\u0000` separates them
  // because it cannot occur in either half.
  return pageOverFold(
    listEntries(ctx, input),
    input,
    (e) => `${e.effectiveDate}\u0000${e.id}`,
  );
};

export const absenceModule: ModuleRegistration = {
  manifest: absenceManifest,
  migrations: absenceMigrations,
  // The host parses every invocation against the same declaration the manifest
  // and the routes come from, so "parse, don't trust" holds on every path in
  // rather than in the handlers that remembered (#953).
  operationInputs: operationInputsOf(absenceOperations),
  operations: {
    'absence/configure-leave-type': configureLeaveTypeOp as OperationHandler<never, unknown>,
    'absence/list-leave-types': listLeaveTypesOp as OperationHandler<never, unknown>,
    'absence/record-entry': recordEntryOp as OperationHandler<never, unknown>,
    'absence/request': requestOp as OperationHandler<never, unknown>,
    'absence/decide': decideOp as OperationHandler<never, unknown>,
    'absence/cancel': cancelOp as OperationHandler<never, unknown>,
    'absence/expire-stale': expireStaleOp as OperationHandler<never, unknown>,
    'absence/balance': balanceOp as OperationHandler<never, unknown>,
    'absence/availability': availabilityOp as OperationHandler<never, unknown>,
    'absence/list-requests': listRequestsOp as OperationHandler<never, unknown>,
    'absence/list-entries': listEntriesOp as OperationHandler<never, unknown>,
  },
};
