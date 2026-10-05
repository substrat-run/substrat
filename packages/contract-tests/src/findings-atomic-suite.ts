import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
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
 * - A verdict, a rule created and a rule revoked commit with their audit row, or not at all.
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
  });
}
