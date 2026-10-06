import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { instant, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { FINDING_RETENTION_DAYS, ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';

/**
 * Raw SQL on the adapter's directory store — the one thing this suite needs that the seam does
 * not offer. It installs and drops the fault triggers below, nothing else.
 */
export type DirectoryExec = (host: ScopeHost, sql: string) => Promise<void>;

/**
 * Findings (#1748): what is written together stays together, on every adapter.
 *
 * - The evidence and the finding it implies commit as one unit. A detector that fails takes the
 *   evidence with it, so the caller's retry — or a drain's replay under the same request id —
 *   writes both, rather than finding the evidence already there and the observation lost.
 * - A verdict, a rule created and a rule revoked commit with their audit row, or not at all
 *   — and so does a stale resolution in `pruneFindings`.
 *
 * The failures are injected by SQLite triggers on the directory, the one fault both stores
 * raise the same way, and each is dropped before the retry.
 */
export function findingsAtomicContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
  exec: DirectoryExec,
): void {
  describe(`findings commit with their evidence and their audit (#1748): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
    });
    afterAll(async () => {
      await fixture.cleanup();
    });

    /** Fail every write to `table` (optionally only rows matching `when`) until `heal`. */
    const fault = async (name: string, table: string, op: 'INSERT' | 'UPDATE', when = '1') => {
      await exec(
        host,
        `CREATE TRIGGER ${name} BEFORE ${op} ON ${table} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'injected fault'); END`,
      );
      return () => exec(host, `DROP TRIGGER ${name}`);
    };
    const findingsOf = async (kind: 'recurring' | 'invariant', subject: (s: string) => boolean) =>
      (await host.admin.listFindings(staff, { tenantId: t, kind })).filter((f) => subject(f.subject));

    it('a failed observation takes the sweep row with it, and the replay writes both once', async () => {
      const unit = `${s}:atomic/replayed`;
      const requestId = ulid();
      const run = () =>
        host.admin.recordSweepRun({
          kind: 'schedule',
          unit,
          outcome: 'failed',
          tenantId: t,
          scopeId: s,
          operation: 'atomic/replayed',
          requestId,
        });
      const heal = await fault('fault_finding_insert', '_substrat_findings', 'INSERT', `NEW.tenant_id = '${t}'`);
      await expect(run()).rejects.toThrow(/injected fault/);
      expect(await host.admin.listSweepRuns(staff, { unit })).toHaveLength(0);
      await heal();

      await run();
      await run(); // the drain replays again: the unique index ignores it, and nothing is counted twice
      expect(await host.admin.listSweepRuns(staff, { unit })).toHaveLength(1);
      const found = await findingsOf('invariant', (x) => x === unit);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ status: 'open', count: 1 });
    });

    it('a failed observation takes the ops failure and its issue with it, and the retry writes all three', async () => {
      const operation = 'atomic.ops';
      const record = () => host.admin.recordOpsFailure({ actor: staff, operation, tenantId: t, scopeId: s, message: 'x' });
      const heal = await fault('fault_finding_insert_ops', '_substrat_findings', 'INSERT', `NEW.tenant_id = '${t}'`);
      await expect(record()).rejects.toThrow(/injected fault/);
      expect(await host.admin.listOpsFailures(staff, { operation })).toHaveLength(0);
      expect(await host.admin.listIssues(staff, { operation })).toHaveLength(0);
      await heal();

      await record();
      expect(await host.admin.listOpsFailures(staff, { operation })).toHaveLength(1);
      const [issue] = await host.admin.listIssues(staff, { operation });
      expect(issue!.count).toBe(1);
      const found = await findingsOf('recurring', (x) => x === issue!.fingerprint);
      expect(found).toHaveLength(1);
      expect(found[0]!.count).toBe(1);
    });

    describe('an audit write that fails takes its mutation with it', () => {
      const failAudit = (action: string) =>
        fault(`fault_audit_${action}`, '_substrat_admin_log', 'INSERT', `NEW.action = '${action}'`);
      const inADay = () => instant.parse(new Date(Date.now() + 86_400_000).toISOString());
      const opened = async (operation: string) => {
        await host.admin.recordOpsFailure({ actor: staff, operation, tenantId: t, scopeId: s, message: 'x' });
        return (await host.admin.listFindings(staff, { tenantId: t })).find((f) => f.operation === operation)!;
      };

      it('a verdict', async () => {
        const f = await opened('atomic.verdict');
        const heal = await failAudit('setFindingStatus');
        await expect(host.admin.setFindingStatus(staff, t, f.id, 'resolved')).rejects.toThrow(/injected fault/);
        await heal();
        expect((await host.admin.listFindings(staff, { tenantId: t })).find((x) => x.id === f.id)!.status).toBe('open');
        // The twin: with the audit writable, the same verdict lands with its row.
        await host.admin.setFindingStatus(staff, t, f.id, 'resolved');
        const rows = await host.admin.auditLog(staff, { tenantId: t, action: 'setFindingStatus' });
        expect(rows.filter((r) => (r.after as { id: string }).id === f.id)).toHaveLength(1);
      });

      it('a rule created, and the findings it would have suppressed', async () => {
        const f = await opened('atomic.rule');
        const heal = await failAudit('createFindingRule');
        await expect(
          host.admin.createFindingRule(staff, t, { operation: 'atomic.rule', expiresAt: inADay(), reason: 'r' }),
        ).rejects.toThrow(/injected fault/);
        await heal();
        expect(await host.admin.listFindingRules(staff, t)).toHaveLength(0);
        expect((await host.admin.listFindings(staff, { tenantId: t })).find((x) => x.id === f.id)!.status).toBe('open');
      });

      it('a rule revoked', async () => {
        const { rule } = await host.admin.createFindingRule(staff, t, {
          operation: 'atomic.revoke',
          expiresAt: inADay(),
          reason: 'r',
        });
        const heal = await failAudit('revokeFindingRule');
        await expect(host.admin.revokeFindingRule(staff, t, rule.id)).rejects.toThrow(/injected fault/);
        await heal();
        expect((await host.admin.listFindingRules(staff, t, { active: true })).map((r) => r.id)).toContain(rule.id);
      });

      it('a stale resolution', async () => {
        const unit = `${s}:atomic/quiet`;
        await host.admin.recordSweepRun({
          kind: 'schedule',
          unit,
          outcome: 'failed',
          tenantId: t,
          scopeId: s,
          operation: 'atomic/quiet',
          at: instant.parse(new Date(Date.now() - (FINDING_RETENTION_DAYS + 10) * 86_400_000).toISOString()),
        });
        const heal = await failAudit('resolveStaleFinding');
        await expect(host.admin.pruneFindings!(staff, 500)).rejects.toThrow(/injected fault/);
        await heal();
        expect((await findingsOf('invariant', (x) => x === unit))[0]!.status).toBe('open');
      });
    });
  });
}
