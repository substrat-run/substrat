import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dataSubjectId } from '@substrat-run/contracts';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  PERM,
  absenceModule,
  availability,
  balanceAsOf,
  cancelAbsence,
  configureLeaveType,
  decideAbsence,
  expireStaleRequests,
  listEntries,
  listRequests,
  recordEntry,
  requestAbsence,
  type AbsenceSubject,
} from '../src/index.js';

/**
 * The absence engine, tested directly.
 *
 * Subjects are OPAQUE: the harness hands the engine refs it can never
 * dereference — an 'employee' (Meridian's noun) and a 'resource' (Egeryds'
 * plannable unit) — and the ledger must never conflate them.
 */

/** ULID-shaped DataSubjectId (Crockford base32 — no I, L, O, U). */
const subj = (n: number): AbsenceSubject => ({
  ref: { entityType: 'employee', entityId: `emp-${n}` },
  dataSubjectId: dataSubjectId.parse(`01JABSENCE${'A'.repeat(15)}${n}`),
});

const resource = (n: number): AbsenceSubject => ({
  ref: { entityType: 'resource', entityId: `res-${n}` },
  dataSubjectId: dataSubjectId.parse(`01JABSENCE${'B'.repeat(15)}${n}`),
});

const ALL = [PERM.read, PERM.request, PERM.approve, PERM.configure];

describe('engine-absence', () => {
  let h: EngineHarness;

  beforeEach(async () => {
    h = await engineHarness({ modules: [absenceModule] });
    await h.run((ctx) => {
      configureLeaveType(ctx, { key: 'vacation' });
      configureLeaveType(ctx, { key: 'sick' });
    }, ALL);
  });

  afterEach(async () => {
    await h.close();
  });

  // -------------------------------------------------------------------------
  // The ledger: fold, append-only discipline, opacity
  // -------------------------------------------------------------------------

  it('balance is a pure fold over entries, honoring asOf', async () => {
    await h.run((ctx) => {
      recordEntry(ctx, {
        subject: subj(1),
        leaveTypeKey: 'vacation',
        entryKind: 'accrual',
        delta: '25',
        effectiveDate: '2030-01-01',
      });
      recordEntry(ctx, {
        subject: subj(1),
        leaveTypeKey: 'vacation',
        entryKind: 'carryover',
        delta: '5',
        effectiveDate: '2030-01-01',
      });
      recordEntry(ctx, {
        subject: subj(1),
        leaveTypeKey: 'vacation',
        entryKind: 'accrual',
        delta: '25',
        effectiveDate: '2031-01-01',
      });
      expect(balanceAsOf(ctx, { subject: subj(1).ref, leaveTypeKey: 'vacation' })).toBe('55');
      expect(
        balanceAsOf(ctx, { subject: subj(1).ref, leaveTypeKey: 'vacation', asOf: '2030-12-31' }),
      ).toBe('30');
      // A correction is a compensating entry, never an edit.
      recordEntry(ctx, {
        subject: subj(1),
        leaveTypeKey: 'vacation',
        entryKind: 'correction',
        delta: '-2',
        effectiveDate: '2030-02-01',
        note: 'accrued twice by mistake',
      });
      expect(balanceAsOf(ctx, { subject: subj(1).ref, leaveTypeKey: 'vacation' })).toBe('53');
    }, ALL);
  });

  it('ledgers of distinct subject types never conflate — same id, different noun', async () => {
    await h.run((ctx) => {
      const emp: AbsenceSubject = { ...subj(1), ref: { entityType: 'employee', entityId: 'x' } };
      const res: AbsenceSubject = { ...resource(1), ref: { entityType: 'resource', entityId: 'x' } };
      recordEntry(ctx, { subject: emp, leaveTypeKey: 'vacation', entryKind: 'accrual', delta: '10', effectiveDate: '2030-01-01' });
      recordEntry(ctx, { subject: res, leaveTypeKey: 'vacation', entryKind: 'accrual', delta: '3', effectiveDate: '2030-01-01' });
      expect(balanceAsOf(ctx, { subject: emp.ref, leaveTypeKey: 'vacation' })).toBe('10');
      expect(balanceAsOf(ctx, { subject: res.ref, leaveTypeKey: 'vacation' })).toBe('3');
    }, ALL);
  });

  it('recordEntry cannot mint booking or reversal kinds', async () => {
    await h.run((ctx) => {
      expect(() =>
        recordEntry(ctx, {
          subject: subj(1),
          leaveTypeKey: 'vacation',
          // @ts-expect-error — 'booking' is not a recordable kind, by construction
          entryKind: 'booking',
          delta: '-5',
          effectiveDate: '2030-06-01',
        }),
      ).toThrow();
    }, ALL);
  });

  it('recordEntry refuses an unknown leave type', async () => {
    await h.run((ctx) => {
      expect(() =>
        recordEntry(ctx, {
          subject: subj(1),
          leaveTypeKey: 'nope',
          entryKind: 'accrual',
          delta: '1',
          effectiveDate: '2030-01-01',
        }),
      ).toThrow(/leave type not found/);
    }, ALL);
  });

  // -------------------------------------------------------------------------
  // The state machine: request → approve | reject → cancelled
  // -------------------------------------------------------------------------

  const accrue = (ctx: Parameters<Parameters<EngineHarness['run']>[0]>[0], days = '25') =>
    recordEntry(ctx, {
      subject: subj(1),
      leaveTypeKey: 'vacation',
      entryKind: 'accrual',
      delta: days,
      effectiveDate: '2030-01-01',
    });

  it('approve books; the ledger moves only through the approved request', async () => {
    await h.run((ctx) => {
      accrue(ctx);
      const req = requestAbsence(ctx, {
        subject: subj(1),
        leaveTypeKey: 'vacation',
        startDate: '2030-07-01',
        endDate: '2030-07-05',
        days: '5',
      });
      expect(req.status).toBe('requested');
      // The request alone touches nothing.
      expect(balanceAsOf(ctx, { subject: subj(1).ref, leaveTypeKey: 'vacation' })).toBe('25');

      const { request, booking } = decideAbsence(ctx, { requestId: req.id, decision: 'approve' });
      expect(request.status).toBe('approved');
      expect(booking?.entryKind).toBe('booking');
      expect(booking?.delta).toBe('-5');
      expect(booking?.requestId).toBe(req.id);
      expect(balanceAsOf(ctx, { subject: subj(1).ref, leaveTypeKey: 'vacation' })).toBe('20');
    }, ALL);

    const decided = h.eventsOfType('absence.decided');
    expect(decided).toHaveLength(1);
    const payload = decided[0]!.payload as { decision: string; bookingId: string | null; days: string };
    expect(payload.decision).toBe('approved');
    expect(payload.bookingId).not.toBeNull();
    expect(payload.days).toBe('5');
  });

  it('reject writes no entry; a decided request cannot be re-decided', async () => {
    await h.run((ctx) => {
      accrue(ctx);
      const req = requestAbsence(ctx, {
        subject: subj(1),
        leaveTypeKey: 'vacation',
        startDate: '2030-07-01',
        endDate: '2030-07-05',
        days: '5',
      });
      const { booking } = decideAbsence(ctx, { requestId: req.id, decision: 'reject' });
      expect(booking).toBeNull();
      expect(listEntries(ctx, { subject: subj(1).ref, leaveTypeKey: 'vacation' })).toHaveLength(1); // accrual only
      expect(() => decideAbsence(ctx, { requestId: req.id, decision: 'approve' })).toThrow(
        /only a requested absence can be decided/,
      );
    }, ALL);
  });

  it('the floor refuses an over-balance booking — and a negative floor admits advance leave', async () => {
    await h.run((ctx) => {
      accrue(ctx, '3');
      const req = requestAbsence(ctx, {
        subject: subj(1),
        leaveTypeKey: 'vacation',
        startDate: '2030-07-01',
        endDate: '2030-07-05',
        days: '5',
      });
      expect(() => decideAbsence(ctx, { requestId: req.id, decision: 'approve' })).toThrow(
        /insufficient balance/,
      );
      // Förskottssemester: floor -25 admits the same booking.
      configureLeaveType(ctx, { key: 'vacation', floor: '-25' });
      const { request } = decideAbsence(ctx, { requestId: req.id, decision: 'approve' });
      expect(request.status).toBe('approved');
      expect(balanceAsOf(ctx, { subject: subj(1).ref, leaveTypeKey: 'vacation' })).toBe('-2');
    }, ALL);
  });

  it('cancelling an approved absence writes a compensating reversal, never an edit', async () => {
    await h.run((ctx) => {
      accrue(ctx);
      const req = requestAbsence(ctx, {
        subject: subj(1),
        leaveTypeKey: 'vacation',
        startDate: '2030-07-01',
        endDate: '2030-07-05',
        days: '5',
      });
      decideAbsence(ctx, { requestId: req.id, decision: 'approve' });
      const { request, reversal } = cancelAbsence(ctx, { requestId: req.id, reason: 'came back early' });
      expect(request.status).toBe('cancelled');
      expect(reversal?.entryKind).toBe('reversal');
      expect(reversal?.delta).toBe('5');
      expect(balanceAsOf(ctx, { subject: subj(1).ref, leaveTypeKey: 'vacation' })).toBe('25');
      // Three entries stand: accrual, booking, reversal. Nothing was edited.
      expect(listEntries(ctx, { subject: subj(1).ref, leaveTypeKey: 'vacation' }).map((e) => e.entryKind))
        .toEqual(['accrual', 'booking', 'reversal']);
    }, ALL);
  });

  it('withdrawing a still-requested absence touches no ledger', async () => {
    await h.run((ctx) => {
      accrue(ctx);
      const req = requestAbsence(ctx, {
        subject: subj(1),
        leaveTypeKey: 'vacation',
        startDate: '2030-07-01',
        endDate: '2030-07-05',
        days: '5',
      });
      const { reversal } = cancelAbsence(ctx, { requestId: req.id });
      expect(reversal).toBeNull();
      expect(listEntries(ctx, { subject: subj(1).ref, leaveTypeKey: 'vacation' })).toHaveLength(1);
    }, ALL);
  });

  it('a request against an inactive leave type is refused', async () => {
    await h.run((ctx) => {
      configureLeaveType(ctx, { key: 'sick', active: false });
      expect(() =>
        requestAbsence(ctx, {
          subject: subj(1),
          leaveTypeKey: 'sick',
          startDate: '2030-07-01',
          endDate: '2030-07-01',
          days: '1',
        }),
      ).toThrow(/inactive/);
    }, ALL);
  });

  it('expiry cancels only past-dated requested rows, and is idempotent', async () => {
    await h.run((ctx) => {
      accrue(ctx);
      requestAbsence(ctx, {
        subject: subj(1),
        leaveTypeKey: 'vacation',
        startDate: '2020-01-01', // long past
        endDate: '2020-01-05',
        days: '5',
      });
      requestAbsence(ctx, {
        subject: subj(1),
        leaveTypeKey: 'vacation',
        startDate: '2030-07-01', // future — untouched
        endDate: '2030-07-05',
        days: '5',
      });
      expect(expireStaleRequests(ctx).expired).toBe(1);
      expect(expireStaleRequests(ctx).expired).toBe(0);
      const statuses = listRequests(ctx, { subject: subj(1).ref }).map((r) => r.status).sort();
      expect(statuses).toEqual(['cancelled', 'requested']);
    }, ALL);
  });

  // -------------------------------------------------------------------------
  // Availability — the planner's read (D-C)
  // -------------------------------------------------------------------------

  it('availability expands approved requests to inclusive days, clamped to the window', async () => {
    await h.run((ctx) => {
      accrue(ctx);
      const vac = requestAbsence(ctx, {
        subject: subj(1),
        leaveTypeKey: 'vacation',
        startDate: '2030-06-28',
        endDate: '2030-07-02',
        days: '3',
      });
      decideAbsence(ctx, { requestId: vac.id, decision: 'approve' });
      // A merely requested absence must NOT count as coverage.
      requestAbsence(ctx, {
        subject: subj(1),
        leaveTypeKey: 'sick',
        startDate: '2030-07-01',
        endDate: '2030-07-01',
        days: '1',
      });

      const { days, requests } = availability(ctx, {
        subject: subj(1).ref,
        from: '2030-07-01',
        to: '2030-07-31',
      });
      expect(requests).toHaveLength(1);
      expect(days).toEqual([
        { date: '2030-07-01', leaveTypeKey: 'vacation', requestId: vac.id },
        { date: '2030-07-02', leaveTypeKey: 'vacation', requestId: vac.id },
      ]);
    }, ALL);
  });

  // -------------------------------------------------------------------------
  // Permissions — default-deny, self-service walk, the system sweep
  // -------------------------------------------------------------------------

  it('a principal holding nothing is refused everything', async () => {
    const nobody = await h.as([]);
    await expect(nobody.invoke('absence/list-requests', undefined)).rejects.toThrow();
    await expect(
      nobody.invoke('absence/request', {
        subject: subj(1),
        leaveTypeKey: 'vacation',
        startDate: '2030-07-01',
        endDate: '2030-07-01',
        days: '1',
      }),
    ).rejects.toThrow();
    await expect(
      nobody.invoke('absence/configure-leave-type', { key: 'vacation', floor: '-99' }),
    ).rejects.toThrow();
  });

  it('a requester cannot decide; an approver can', async () => {
    await h.run((ctx) => accrue(ctx), ALL);
    const requester = await h.as([PERM.request, PERM.read]);
    const req = (await requester.invoke('absence/request', {
      subject: subj(1),
      leaveTypeKey: 'vacation',
      startDate: '2030-07-01',
      endDate: '2030-07-05',
      days: '5',
    })) as { id: string };
    await expect(
      requester.invoke('absence/decide', { requestId: req.id, decision: 'approve' }),
    ).rejects.toThrow();

    const approver = await h.as([PERM.approve]);
    const decided = (await approver.invoke('absence/decide', {
      requestId: req.id,
      decision: 'approve',
    })) as { request: { status: string } };
    expect(decided.request.status).toBe('approved');
  });

  it('a requester may withdraw their own requested row but not cancel an approved one', async () => {
    await h.run((ctx) => accrue(ctx), ALL);
    const requester = await h.as([PERM.request, PERM.read]);
    const a = (await requester.invoke('absence/request', {
      subject: subj(1),
      leaveTypeKey: 'vacation',
      startDate: '2030-07-01',
      endDate: '2030-07-01',
      days: '1',
    })) as { id: string };
    const b = (await requester.invoke('absence/request', {
      subject: subj(1),
      leaveTypeKey: 'vacation',
      startDate: '2030-08-01',
      endDate: '2030-08-01',
      days: '1',
    })) as { id: string };

    const withdrawn = (await requester.invoke('absence/cancel', { requestId: a.id })) as {
      request: { status: string };
    };
    expect(withdrawn.request.status).toBe('cancelled');

    const approver = await h.as([PERM.approve]);
    await approver.invoke('absence/decide', { requestId: b.id, decision: 'approve' });
    await expect(requester.invoke('absence/cancel', { requestId: b.id })).rejects.toThrow();
    // The approver may.
    const cancelled = (await approver.invoke('absence/cancel', { requestId: b.id })) as {
      reversal: { entryKind: string } | null;
    };
    expect(cancelled.reversal?.entryKind).toBe('reversal');
  });
});
