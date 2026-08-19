import { z } from 'zod';
import {
  addDecimal,
  compareDecimal,
  dataSubjectId,
  entityRef,
  moduleManifest,
  permissionKey,
  type EntityRef,
  substratError,
} from '@substrat-run/contracts';

// The entity registry is PUBLIC: a vertical composing this engine needs the
// entity-type constants its relation edges name, and the row schema to declare
// an operation's output against without retyping this engine's shape.
export { absenceEntities, leaveTypeRow } from './entities.js';
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

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const posDecimal = z.string().regex(/^\d+(\.\d{1,6})?$/, 'must be a non-negative decimal');
const signedDecimal = z.string().regex(/^-?\d+(\.\d{1,6})?$/, 'must be a decimal');

/** Every write names its subject: the vertical's opaque noun + the erasure key. */
export const absenceSubject = z.object({
  ref: entityRef,
  dataSubjectId,
});
export type AbsenceSubject = z.infer<typeof absenceSubject>;

export interface LeaveType {
  key: string;
  floor: string;
  active: boolean;
  createdAt: string;
}

interface LeaveTypeRow {
  key: string;
  floor: string;
  active: number;
  created_at: string;
}

interface EntryRow {
  id: string;
  subject_type: string;
  subject_id: string;
  data_subject_id: string;
  leave_type_key: string;
  entry_kind: 'accrual' | 'booking' | 'correction' | 'carryover' | 'reversal';
  delta: string;
  effective_date: string;
  request_id: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
}

export interface AbsenceEntry {
  id: string;
  subject: EntityRef;
  leaveTypeKey: string;
  entryKind: EntryRow['entry_kind'];
  delta: string;
  effectiveDate: string;
  requestId: string | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

interface RequestRow {
  id: string;
  subject_type: string;
  subject_id: string;
  data_subject_id: string;
  leave_type_key: string;
  start_date: string;
  end_date: string;
  days: string;
  status: 'requested' | 'approved' | 'rejected' | 'cancelled';
  note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_by: string;
  created_at: string;
}

export interface AbsenceRequest {
  id: string;
  subject: EntityRef;
  leaveTypeKey: string;
  startDate: string;
  endDate: string;
  days: string;
  status: RequestRow['status'];
  note: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdBy: string;
  createdAt: string;
}

const toEntry = (r: EntryRow): AbsenceEntry => ({
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

const toRequest = (r: RequestRow): AbsenceRequest => ({
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

const toLeaveType = (r: LeaveTypeRow): LeaveType => ({
  key: r.key,
  floor: r.floor,
  active: r.active === 1,
  createdAt: r.created_at,
});

/** Negate a signed decimal string ('5' → '-5', '-5' → '5', '0' → '0'). */
const negate = (d: string): string =>
  compareDecimal(d, '0') === 0 ? '0' : d.startsWith('-') ? d.slice(1) : `-${d}`;

function getRequestRow(ctx: OperationContext, requestId: string): RequestRow {
  const row = ctx.sql.query<RequestRow>('SELECT * FROM absence_requests WHERE id = ?', [
    requestId,
  ])[0];
  if (!row) throw substratError('not_found', `absence request not found: ${requestId}`);
  return row;
}

function getLeaveTypeRow(ctx: OperationContext, key: string): LeaveTypeRow {
  const row = ctx.sql.query<LeaveTypeRow>('SELECT * FROM absence_leave_types WHERE key = ?', [
    key,
  ])[0];
  if (!row) throw substratError('not_found', `leave type not found: ${key}`);
  return row;
}

function getEntryRow(ctx: OperationContext, id: string): EntryRow {
  return ctx.sql.query<EntryRow>('SELECT * FROM absence_ledger WHERE id = ?', [id])[0]!;
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
      new Date().toISOString(),
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

export const configureLeaveTypeInput = z.object({
  key: z.string().min(1),
  floor: signedDecimal.optional(),
  active: z.boolean().optional(),
});
export type ConfigureLeaveTypeInput = z.infer<typeof configureLeaveTypeInput>;

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
      new Date().toISOString(),
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
    .query<LeaveTypeRow>('SELECT * FROM absence_leave_types ORDER BY key')
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
export const recordEntryInput = z.object({
  subject: absenceSubject,
  leaveTypeKey: z.string().min(1),
  entryKind: z.enum(['accrual', 'correction', 'carryover']),
  delta: signedDecimal,
  effectiveDate: isoDate,
  note: z.string().optional(),
});
export type RecordEntryInput = z.infer<typeof recordEntryInput>;

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
  return rows.reduce((sum, r) => addDecimal(sum, r.delta), '0');
}

export const requestAbsenceInput = z.object({
  subject: absenceSubject,
  leaveTypeKey: z.string().min(1),
  startDate: isoDate,
  endDate: isoDate,
  days: posDecimal.refine((d) => compareDecimal(d, '0') > 0, 'days must be positive'),
  note: z.string().optional(),
});
export type RequestAbsenceInput = z.infer<typeof requestAbsenceInput>;

export function requestAbsence(ctx: OperationContext, rawInput: RequestAbsenceInput): AbsenceRequest {
  const input = requestAbsenceInput.parse(rawInput);
  if (input.endDate < input.startDate) {
    throw substratError('validation_failed', `endDate ${input.endDate} precedes startDate ${input.startDate}`);
  }
  const leaveType = getLeaveTypeRow(ctx, input.leaveTypeKey);
  if (leaveType.active !== 1) {
    throw substratError('conflict', `leave type '${input.leaveTypeKey}' is inactive`);
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
      new Date().toISOString(),
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

export const decideAbsenceInput = z.object({
  requestId: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  note: z.string().optional(),
});
export type DecideAbsenceInput = z.infer<typeof decideAbsenceInput>;

export function decideAbsence(
  ctx: OperationContext,
  rawInput: DecideAbsenceInput,
): { request: AbsenceRequest; booking: AbsenceEntry | null } {
  const input = decideAbsenceInput.parse(rawInput);
  const req = getRequestRow(ctx, input.requestId);
  // The state machine cannot skip: only a 'requested' absence can be decided.
  if (req.status !== 'requested') {
    throw substratError('conflict', `absence request ${req.id} is '${req.status}' — only a requested absence can be decided`);
  }
  const now = new Date().toISOString();
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
    throw substratError('conflict', 
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
export const cancelAbsenceInput = z.object({
  requestId: z.string().min(1),
  reason: z.string().optional(),
});
export type CancelAbsenceInput = z.infer<typeof cancelAbsenceInput>;

export function cancelAbsence(
  ctx: OperationContext,
  rawInput: CancelAbsenceInput,
): { request: AbsenceRequest; reversal: AbsenceEntry | null } {
  const input = cancelAbsenceInput.parse(rawInput);
  const req = getRequestRow(ctx, input.requestId);
  if (req.status !== 'requested' && req.status !== 'approved') {
    throw substratError('conflict', `absence request ${req.id} is '${req.status}' — only requested or approved can be cancelled`);
  }
  const now = new Date().toISOString();
  const subject: AbsenceSubject = {
    ref: subjectRefOf(req),
    dataSubjectId: dataSubjectId.parse(req.data_subject_id),
  };

  let reversal: AbsenceEntry | null = null;
  if (req.status === 'approved') {
    const booking = ctx.sql.query<EntryRow>(
      `SELECT * FROM absence_ledger WHERE request_id = ? AND entry_kind = 'booking'`,
      [req.id],
    )[0];
    if (!booking) throw substratError('internal', `approved request ${req.id} has no booking entry — ledger integrity violated`);
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
  const today = new Date().toISOString().slice(0, 10);
  const stale = ctx.sql.query<RequestRow>(
    `SELECT * FROM absence_requests
       WHERE status = 'requested' AND start_date < ?
       ORDER BY start_date LIMIT 100`,
    [today],
  );
  const now = new Date().toISOString();
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
  const sql = `SELECT * FROM absence_requests${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC`;
  return ctx.sql.query<RequestRow>(sql, params).map(toRequest);
}

export function listEntries(
  ctx: OperationContext,
  input: { subject: EntityRef; leaveTypeKey?: string },
): AbsenceEntry[] {
  const rows = input.leaveTypeKey
    ? ctx.sql.query<EntryRow>(
        `SELECT * FROM absence_ledger
          WHERE subject_type = ? AND subject_id = ? AND leave_type_key = ?
          ORDER BY effective_date, id`,
        [input.subject.entityType, input.subject.entityId, input.leaveTypeKey],
      )
    : ctx.sql.query<EntryRow>(
        `SELECT * FROM absence_ledger
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
        `SELECT * FROM absence_ledger
          WHERE effective_date >= ? AND effective_date <= ? AND entry_kind = ?
          ORDER BY subject_id, effective_date, id`,
        [from, to, input.entryKind],
      )
    : ctx.sql.query<EntryRow>(
        `SELECT * FROM absence_ledger
          WHERE effective_date >= ? AND effective_date <= ?
          ORDER BY subject_id, effective_date, id`,
        [from, to],
      );
  return rows.map(toEntry);
}

export interface AbsenceDay {
  date: string;
  leaveTypeKey: string;
  requestId: string;
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
  const rows = ctx.sql.query<RequestRow>(
    `SELECT * FROM absence_requests
       WHERE subject_type = ? AND subject_id = ? AND status = 'approved'
         AND start_date <= ? AND end_date >= ?
       ORDER BY start_date, id`,
    [input.subject.entityType, input.subject.entityId, to, from],
  );
  const days: AbsenceDay[] = [];
  for (const req of rows) {
    const start = req.start_date < from ? from : req.start_date;
    const end = req.end_date > to ? to : req.end_date;
    for (const date of eachDate(start, end)) {
      days.push({ date, leaveTypeKey: req.leave_type_key, requestId: req.id });
    }
  }
  return { days, requests: rows.map(toRequest) };
}

// ---------------------------------------------------------------------------
// Default operation bindings — each starts with the permission check.
// ---------------------------------------------------------------------------

const configureLeaveTypeOp: OperationHandler<ConfigureLeaveTypeInput, LeaveType> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(PERM.configure));
  return configureLeaveType(ctx, input);
};

const listLeaveTypesOp: OperationHandler<undefined, LeaveType[]> = async (ctx) => {
  assertAllowed(await ctx.check(PERM.read));
  return listLeaveTypes(ctx);
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
  { subject?: EntityRef; status?: RequestRow['status'] } | undefined,
  AbsenceRequest[]
> = async (ctx, input) => {
  if (input?.subject) {
    assertAllowed(await ctx.check(PERM.read, entityRef.parse(input.subject)));
  } else {
    assertAllowed(await ctx.check(PERM.read));
  }
  return listRequests(ctx, input);
};

const listEntriesOp: OperationHandler<
  { subject: EntityRef; leaveTypeKey?: string },
  AbsenceEntry[]
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.read, entityRef.parse(input.subject)));
  return listEntries(ctx, input);
};

export const absenceModule: ModuleRegistration = {
  manifest: absenceManifest,
  migrations: absenceMigrations,
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
