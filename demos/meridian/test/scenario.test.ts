import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, type ScopeId } from '@substrat-run/contracts';
import { runPlatformSweep, ulid, type FetchLike, type ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { PROTOCOL_PERM, type ProtocolInstanceRow } from '@substrat-run/engine-protocol';
import {
  buildDemoHost,
  seedDemo,
  type DemoWorld,
  type EmployeeRow,
  type ExpenseRow,
  type LeaveRequestRow,
  type LedgerRow,
  type TimeEntryRow,
} from '../src/index.js';

/**
 * The Meridian scenario (spec/concept.md §9): provision → two country scopes →
 * request/approve leave that folds the append-only ledger → denials hold
 * (self-service isolation + cross-tenant attack) → the no-negative floor and
 * approval state machine → time reporting → expenses → payroll export →
 * onboarding via the protocol engine → country divergence.
 */
describe('Meridian (HR) demo scenario (spec §9)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: DemoWorld;
  let hedda: ScopeStub; // HR admin (tenant-level)
  let mats: ScopeStub; // manager @ sSe
  let elin: ScopeStub; // employee @ sSe
  let petra: ScopeStub; // payroll @ sSe

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-hr-'));
    host = buildDemoHost(dir);
    w = await seedDemo(host, dir);
    hedda = await host.getScope(w.hedda, w.t1, w.sSe);
    mats = await host.getScope(w.mats, w.t1, w.sSe);
    elin = await host.getScope(w.elin, w.t1, w.sSe);
    petra = await host.getScope(w.petra, w.t1, w.sSe);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. provisions and applies both module journals', () => {
    const db = new Database(join(dir, `${w.t1}__${w.sSe}.sqlite`), { readonly: true });
    const rows = db
      .prepare('SELECT DISTINCT module_id FROM _substrat_migrations ORDER BY module_id')
      .all() as { module_id: string }[];
    db.close();
    expect(rows.map((r) => r.module_id)).toEqual([
      '@substrat-run/demo-meridian',
      '@substrat-run/engine-protocol',
    ]);
  });

  it('2. the directory and starting balance are seeded', async () => {
    const employees = await hedda.invoke<EmployeeRow[]>('hr/list-employees');
    expect(employees.map((e) => e.number)).toEqual(['SE-001', 'SE-002', 'SE-003']);
    const bal = await hedda.invoke<{ balances: { leaveTypeKey: string; balance: string }[] }>(
      'hr/balance',
      { employeeId: w.elinEmpId },
    );
    expect(bal.balances).toEqual([{ leaveTypeKey: 'vacation', balance: '25' }]);
  });

  it('3. elin requests 5 days; mats approves; the ledger folds to 20', async () => {
    const req = await elin.invoke<LeaveRequestRow>('hr/request-leave', {
      employeeId: w.elinEmpId,
      leaveTypeKey: 'vacation',
      startDate: '2026-07-06',
      endDate: '2026-07-10',
      days: '5',
    });
    expect(req.status).toBe('requested');

    const decided = await mats.invoke<{ request: LeaveRequestRow; booking: LedgerRow }>(
      'hr/decide-leave',
      { requestId: req.id, decision: 'approve' },
    );
    expect(decided.request.status).toBe('approved');
    expect(decided.booking.delta).toBe('-5');

    const bal = await elin.invoke<{ balances: { balance: string }[] }>('hr/balance', {
      employeeId: w.elinEmpId,
    });
    expect(bal.balances[0]!.balance).toBe('20');

    // Append-only: accrual + booking, never an edit.
    const ledger = await hedda.invoke<{ balances: unknown[] }>('hr/balance', { employeeId: w.elinEmpId });
    expect(ledger.balances).toHaveLength(1);
  });

  it('4. the denials hold: self-service isolation and the cross-tenant attack', async () => {
    // elin cannot approve her own leave (no absence:approve anywhere).
    const openReq = await elin.invoke<LeaveRequestRow>('hr/request-leave', {
      employeeId: w.elinEmpId, leaveTypeKey: 'vacation', startDate: '2026-08-01', endDate: '2026-08-01', days: '1',
    });
    await expect(
      elin.invoke('hr/decide-leave', { requestId: openReq.id, decision: 'approve' }),
    ).rejects.toThrow(/permission denied/);

    // elin cannot read a colleague's balance (grant is narrowed to her record).
    await expect(elin.invoke('hr/balance', { employeeId: w.karinEmpId })).rejects.toThrow(
      /permission denied/,
    );
    // …nor request leave on someone else's behalf.
    await expect(
      elin.invoke('hr/request-leave', {
        employeeId: w.karinEmpId, leaveTypeKey: 'vacation', startDate: '2026-08-01', endDate: '2026-08-01', days: '1',
      }),
    ).rejects.toThrow(/permission denied/);
    // …nor read the directory (no employee:manage).
    await expect(elin.invoke('hr/list-employees')).rejects.toThrow(/permission denied/);

    // mallory (t2 HR admin) attacks t1's Sweden scope. Wrong pair fails closed…
    await expect(host.getScope(w.mallory, w.t2, w.sSe)).rejects.toThrow(/unknown scope/);
    // …and with the correct pair she holds no tuples in t1 — every op denied.
    const mallory = await host.getScope(w.mallory, w.t1, w.sSe);
    await expect(mallory.invoke('hr/list-employees')).rejects.toThrow(/permission denied/);
    await expect(mallory.invoke('hr/balance', { employeeId: w.elinEmpId })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('5. the no-negative floor and the approval state machine both hold', async () => {
    // Elin has 20 left; a 30-day request approved must fail on the floor.
    const tooBig = await elin.invoke<LeaveRequestRow>('hr/request-leave', {
      employeeId: w.elinEmpId, leaveTypeKey: 'vacation', startDate: '2026-09-01', endDate: '2026-09-30', days: '30',
    });
    await expect(
      mats.invoke('hr/decide-leave', { requestId: tooBig.id, decision: 'approve' }),
    ).rejects.toThrow(/insufficient balance/);
    // Reject it, then a second decision on the same request is impossible.
    await mats.invoke('hr/decide-leave', { requestId: tooBig.id, decision: 'reject' });
    await expect(
      mats.invoke('hr/decide-leave', { requestId: tooBig.id, decision: 'approve' }),
    ).rejects.toThrow(/only a requested leave can be decided/);
    // The failed approval wrote nothing: balance untouched.
    const bal = await hedda.invoke<{ balances: { balance: string }[] }>('hr/balance', {
      employeeId: w.elinEmpId,
    });
    expect(bal.balances[0]!.balance).toBe('20');
  });

  it('6. time reporting is append-only; the daily total is a fold', async () => {
    await elin.invoke('hr/log-time', { employeeId: w.elinEmpId, projectId: w.projectId, workDate: '2026-07-13', hours: '8' });
    // A correction is a NEW row, never an edit.
    await elin.invoke('hr/log-time', { employeeId: w.elinEmpId, projectId: w.projectId, workDate: '2026-07-14', hours: '7.5' });
    const sheet = await elin.invoke<{ entries: TimeEntryRow[]; totalHours: string }>('hr/timesheet', {
      employeeId: w.elinEmpId,
    });
    expect(sheet.entries).toHaveLength(2);
    expect(sheet.totalHours).toBe('15.5');
  });

  it('7. expenses: submit → approve → payroll export marks them exported', async () => {
    const exp = await elin.invoke<ExpenseRow>('hr/submit-expense', {
      employeeId: w.elinEmpId, description: 'Tågbiljett Stockholm–Göteborg', amount: '640', currency: 'SEK', category: 'travel', projectId: w.projectId,
    });
    expect(exp.status).toBe('submitted');
    // elin cannot approve her own expense.
    await expect(
      elin.invoke('hr/decide-expense', { expenseId: exp.id, decision: 'approve' }),
    ).rejects.toThrow(/permission denied/);
    await mats.invoke('hr/decide-expense', { expenseId: exp.id, decision: 'approve' });

    const run = await petra.invoke<{ expenses: { amount: string }[]; absence: { days: string }[] }>(
      'hr/payroll-export',
      { fromDate: '2026-07-01', toDate: '2026-07-31' },
    );
    expect(run.expenses).toEqual([{ employeeId: w.elinEmpId, amount: '640', currency: 'SEK', category: 'travel' }]);
    // The July booking (5 days) shows up as positive days in the export.
    expect(run.absence).toEqual([{ employeeId: w.elinEmpId, leaveTypeKey: 'vacation', days: '5' }]);

    // Re-running the export never double-counts: the expense is now 'exported'.
    const again = await petra.invoke<{ expenses: unknown[] }>('hr/payroll-export', {
      fromDate: '2026-07-01', toDate: '2026-07-31',
    });
    expect(again.expenses).toHaveLength(0);
  });

  /**
   * A stand-in for the Scrive connector: a principal holding ONLY
   * `protocol:record-signature`, the key no human role holds.
   *
   * Test scaffolding, not architecture. Minting a principal to stand in for a
   * provider is precisely the shortcut #97 exists to replace — it makes the
   * connector indistinguishable from a user in every audit view, which is the
   * confusion `PlatformActorId`'s separate brand was introduced to prevent.
   * Keeping it in the test keeps it out of the reference implementation.
   */
  const connectorStub = async (scope: ScopeId = w.sSe): Promise<ScopeStub> => {
    const principal = principalId.parse(ulid());
    const roleKey = `scrive-connector-${ulid().toLowerCase()}`;
    const staff = platformActorId.parse(ulid());
    await host.admin.defineRole(staff, w.t1, {
      key: roleKey,
      permissions: [PROTOCOL_PERM.recordSignature],
      source: 'vertical',
    });
    await host.admin.assignRole(staff, {
      principalId: principal,
      roleKey,
      node: { tenantId: w.t1, scopeId: scope },
    });
    return host.getScope(principal, w.t1, scope);
  };

  it('8. onboarding reuses the protocol engine: the employee fills AND e-signs their own', async () => {
    // Seeded as an open onboarding for Elin; she reaches it via her own-record
    // grant walking protocol → employee.
    const summaries = await elin.invoke<{ instance: ProtocolInstanceRow }[]>('protocol/list-for-entity', {
      entityType: 'employee',
      entityId: w.elinEmpId,
    });
    const inst = summaries[0]!.instance;
    expect(inst.status).toBe('open');
    expect(inst.entity_type).toBe('employee');

    await elin.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'bankuppgifter', value: true });
    // Vertical policy: the EMPLOYEE signs their own onboarding (unlike Callout,
    // where the arbetsledare signs) — same engine, the grant draws the line.
    const signed = await elin.invoke<{ instance: ProtocolInstanceRow }>('protocol/sign', {
      instanceId: inst.id,
    });
    expect(signed.instance.status).toBe('signed');
    // Frozen: a further fill fails.
    await expect(
      elin.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'utrustning', value: true }),
    ).rejects.toThrow(/frozen/);
    // A colleague (the manager) holds no fill on Elin's onboarding.
    await expect(
      mats.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'utrustning', value: true }),
    ).rejects.toThrow(/permission denied/);
  });

  /**
   * The anställningsavtal — the half of the protocol engine a checklist cannot
   * express: an opaque document, signed asynchronously, by someone with no
   * account.
   *
   * THE STUB. `protocol/record-signature` is what a Scrive webhook would call.
   * There is no webhook ingress (#96) and no way for a non-principal callback to
   * invoke a scope operation (#97), so this test mints a principal holding
   * `protocol:record-signature` and calls it directly.
   *
   * That principal lives HERE, in the test, and deliberately not in `seed.ts`.
   * Demos are reference implementations — the new-vertical skill points people
   * at them — and a seeded "connector principal" would quietly become the
   * answer to #97 before #97 is designed. It is test scaffolding standing in for
   * a provider, nothing more.
   */
  it('10. the anställningsavtal is a DOCUMENT: bound by hash, never seen by the engine', async () => {
    const terms = await hedda.invoke<{ id: string; monthly_salary: string }>(
      'hr/employment-terms',
      { employeeId: w.karinEmpId },
    );
    expect(terms.monthly_salary).toBe('52000'); // a decimal string, never a float

    const [summary] = await hedda.invoke<
      { instance: ProtocolInstanceRow; contentKind: string; pendingSignatures: number }[]
    >('protocol/list-for-entity', { entityType: 'employee', entityId: w.karinEmpId });

    // Seeded as issued: frozen at a hash, out for two signatures.
    expect(summary!.contentKind).toBe('document');
    expect(summary!.instance.status).toBe('pending_signature');
    expect(summary!.pendingSignatures).toBe(2);
    // The engine holds a POINTER and a HASH — never the salary.
    expect(summary!.instance.content_ref_type).toBe('employment-terms');
    expect(summary!.instance.content_ref_id).toBe(terms.id);
    expect(summary!.instance.bound_hash).toMatch(/^[0-9a-f]{64}$/);
    // The frozen hash is the engine's recipe run OVER the bound hash (template
    // key/version + 'document:<boundHash>'), not the bound hash itself. Two
    // different values; conflating them would make the template version drop
    // out of what was attested to.
    expect(summary!.instance.frozen_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(summary!.instance.frozen_hash).not.toBe(summary!.instance.bound_hash);

    // The vertical's own re-derivation agrees — the check the ENGINE cannot do.
    const verified = await hedda.invoke<{ matches: boolean }>('hr/verify-contract', {
      instanceId: summary!.instance.id,
    });
    expect(verified.matches).toBe(true);
  });

  it('11. out for signature means FROZEN — the terms cannot move under the signatories', async () => {
    const [summary] = await hedda.invoke<{ instance: ProtocolInstanceRow }[]>(
      'protocol/list-for-entity',
      { entityType: 'employee', entityId: w.karinEmpId },
    );
    const instanceId = summary!.instance.id;

    // Rebinding is refused while the document sits at the provider. This is the
    // defect the freeze/sign split exists to close: before it, an instance
    // stayed `open` for the days it was out and the content could drift from
    // what the signatory was looking at.
    await expect(
      hedda.invoke('protocol/bind-document', {
        instanceId,
        contentRef: { entityType: 'employment-terms', entityId: 'whatever' },
        contentHash: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/out for signature/);

    // But the vertical's OWN table is not frozen by the engine — nothing stops a
    // renegotiation writing a new terms row. The engine cannot detect that; the
    // vertical must, and this is exactly why hashRecipe is a required field.
    await hedda.invoke('hr/set-employment-terms', {
      employeeId: w.karinEmpId,
      roleTitle: 'Systemutvecklare',
      monthlySalary: '54000', // renegotiated after the contract went out
      currency: 'SEK',
      scopePct: '100',
      startDate: '2026-09-01',
      noticeMonths: '3',
    });

    // The contract still points at the row it was issued against, so the
    // signature remains meaningful and re-derivation still matches.
    const verified = await hedda.invoke<{ matches: boolean }>('hr/verify-contract', { instanceId });
    expect(verified.matches).toBe(true);
  });

  it('12. two signatories, two KINDS: an employer principal and an employee with no account', async () => {
    const karin = await hedda.invoke<EmployeeRow[]>('hr/list-employees');
    const karinRow = karin.find((e) => e.id === w.karinEmpId)!;
    // The premise: a new hire has no login on the day they sign.
    expect(karinRow.principal_ref).toBeNull();

    const [summary] = await hedda.invoke<{ instance: ProtocolInstanceRow }[]>(
      'protocol/list-for-entity',
      { entityType: 'employee', entityId: w.karinEmpId },
    );
    const instanceId = summary!.instance.id;
    const detail = await hedda.invoke<{
      instance: ProtocolInstanceRow;
      requests: { id: string; party_label: string; party_kind: string; signature_kind: string }[];
    }>('protocol/get', { instanceId });

    const employer = detail.requests.find((r) => r.party_label === 'Arbetsgivare')!;
    const employee = detail.requests.find((r) => r.party_label === 'Anställd')!;
    expect(employer.party_kind).toBe('principal');
    expect(employer.signature_kind).toBe('primary'); // the issuing party
    expect(employee.party_kind).toBe('external');

    const connector = await connectorStub();
    const frozen = detail.instance.frozen_hash!;

    // Scrive reports the employer signed. One down, one to go — NOT signed yet.
    const first = await connector.invoke<{ instance: ProtocolInstanceRow }>(
      'protocol/record-signature',
      {
        requestId: employer.id,
        signatory: { kind: 'principal', ref: w.hedda },
        signedAt: '2026-08-02T09:15:00.000Z',
        contentHash: frozen,
        evidenceRef: 'scrive:tx-4417/sealed.pdf',
      },
    );
    expect(first.instance.status).toBe('pending_signature');

    // Then Karin signs with BankID — at the PROVIDER's time, with no account.
    const second = await connector.invoke<{
      instance: ProtocolInstanceRow;
      signature: {
        signed_by: string;
        signatory_kind: string;
        method: string;
        signed_at: string;
        evidence_ref: string | null;
      };
    }>('protocol/record-signature', {
      requestId: employee.id,
      signatory: { kind: 'external', ref: w.karinEmpId, label: 'Karin Berg' },
      signedAt: '2026-08-04T18:42:00.000Z',
      contentHash: frozen,
      evidenceRef: 'scrive:tx-4417/karin.pdf',
    });

    expect(second.instance.status).toBe('signed'); // only now, with BOTH in
    expect(second.signature.signatory_kind).toBe('external');
    expect(second.signature.method).toBe('scrive'); // not 'in-app'
    expect(second.signature.signed_at).toBe('2026-08-04T18:42:00.000Z'); // not "now"
    expect(second.signature.evidence_ref).toBe('scrive:tx-4417/karin.pdf');

    // The signatory ref is the opaque employee id — the same DataSubjectId
    // hr.employee-created shreds on. NEVER the national_id.
    expect(second.signature.signed_by).toBe(w.karinEmpId);
    expect(second.signature.signed_by).not.toBe(karinRow.national_id);
  });

  it('13. a provider cannot report a signature over content we did not freeze', async () => {
    const es = await host.getScope(w.hedda, w.t1, w.sEs);
    await es.invoke('hr/set-employment-terms', {
      employeeId: w.pabloEmpId,
      roleTitle: 'Desarrollador',
      monthlySalary: '3800',
      currency: 'EUR',
      scopePct: '100',
      startDate: '2026-09-01',
      noticeMonths: '1',
    });
    const issued = await es.invoke<{ instance: ProtocolInstanceRow }>(
      'hr/issue-employment-contract',
      { templateKey: 'anstallningsavtal-es', employeeId: w.pabloEmpId },
    );
    const detail = await es.invoke<{ requests: { id: string; party_label: string }[] }>(
      'protocol/get',
      { instanceId: issued.instance.id },
    );
    const employee = detail.requests.find((r) => r.party_label === 'Anställd')!;

    const connectorEs = await connectorStub(w.sEs);
    await expect(
      connectorEs.invoke('protocol/record-signature', {
        requestId: employee.id,
        signatory: { kind: 'external', ref: w.pabloEmpId },
        signedAt: '2026-08-04T18:42:00.000Z',
        contentHash: 'f'.repeat(64), // a different document entirely
      }),
    ).rejects.toThrow(/does not match the frozen protocol/);

    // A refusal does not thaw the contract either — renegotiating is an
    // explicit, permissioned act, not a side effect of somebody saying no.
    await connectorEs.invoke('protocol/decline-signature', {
      requestId: employee.id,
      reason: 'salario insuficiente',
    });
    const after = await es.invoke<{ instance: ProtocolInstanceRow }>('protocol/get', {
      instanceId: issued.instance.id,
    });
    expect(after.instance.status).toBe('pending_signature'); // NOT signed, NOT open
  });

  it('14. HR can send a contract but cannot speak for the signing provider', async () => {
    const [summary] = await hedda.invoke<{ instance: ProtocolInstanceRow }[]>(
      'protocol/list-for-entity',
      { entityType: 'employee', entityId: w.karinEmpId },
    );
    // hr-admin holds bind + request-signature — it may freeze and dispatch.
    // It does NOT hold record-signature: asserting that a customer signed with
    // BankID is the provider's word, and no human role in this demo has it.
    await expect(
      hedda.invoke('protocol/record-signature', {
        requestId: 'anything',
        signatory: { kind: 'external', ref: w.karinEmpId },
        signedAt: '2026-08-04T18:42:00.000Z',
        contentHash: summary!.instance.frozen_hash!,
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('9. country divergence: Spain runs the same code with different statutory rules', async () => {
    const es = await host.getScope(w.hedda, w.t1, w.sEs);
    const types = await es.invoke<{ key: string; annual_days: string | null }[]>('hr/list-leave-types');
    const vacation = types.find((t) => t.key === 'vacation')!;
    expect(vacation.annual_days).toBe('22'); // Spain, not Sweden's 25
    const bal = await es.invoke<{ balances: { balance: string }[] }>('hr/balance', {
      employeeId: w.pabloEmpId,
    });
    expect(bal.balances[0]!.balance).toBe('22');

    // Scope isolation: the Stockholm manager has no reach into Madrid.
    const matsInEs = await host.getScope(w.mats, w.t1, w.sEs);
    await expect(matsInEs.invoke('hr/list-requests')).rejects.toThrow(/permission denied/);
  });

  it('10. a stale leave is auto-cancelled by the platform sweep, attributed to the system (#383)', async () => {
    // elin files a leave whose start date is already in the past and never gets it
    // approved — the exact case a date-triggered rule exists for.
    const stale = await elin.invoke<LeaveRequestRow>('hr/request-leave', {
      employeeId: w.elinEmpId,
      leaveTypeKey: 'vacation',
      startDate: '2020-01-06',
      endDate: '2020-01-10',
      days: '4',
    });
    expect(stale.status).toBe('requested');

    // No one touches it. The platform sweep — the same driver server.ts runs on a
    // timer — invokes `hr/expire-stale-requests` on every live scope, under a
    // system actor, and the leave is cancelled.
    const report = await runPlatformSweep(host, {
      actor: platformActorId.parse(ulid()),
      fetch: globalThis.fetch as unknown as FetchLike,
      sweepers: {},
      drainRetries: false,
      gcSnapshots: false,
      reconcileMigrations: false,
    });
    expect(report.schedules).not.toBeNull();
    expect(report.schedules!.fired).toBeGreaterThanOrEqual(1);
    expect(report.errors).toEqual([]);

    const requests = await hedda.invoke<LeaveRequestRow[]>('hr/list-requests');
    expect(requests.find((r) => r.id === stale.id)?.status).toBe('cancelled');

    // The audit trail names the SCHEDULE, not a manager who never looked at it —
    // the attribution the whole seam exists to keep honest.
    const db = new Database(join(dir, `${w.t1}__${w.sSe}.sqlite`), { readonly: true });
    const evt = db
      .prepare(`SELECT actor FROM _substrat_outbox WHERE type = 'hr.leave-expired' ORDER BY id DESC LIMIT 1`)
      .get() as { actor: string } | undefined;
    db.close();
    expect(evt).toBeDefined();
    expect(JSON.parse(evt!.actor)).toEqual({ system: '@substrat-run/demo-meridian' });

    // Cadence gate: a second immediate pass does not re-run it.
    const again = await runPlatformSweep(host, {
      actor: platformActorId.parse(ulid()),
      fetch: globalThis.fetch as unknown as FetchLike,
      sweepers: {},
      drainRetries: false,
      gcSnapshots: false,
      reconcileMigrations: false,
    });
    expect(again.schedules!.fired).toBe(0);
    expect(again.schedules!.skipped).toBeGreaterThanOrEqual(1);
  });
});
