import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dataSubjectId, errorCodeOf, type Page } from '@substrat-run/contracts';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  PERM,
  absenceModule,
  availability,
  balanceAsOf,
  configureLeaveType,
  decideAbsence,
  entriesInWindow,
  listEntries,
  listLeaveTypes,
  listRequests,
  recordEntry,
  requestAbsence,
  type AbsenceEntry,
  type AbsenceRequest,
  type AbsenceSubject,
  type LeaveType,
} from '../src/index.js';
import { columnsOf } from '../src/seam.js';
import { leaveTypeRow } from '../src/entities.js';

/**
 * The seam, under drift (#771) — engine-absence' copy of workorder's suite.
 *
 * Every test here answers one question: when the stored row stops matching the
 * shape this engine PUBLISHES, does the caller get a throw or wrong data? Before
 * this, the answer was wrong data — the return values crossed the seam typed by a
 * TypeScript assertion that is not there at runtime, and `SELECT *` pinned the
 * published shape to whatever the physical table happened to hold.
 *
 * The drift is simulated the only honest way available: by moving the table under
 * a running engine, which is what a vertical compiled against 0.3 and running
 * against 0.4 is actually looking at.
 */

const subj: AbsenceSubject = {
  ref: { entityType: 'employee', entityId: 'emp-1' },
  dataSubjectId: dataSubjectId.parse(`01JABSENCE${'A'.repeat(15)}1`),
};

const ALL = [PERM.read, PERM.request, PERM.approve, PERM.configure];

describe('engine-absence — the seam is parsed, not asserted', () => {
  let h: EngineHarness;
  let staff: Awaited<ReturnType<EngineHarness['as']>>;

  beforeEach(async () => {
    h = await engineHarness({ modules: [absenceModule] });
    staff = await h.as(ALL);
    await h.run((ctx) => {
      configureLeaveType(ctx, { key: 'vacation' });
      recordEntry(ctx, {
        subject: subj,
        leaveTypeKey: 'vacation',
        entryKind: 'accrual',
        delta: '25',
        effectiveDate: '2026-01-01',
      });
    }, ALL);
  });
  afterEach(async () => {
    await h.close();
  });

  const request = (startDate = '2026-07-01', endDate = '2026-07-03', days = '3') =>
    h.run(
      (ctx) =>
        requestAbsence(ctx, { subject: subj, leaveTypeKey: 'vacation', startDate, endDate, days }),
      ALL,
    );

  const approve = (requestId: string) =>
    h.run((ctx) => decideAbsence(ctx, { requestId, decision: 'approve' }), ALL);

  /** Move the table under the engine, the way a version bump would. */
  const drift = (sql: string) => h.run((ctx) => void ctx.sql.exec(sql), ALL);

  // -- the SELECT list is derived from the row schema ---------------------------

  it('names the columns a row schema describes, in its order', () => {
    expect(columnsOf(leaveTypeRow)).toBe('key, floor, active, created_at');
  });

  it('a column that vanished fails AT THE READ, naming itself', async () => {
    const r = await request();
    // The published shape still says `note`; the table no longer does.
    await drift('ALTER TABLE absence_requests DROP COLUMN note');

    // `SELECT *` would have returned a row quietly missing the field. Naming the
    // columns makes the read itself refuse, and say which column it wanted.
    await expect(h.run((ctx) => listRequests(ctx), ALL)).rejects.toThrow(/no such column: note/);
    await expect(h.run((ctx) => availability(ctx, { subject: subj.ref, from: '2026-07-01', to: '2026-07-31' }), ALL))
      .rejects.toThrow(/no such column: note/);
    expect(r.status).toBe('requested');
  });

  it('a column added upstream never crosses the seam', async () => {
    await drift('ALTER TABLE absence_leave_types ADD COLUMN internal_quota TEXT');
    await h.run((ctx) => void configureLeaveType(ctx, { key: 'parental' }), ALL);
    await drift(`UPDATE absence_leave_types SET internal_quota = '7'`);

    const listed = await h.run((ctx) => listLeaveTypes(ctx), ALL);
    const paged = await staff.invoke<Page<LeaveType>>('absence/list-leave-types');
    for (const row of [...listed, ...paged.entries]) {
      expect(Object.keys(row)).toEqual(['key', 'floor', 'active', 'createdAt']);
      expect(row).not.toHaveProperty('internal_quota');
    }
  });

  // -- a drifted row throws instead of surfacing as wrong data ------------------

  it('a request whose row drifted throws at the seam', async () => {
    const r = await request();
    // `days` is a positive decimal in the published shape. Free text there is
    // exactly the retype an additive-only rule forbids and nothing enforced.
    await drift(`UPDATE absence_requests SET days = 'tre dagar'`);

    await expect(h.run((ctx) => listRequests(ctx), ALL)).rejects.toThrow(
      /does not match the shape this engine publishes.*days/s,
    );
    await expect(staff.invoke('absence/list-requests')).rejects.toThrow(
      /does not match the shape this engine publishes/,
    );
    expect(r.days).toBe('3');
  });

  it('a retyped `active` is caught BEFORE it is normalised to a boolean', async () => {
    // `active` is 0/1 and `toLeaveType` reads it with `=== 1`. A text value would
    // not fail the published parse — it would quietly publish every leave type as
    // inactive and refuse every request against it as `leave_type_inactive`.
    // (`'1'` would be coerced back by SQLite's column affinity, so the drift has
    // to be non-numeric.)
    await drift(`UPDATE absence_leave_types SET active = 'yes'`);

    await expect(h.run((ctx) => listLeaveTypes(ctx), ALL)).rejects.toThrow(
      /leave type row .* does not match the shape this engine publishes.*active/s,
    );
    await expect(request()).rejects.toThrow(
      /does not match the shape this engine publishes.*active/s,
    );
  });

  it('a drifted `delta` refuses the fold rather than answering a plausible balance', async () => {
    // The balance is a sum, so a drifted summand crosses as a NUMBER nobody
    // questions — the wrong-data-on-a-screen failure in its purest form.
    await drift(`UPDATE absence_ledger SET delta = '25 dagar'`);

    await expect(
      h.run((ctx) => balanceAsOf(ctx, { subject: subj.ref, leaveTypeKey: 'vacation' }), ALL),
    ).rejects.toThrow(/does not match the shape this engine publishes.*delta/s);
    await expect(
      staff.invoke('absence/balance', { subject: subj.ref, leaveTypeKey: 'vacation' }),
    ).rejects.toThrow(/does not match the shape this engine publishes/);
  });

  it('the page walk parses every entry it publishes, not just the first read', async () => {
    await h.run(
      (ctx) =>
        void recordEntry(ctx, {
          subject: subj,
          leaveTypeKey: 'vacation',
          entryKind: 'correction',
          delta: '-1',
          effectiveDate: '2026-02-01',
        }),
      ALL,
    );
    // A day that is still ordered inside every window this engine queries, and
    // is not the YYYY-MM-DD the published shape promises.
    await drift(`UPDATE absence_ledger SET effective_date = '2026-02-1' WHERE delta = '-1'`);

    // Wrong data on page one is the failure this closes: the entry rendered fine
    // and its date was a string nothing declared.
    await expect(
      staff.invoke<Page<AbsenceEntry>>('absence/list-entries', { subject: subj.ref }),
    ).rejects.toThrow(/does not match the shape this engine publishes.*effective_date/s);
    await expect(h.run((ctx) => listEntries(ctx, { subject: subj.ref }), ALL)).rejects.toThrow(
      /does not match the shape this engine publishes/,
    );
    // The cross-subject window read is the payroll composition, and refuses too.
    await expect(
      h.run((ctx) => entriesInWindow(ctx, { from: '2026-01-01', to: '2026-12-31' }), ALL),
    ).rejects.toThrow(/does not match the shape this engine publishes/);
  });

  it('the computed availability walk is published through the same seam', async () => {
    const r = await request();
    await approve(r.id);
    // `start_date` drives the day walk. A drifted one would answer a plausible
    // calendar — days computed from a date the schema never promised. It still
    // sorts inside the queried window, so the row is read and then refused.
    await drift(`UPDATE absence_requests SET start_date = '2026-07-1' WHERE id = '${r.id}'`);

    await expect(
      h.run(
        (ctx) => availability(ctx, { subject: subj.ref, from: '2026-07-01', to: '2026-07-31' }),
        ALL,
      ),
    ).rejects.toThrow(/does not match the shape this engine publishes.*start_date/s);
  });

  it('blames the engine, not the caller: a drifted row is `internal`', async () => {
    await request();
    await drift(`UPDATE absence_requests SET days = 'tre dagar'`);

    // The caller's input was already parsed and is not what went wrong, so this
    // must not answer 400 `validation_failed` — that is a lie a client acts on.
    const err = await h
      .run((ctx) => listRequests(ctx) as unknown as AbsenceRequest[], ALL)
      .catch((e: unknown) => e);
    expect(errorCodeOf(err)).toBe('internal');
  });
});
