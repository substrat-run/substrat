import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, principalId, scopeId, tenantId, type OpsFailureEntry } from '@substrat-run/contracts';
import {
  AUDITED_CALL_DEADLINE_MS,
  ControlPlaneError,
  SETTLE_GRACE_MS,
  UNRECORDED_OUTCOME_LOG,
  VerticalClient,
  OUTCOME_CONFLICT_LOG,
  auditedChange,
  settleUnrecordedOutcomes,
  supersededUnknowns,
  withAuditedOutcomes,
  type AuditedRow,
} from '../src/index.js';

/**
 * The intent → call → outcome audit both cross-store flows share (#2064). The helper is pinned
 * here on its own; the two routes' suites (`owner-transfer.test.ts`, `members-routes.test.ts`)
 * pin that each flow goes through it, by the log line it names the flow in.
 */
describe('auditedChange (#2064)', () => {
  const harness = (fail: Partial<Record<AuditedRow<unknown>['phase'], Error>> = {}) => {
    const rows: AuditedRow<unknown>[] = [];
    const logged: [string, Record<string, unknown>][] = [];
    return {
      rows,
      logged,
      spec: <T>(run: () => Promise<T>) => ({
        flow: 'test-flow',
        operationId: 'op-1',
        record: async (row: AuditedRow<T>) => {
          if (fail[row.phase]) throw fail[row.phase];
          rows.push(row as AuditedRow<unknown>);
        },
        run: vi.fn(run),
        refused: (e: unknown) => e instanceof ControlPlaneError && e.status === 409,
        logError: (message: string, fields: Record<string, unknown>) => logged.push([message, fields]),
      }),
    };
  };

  it('applied: intent then applied, nothing logged', async () => {
    const h = harness();
    expect(await auditedChange(h.spec(async () => 'moved'))).toEqual({ operationId: 'op-1', result: 'moved' });
    expect(h.rows).toEqual([{ phase: 'intent' }, { phase: 'applied', result: 'moved' }]);
    expect(h.logged).toEqual([]);
  });

  it('refused and failed: the outcome row says which, the error is handed back untouched and capped in the row', async () => {
    const refusal = new ControlPlaneError(409, 'claim it first');
    const h = harness();
    expect(await auditedChange(h.spec(() => Promise.reject(refusal)))).toEqual({ operationId: 'op-1', error: refusal });
    const long = new ControlPlaneError(502, 'x'.repeat(1000));
    expect(await auditedChange(h.spec(() => Promise.reject(long)))).toEqual({ operationId: 'op-1', error: long });
    expect(h.rows).toEqual([
      { phase: 'intent' },
      { phase: 'refused', error: 'claim it first' },
      { phase: 'intent' },
      { phase: 'failed', error: 'x'.repeat(300) },
    ]);
    expect(h.logged).toEqual([]);
  });

  it('an intent the log cannot take stops the call', async () => {
    const h = harness({ intent: new Error('log down') });
    const spec = h.spec(async () => 'moved');
    await expect(auditedChange(spec)).rejects.toThrow('log down');
    expect(spec.run).not.toHaveBeenCalled();
  });

  it("a refused/failed row that cannot be written still hands back the vertical's error — and logs it with the operation id", async () => {
    for (const [phase, status] of [['refused', 409], ['failed', 500]] as const) {
      const h = harness({ [phase]: new Error('log down') });
      const thrown = new ControlPlaneError(status, 'nope');
      expect(await auditedChange(h.spec(() => Promise.reject(thrown)))).toEqual({ operationId: 'op-1', error: thrown });
      expect(h.rows).toEqual([{ phase: 'intent' }]);
      expect(h.logged).toEqual([
        [UNRECORDED_OUTCOME_LOG, { flow: 'test-flow', operationId: 'op-1', phase, auditError: 'log down' }],
      ]);
    }
  });

  it('an applied row that cannot be written answers `unrecorded` with the result — and logs it', async () => {
    const h = harness({ applied: new Error('log down') });
    expect(await auditedChange(h.spec(async () => 'moved'))).toEqual({ operationId: 'op-1', result: 'moved', unrecorded: 'log down' });
    expect(h.logged).toEqual([
      [UNRECORDED_OUTCOME_LOG, { flow: 'test-flow', operationId: 'op-1', phase: 'applied', auditError: 'log down' }],
    ]);
  });
});

/**
 * The reconcile half: an intent with no outcome is closed by the scheduled pass, against the
 * real adapter's admin log and its strict row parse — the producer of the rows it reads.
 */
describe('settleUnrecordedOutcomes (#2064)', () => {
  const staff = platformActorId.parse(ulid());
  const sweep = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const A = principalId.parse(ulid());
  const B = principalId.parse(ulid());
  const HOUR = 60 * 60 * 1000;
  let dir: string;
  let host: SqliteScopeHost;
  const later = (ms: number) => new Date(Date.now() + ms);
  const rowsOf = async (action: 'transferOwner' | 'manageScopeMember', operationId: string) =>
    (await host.admin.auditLog(staff, { tenantId: t, action }))
      .filter((r) => (r.after as { operationId: string }).operationId === operationId)
      .map((r) => ({ actor: r.actor, ...(r.after as Record<string, unknown>) }));

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-audited-change-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'desk-vertical' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('closes each orphaned intent with an `unknown` row and an ops-failure row; a closed pair and a fresh intent are left alone', async () => {
    const orphanHandOver = ulid();
    const orphanMember = ulid();
    const closed = ulid();
    const fresh = ulid();
    const handOver = { tenantId: t, scopeId: s, from: A, to: B, abandon: true as const };
    await host.admin.recordOwnerTransfer(staff, { ...handOver, operationId: orphanHandOver, phase: 'intent' });
    await host.admin.recordOwnerTransfer(staff, { ...handOver, operationId: closed, phase: 'intent' });
    await host.admin.recordOwnerTransfer(staff, { ...handOver, operationId: closed, phase: 'refused', error: 'no' });
    const member = { tenantId: t, scopeId: s, change: 'role' as const, caller: A, principal: B, from: 'agent', to: 'lead' };
    await host.admin.recordMemberChange(staff, { ...member, operationId: orphanMember, phase: 'intent' });

    // Inside the grace window nothing is settled: the request may still be running.
    expect((await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: later(HOUR / 2) })).settled).toEqual([]);

    const pass = await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: later(2 * HOUR) });
    expect(pass.errors).toEqual([]);
    expect(pass.settled.map((x) => [x.action, x.operationId]).sort()).toEqual(
      [['manageScopeMember', orphanMember], ['transferOwner', orphanHandOver]].sort(),
    );
    const unknown = expect.stringMatching(/no outcome was recorded within 60 minutes/);
    expect(await rowsOf('transferOwner', orphanHandOver)).toEqual([
      { actor: staff, from: A, to: B, abandon: true, operationId: orphanHandOver, phase: 'intent' },
      { actor: sweep, from: A, to: B, abandon: true, operationId: orphanHandOver, phase: 'unknown', error: unknown },
    ]);
    expect(await rowsOf('manageScopeMember', orphanMember)).toEqual([
      { actor: staff, change: 'role', caller: A, principal: B, from: 'agent', to: 'lead', operationId: orphanMember, phase: 'intent' },
      { actor: sweep, change: 'role', caller: A, principal: B, from: 'agent', to: 'lead', operationId: orphanMember, phase: 'unknown', error: unknown },
    ]);
    expect((await rowsOf('transferOwner', closed)).map((r) => r.phase)).toEqual(['intent', 'refused']);
    const failures = await host.admin.listOpsFailures(staff, { tenantId: t });
    expect(failures.map((f) => [f.operation, f.stage, f.scopeId]).sort()).toEqual(
      [['audit.manageScopeMember', 'outcome-unknown', s], ['audit.transferOwner', 'outcome-unknown', s]].sort(),
    );
    expect(failures.every((f) => f.message.includes(orphanHandOver) || f.message.includes(orphanMember))).toBe(true);

    // Idempotent: a settled intent has an outcome now.
    expect((await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: later(3 * HOUR) })).settled).toEqual([]);

    // A fresh orphan is left for its own grace window, then settled — the positive twin.
    await host.admin.recordOwnerTransfer(staff, { ...handOver, operationId: fresh, phase: 'intent' });
    expect((await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: later(HOUR / 2) })).settled).toEqual([]);
    expect((await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: later(2 * HOUR) })).settled.map((x) => x.operationId)).toEqual([fresh]);
  });

  it('an intent older than the lookback is not read; a settle that fails leaves the intent open for the next pass', async () => {
    const old = ulid();
    await host.admin.recordOwnerTransfer(staff, { tenantId: t, scopeId: s, operationId: old, from: A, to: B, phase: 'intent' });
    expect(
      (await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: later(9 * 24 * HOUR) })).settled,
    ).toEqual([]);

    vi.spyOn(host.admin, 'settleUnrecordedOutcome').mockRejectedValueOnce(new Error('log down'));
    const pass = await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: later(2 * HOUR) });
    expect(pass.settled).toEqual([]);
    expect(pass.errors).toEqual([{ operationId: old, error: 'log down' }]);
    expect((await rowsOf('transferOwner', old)).map((r) => r.phase)).toEqual(['intent']);
    // With the log back, the next pass closes it.
    const next = await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: later(2 * HOUR) });
    expect(next.settled.map((x) => x.operationId)).toEqual([old]);
  });

  it('two passes racing settle an orphan once', async () => {
    const op = ulid();
    await host.admin.recordOwnerTransfer(staff, { tenantId: t, scopeId: s, operationId: op, from: A, to: B, phase: 'intent' });
    const pass = () => settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: later(2 * HOUR) });
    const [one, two] = await Promise.all([pass(), pass()]);
    expect([...one.settled, ...two.settled].map((x) => x.operationId)).toEqual([op]);
    expect((await rowsOf('transferOwner', op)).map((r) => r.phase)).toEqual(['intent', 'unknown']);
  });

  it('an outcome that lands between the scan and the settle wins: no `unknown` is written', async () => {
    const op = ulid();
    await host.admin.recordOwnerTransfer(staff, { tenantId: t, scopeId: s, operationId: op, from: A, to: B, phase: 'intent' });
    const scan = host.admin.auditLog.bind(host.admin);
    // The scan reads the orphan, and THEN the request's own outcome lands, before the settle.
    const late = vi.spyOn(host.admin, 'auditLog').mockImplementationOnce(async (actor, filter) => {
      const page = await scan(actor, filter);
      await host.admin.recordOwnerTransfer(staff, { tenantId: t, scopeId: s, operationId: op, from: A, to: B, phase: 'applied', outcome: 'transferred', fromRevoked: true });
      return page;
    });
    const pass = await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: later(2 * HOUR) });
    late.mockRestore();
    expect(pass).toEqual({ settled: [], errors: [] });
    expect((await rowsOf('transferOwner', op)).map((r) => r.phase)).toEqual(['intent', 'applied']);
  });

  it('a settle whose ops-failure row cannot be written writes no `unknown` either — one unit', async () => {
    const op = ulid();
    await host.admin.recordOwnerTransfer(staff, { tenantId: t, scopeId: s, operationId: op, from: A, to: B, phase: 'intent' });
    // The directory's ops ledger refuses inserts for the length of one pass.
    const db = (host as unknown as { directory: { exec(sql: string): void } }).directory;
    db.exec(`CREATE TRIGGER ledger_down BEFORE INSERT ON _substrat_ops_failures BEGIN SELECT RAISE(ABORT, 'ops ledger down'); END`);
    const pass = await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: later(2 * HOUR) });
    db.exec('DROP TRIGGER ledger_down');
    expect(pass.errors).toEqual([{ operationId: op, error: expect.stringMatching(/ops ledger down/) }]);
    expect((await rowsOf('transferOwner', op)).map((r) => r.phase)).toEqual(['intent']);
    // The next pass writes both.
    expect((await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: later(2 * HOUR) })).settled.map((x) => x.operationId)).toEqual([op]);
    expect((await rowsOf('transferOwner', op)).map((r) => r.phase)).toEqual(['intent', 'unknown']);
    expect((await host.admin.listOpsFailures(staff, { tenantId: t })).filter((f) => f.message.includes(op))).toHaveLength(1);
  });

  it('refuses a grace window that does not exceed the audited call deadline', async () => {
    await expect(settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, graceMs: AUDITED_CALL_DEADLINE_MS })).rejects.toThrow(/does not exceed/);
    expect(SETTLE_GRACE_MS).toBeGreaterThan(AUDITED_CALL_DEADLINE_MS);
  });
});

/**
 * The readers resolve an operation by PRIORITY, not by order (#2064 r3): the intent and a real
 * outcome are stamped by the request's writer, a settle's `unknown` by the directory's, and their
 * ids and clocks need not agree. Rows are written straight into the directory here, so each test
 * picks the ids and timestamps that a skewed clock or a same-millisecond write would produce.
 */
describe('the readers hold to the priority rule, whatever the ids and clocks say (#2064)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const A = principalId.parse(ulid());
  const B = principalId.parse(ulid());
  let dir: string;
  let host: SqliteScopeHost;
  const raw = (id: string, phase: string, operationId: string, at: string, extra: object = {}, where: { tenant?: string; scope?: string } = {}) =>
    (host as unknown as { directory: { prepare(sql: string): { run(...a: unknown[]): void } } }).directory
      .prepare('INSERT INTO _substrat_admin_log (id, actor, action, tenant_id, scope_id, vertical, before, after, at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)')
      .run(id, staff, 'transferOwner', where.tenant ?? t, where.scope ?? s, JSON.stringify({ phase, operationId, from: A, to: B, ...extra }), at);
  const entriesOf = async (operationId: string) =>
    (await host.admin.auditLog(staff, { action: 'transferOwner' })).filter(
      (r) => (r.after as { operationId: string }).operationId === operationId,
    );
  const unknownFailure = (operationId: string, where: { tenant?: string; scope?: string } = {}) =>
    ({
      id: ulid(), operation: 'audit.transferOwner', stage: 'outcome-unknown', tenantId: where.tenant ?? t, scopeId: where.scope ?? s,
      reference: operationId, at: '2026-10-06T12:00:00.000Z',
    }) as OpsFailureEntry;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-audited-priority-'));
    host = new SqliteScopeHost({ dir });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const AT = '2026-10-06T12:00:00.000Z';
  const EARLIER = '2026-10-06T11:00:00.000Z';
  // [case, rows as (id, phase, at)]: the real outcome before, beside or "behind" the unknown.
  const orders: [string, [string, string, string][]][] = [
    ['the real outcome with a lower id than the unknown', [['01J0000000000000000000000A', 'intent', AT], ['01J0000000000000000000000B', 'applied', AT], ['01J0000000000000000000000C', 'unknown', AT]]],
    ['the same timestamp on every row', [['01J0000000000000000000000A', 'intent', AT], ['01J0000000000000000000000C', 'unknown', AT], ['01J0000000000000000000000B', 'applied', AT]]],
    ['a skewed clock: the real outcome stamped before the intent', [['01J0000000000000000000000B', 'applied', EARLIER], ['01J0000000000000000000000C', 'intent', AT], ['01J0000000000000000000000D', 'unknown', AT]]],
  ];

  for (const [name, rows] of orders) {
    it(`the admin-log API and the digest both read applied: ${name}`, async () => {
      const operationId = ulid();
      for (const [id, phase, at] of rows) {
        // Unique per operation, ordered within it by the last letter the case chose.
        raw(`01J${operationId.slice(10, 22)}${id.slice(15)}`, phase, operationId, at, phase === 'unknown' ? { error: 'no outcome' } : phase === 'applied' ? { outcome: 'transferred', fromRevoked: true } : {});
      }
      const annotated = await withAuditedOutcomes(host.admin, staff, await entriesOf(operationId));
      for (const row of annotated) {
        const phase = (row.after as { phase: string }).phase;
        expect(row.audited).toEqual({ operationId, outcome: 'applied', superseded: phase === 'unknown' });
      }
      // The digest: the settle's ops-failure row, stamped later than the skewed real outcome.
      const failure = {
        id: ulid(), actor: staff, operation: 'audit.transferOwner', stage: 'outcome-unknown', tenantId: t, scopeId: s,
        vertical: null, version: null, status: null, origin: null, code: null, message: `operation ${operationId}`,
        reference: operationId, fingerprint: null, at: AT,
      } as OpsFailureEntry;
      expect(await supersededUnknowns(host.admin, staff, [failure])).toEqual(new Set([failure.id]));
    });
  }

  it('two real outcomes are conflicting: logged, kept in the digest, and not guessed past', async () => {
    const operationId = ulid();
    raw(ulid(), 'intent', operationId, AT);
    raw(ulid(), 'applied', operationId, AT, { outcome: 'transferred', fromRevoked: true });
    raw(ulid(), 'refused', operationId, AT, { error: 'no' });
    raw(ulid(), 'unknown', operationId, AT, { error: 'no outcome' });
    const logged: unknown[][] = [];
    const logError = (m: string, f: Record<string, unknown>) => logged.push([m, f]);
    const annotated = await withAuditedOutcomes(host.admin, staff, await entriesOf(operationId), logError);
    expect(annotated.map((r) => r.audited?.outcome)).toEqual(['conflicting', 'conflicting', 'conflicting', 'conflicting']);
    expect(logged).toEqual([[OUTCOME_CONFLICT_LOG, { operation: ['transferOwner', operationId, t, s], outcomes: ['applied', 'refused'] }]]);
    const failure = { id: ulid(), operation: 'audit.transferOwner', stage: 'outcome-unknown', tenantId: t, scopeId: s, reference: operationId, at: AT } as OpsFailureEntry;
    expect(await supersededUnknowns(host.admin, staff, [failure], logError)).toEqual(new Set());
  });

  it('one operation id in two tenants and two scopes is three operations: no false conflict, in the API or the digest', async () => {
    // Ids are minted per request, so a shared one is a collision, never one operation. Each
    // scope's rows decide its own outcome.
    const operationId = ulid();
    const t2 = tenantId.parse(ulid());
    const s2 = scopeId.parse(ulid());
    raw(ulid(), 'intent', operationId, AT);
    raw(ulid(), 'unknown', operationId, AT, { error: 'no outcome' });
    raw(ulid(), 'applied', operationId, AT, { outcome: 'transferred', fromRevoked: true });
    raw(ulid(), 'intent', operationId, AT, {}, { tenant: t2 });
    raw(ulid(), 'unknown', operationId, AT, { error: 'no outcome' }, { tenant: t2 });
    raw(ulid(), 'refused', operationId, AT, { error: 'no' }, { tenant: t2 });
    raw(ulid(), 'intent', operationId, AT, {}, { scope: s2 });
    raw(ulid(), 'unknown', operationId, AT, { error: 'no outcome' }, { scope: s2 });
    const logged: unknown[][] = [];
    const logError = (m: string, f: Record<string, unknown>) => logged.push([m, f]);
    const annotated = await withAuditedOutcomes(host.admin, staff, await entriesOf(operationId), logError);
    const byScope = (tenant: string, scope: string) =>
      annotated.filter((r) => r.tenantId === tenant && r.scopeId === scope).map((r) => [(r.after as { phase: string }).phase, r.audited?.outcome, r.audited?.superseded]);
    expect(byScope(t, s)).toEqual([['intent', 'applied', false], ['unknown', 'applied', true], ['applied', 'applied', false]]);
    expect(byScope(t2, s)).toEqual([['intent', 'refused', false], ['unknown', 'refused', true], ['refused', 'refused', false]]);
    expect(byScope(t, s2)).toEqual([['intent', 'unknown', false], ['unknown', 'unknown', false]]);
    expect(logged).toEqual([]);
    // The digest, the same way: the two scopes a real outcome reached are resolved, the third is not.
    const failures = [unknownFailure(operationId), unknownFailure(operationId, { tenant: t2 }), unknownFailure(operationId, { scope: s2 })];
    expect(await supersededUnknowns(host.admin, staff, failures, logError)).toEqual(new Set([failures[0]!.id, failures[1]!.id]));
    expect(logged).toEqual([]);
  });

  it('resolves a page in ONE batched read, however much unrelated history the log holds', async () => {
    for (let i = 0; i < 1500; i++) raw(ulid(), i % 2 ? 'intent' : 'applied', `noise-${i}`, AT, i % 2 ? {} : { outcome: 'transferred', fromRevoked: true });
    const operationId = ulid();
    raw(ulid(), 'intent', operationId, AT);
    raw(ulid(), 'applied', operationId, AT, { outcome: 'transferred', fromRevoked: true });
    const page = await entriesOf(operationId);
    const batched = vi.spyOn(host.admin, 'auditedOperations');
    const scans = vi.spyOn(host.admin, 'auditLog');
    const annotated = await withAuditedOutcomes(host.admin, staff, page);
    expect(batched).toHaveBeenCalledTimes(1);
    expect(scans).not.toHaveBeenCalled();
    expect(await batched.mock.results[0]!.value).toHaveLength(2);
    expect(annotated.map((r) => r.audited?.outcome)).toEqual(['applied', 'applied']);
    vi.restoreAllMocks();
  });
});

/**
 * The deadline that makes the grace window safe: an audited call that does not answer in
 * `AUDITED_CALL_DEADLINE_MS` is aborted and answered 504, which the routes audit `failed`.
 */
describe('the audited call deadline (#2064)', () => {
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const A = principalId.parse(ulid());
  const B = principalId.parse(ulid());

  it('a vertical that never answers is aborted at the deadline and answered 504; one that answers in time is not', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const hanging = new VerticalClient({
        platformSecret: 'secret',
        fetch: ((_url: string, init?: RequestInit) => {
          signal = init?.signal ?? undefined;
          return new Promise<Response>(() => undefined);
        }) as typeof fetch,
      });
      const call = hanging.transferOwner({ tenantId: t, scopeId: s, from: A, to: B });
      const settled = expect(call).rejects.toMatchObject({ status: 504 });
      await vi.advanceTimersByTimeAsync(AUDITED_CALL_DEADLINE_MS - 1);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(signal?.aborted).toBe(true);

      const prompt = new VerticalClient({
        platformSecret: 'secret',
        fetch: (async () => Response.json({ revoked: ['agent'], unbound: 1, inviteWithdrawn: false })) as unknown as typeof fetch,
      });
      expect(await prompt.removeMember({ tenantId: t, scopeId: s, caller: A, principal: B })).toEqual({ revoked: ['agent'], unbound: 1, inviteWithdrawn: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
