import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ControlPlaneError, UNRECORDED_OUTCOME_LOG, auditedChange, settleUnrecordedOutcomes, type AuditedRow } from '../src/index.js';

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

  it('an intent older than the lookback is not read; a write that fails leaves the intent open for the next pass', async () => {
    const old = ulid();
    await host.admin.recordOwnerTransfer(staff, { tenantId: t, scopeId: s, operationId: old, from: A, to: B, phase: 'intent' });
    expect(
      (await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: later(9 * 24 * HOUR) })).settled,
    ).toEqual([]);

    vi.spyOn(host.admin, 'recordOwnerTransfer').mockRejectedValueOnce(new Error('log down'));
    const pass = await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: later(2 * HOUR) });
    expect(pass.settled).toEqual([]);
    expect(pass.errors).toEqual([{ operationId: old, error: 'log down' }]);
    expect((await rowsOf('transferOwner', old)).map((r) => r.phase)).toEqual(['intent']);
    // With the log back, the next pass closes it.
    const next = await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: later(2 * HOUR) });
    expect(next.settled.map((x) => x.operationId)).toEqual([old]);
  });
});
