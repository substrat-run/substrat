import { expect, vi } from 'vitest';
import type { AdminAction, PlatformActorId, ScopeId, TenantId } from '@substrat-run/contracts';
import { UNRECORDED_OUTCOME_LOG, type ScopeHost } from '@substrat-run/kernel';

/**
 * #2089: the fault a kill-switch suite injects to make a switch's OUTCOME row fail — the
 * directory refusing admin-log rows of one phase on one scope, until the returned function
 * lifts it. Each adapter's fixture runs `adminRowFaultSql` against its own directory, so the
 * write fails where production's would: in the store, not in a mocked method.
 */
export interface AdminRowFault {
  refuseAdminRows(scopeId: ScopeId, phase: 'applied' | 'refused' | 'failed'): Promise<() => Promise<void>>;
  refuseSwitchRecord(scopeId: ScopeId, kind: 'system' | 'peer'): Promise<() => Promise<void>>;
}

/** The trigger both adapters' fixtures install, and the statement that drops it. */
export function adminRowFaultSql(scopeId: string, phase: string): { create: string; drop: string } {
  const name = `test_refuse_${phase}_${scopeId.toLowerCase()}`;
  return {
    create: `CREATE TRIGGER ${name} BEFORE INSERT ON _substrat_admin_log
      WHEN NEW.scope_id = '${scopeId}' AND json_extract(NEW.after, '$.phase') = '${phase}'
      BEGIN SELECT RAISE(ABORT, 'the admin log refused the ${phase} row (test fault)'); END`,
    drop: `DROP TRIGGER IF EXISTS ${name}`,
  };
}

/** Reject a switch's directory write before the scope moves, to drive its `failed` outcome. */
export function switchRecordFaultSql(scopeId: string, kind: 'system' | 'peer'): { create: string[]; drop: string[] } {
  const table = kind === 'system' ? '_substrat_system_switches' : '_substrat_peer_switches';
  const name = `test_refuse_${kind}_record_${scopeId.toLowerCase()}`;
  const fault = `SELECT RAISE(ABORT, 'the ${kind} switch record was refused (test fault)')`;
  return {
    create: ['INSERT', 'UPDATE'].map((verb) =>
      `CREATE TRIGGER ${name}_${verb.toLowerCase()} BEFORE ${verb} ON ${table}
       WHEN NEW.scope_id = '${scopeId}' BEGIN ${fault}; END`,
    ),
    drop: ['insert', 'update'].map((verb) => `DROP TRIGGER IF EXISTS ${name}_${verb}`),
  };
}

/** Run `call` with `phase` refused on `scopeId`, capturing the error log; the fault is lifted after. */
export async function withRefusedOutcome<T>(
  fault: AdminRowFault,
  scopeId: ScopeId,
  phase: 'applied' | 'refused' | 'failed',
  call: () => Promise<T>,
): Promise<{ settled: PromiseSettledResult<T>; unrecorded: Record<string, unknown>[] }> {
  const lift = await fault.refuseAdminRows(scopeId, phase);
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const [settled] = await Promise.allSettled([call()]);
    const unrecorded = log.mock.calls
      .filter(([message]) => message === UNRECORDED_OUTCOME_LOG)
      .map(([, fields]) => fields as Record<string, unknown>);
    return { settled: settled!, unrecorded };
  } finally {
    log.mockRestore();
    await lift();
  }
}

/**
 * The admin-log half of the assertion: the operation holds only its intent, the host's settle
 * closes it as `unknown` (the intent's own fields, plus why) with its ops-failure row, and a
 * second settle writes nothing.
 */
export async function expectSettledUnknown(
  host: ScopeHost,
  staff: PlatformActorId,
  where: { tenantId: TenantId; scopeId: ScopeId; action: AdminAction; operationId: string },
  subject: Record<string, unknown>,
): Promise<void> {
  const rows = async () =>
    (await host.admin.auditLog(staff, { tenantId: where.tenantId, scopeId: where.scopeId, action: where.action }))
      .filter((r) => (r.after as { operationId?: string }).operationId === where.operationId);
  const before = await rows();
  expect(before.map((r) => (r.after as { phase: string }).phase)).toEqual(['intent']);
  const error = 'no outcome was recorded (test)';
  expect(await host.admin.settleUnrecordedOutcome(staff, { intentId: before[0]!.id, error })).toBe(true);
  const after = await rows();
  expect(after.map((r) => r.after)).toEqual([
    { ...subject, operationId: where.operationId, phase: 'intent', reason: expect.any(String) },
    { ...subject, operationId: where.operationId, phase: 'unknown', reason: expect.any(String), error },
  ]);
  const failures = (await host.admin.listOpsFailures(staff, { tenantId: where.tenantId, operation: `audit.${where.action}` }))
    .filter((f) => f.reference === where.operationId);
  expect(failures.map((f) => [f.stage, f.scopeId])).toEqual([['outcome-unknown', where.scopeId]]);
  expect(await host.admin.settleUnrecordedOutcome(staff, { intentId: before[0]!.id, error })).toBe(false);
}

/** The twin: the outcome landed, so the settle finds nothing to close. */
export async function expectAnswered(
  host: ScopeHost,
  staff: PlatformActorId,
  where: { tenantId: TenantId; scopeId: ScopeId; action: AdminAction; operationId: string },
  phase: 'applied' | 'refused' | 'failed',
): Promise<void> {
  const rows = (await host.admin.auditLog(staff, { tenantId: where.tenantId, scopeId: where.scopeId, action: where.action }))
    .filter((r) => (r.after as { operationId?: string }).operationId === where.operationId);
  expect(rows.map((r) => (r.after as { phase: string }).phase)).toEqual(['intent', phase]);
  expect(await host.admin.settleUnrecordedOutcome(staff, { intentId: rows[0]!.id, error: 'x' })).toBe(false);
}
