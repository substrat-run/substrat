import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  errorCodeOf,
  instant,
  platformActorId,
  scopeId,
  tenantId,
  type FindingEntry,
  type TenantId,
} from '@substrat-run/contracts';
import { FINDING_RETENTION_DAYS, ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';

/**
 * Findings (#1748) on every adapter: the tenant inbox with a lifecycle. A Recurring finding is
 * the tenant's own projection of an `_substrat_issues` fingerprint; a failed schedule opens an
 * Invariant one and a stale freshness verdict a Drift one. Acknowledge / resolve / reopen are
 * verdicts, suppress is a rule with an expiry, and every one of them is audited. A tenant never
 * sees, counts or moves another tenant's finding — and a quiet open finding is resolved as
 * stale, audited, rather than deleted from under whoever was watching it.
 */
export function findingsContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`findings (#1748): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());
    const ta = tenantId.parse(ulid());
    const tb = tenantId.parse(ulid());
    const sa = scopeId.parse(ulid());
    const sb = scopeId.parse(ulid());
    const V1 = '01JVERSIONFINDINGAAAAAAAA1';
    const V2 = '01JVERSIONFINDINGAAAAAAAA2';

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
    });
    afterAll(async () => {
      await fixture.cleanup();
    });

    /** One ops failure of `operation` for `tenant`, the shape every Recurring test records. */
    const fail = (
      tenant: TenantId | null,
      operation: string,
      opts: { code?: 'unavailable' | 'conflict'; version?: string; message?: string; scope?: string } = {},
    ) =>
      host.admin.recordOpsFailure({
        actor: staff,
        operation,
        stage: 'terminal',
        origin: 'platform',
        code: opts.code ?? 'unavailable',
        tenantId: tenant,
        scopeId: tenant === null ? null : scopeId.parse(opts.scope ?? (tenant === ta ? sa : sb)),
        vertical: 'acme/findings',
        version: opts.version ?? null,
        message: opts.message ?? `${operation} failed`,
      });

    const findingOf = async (tenant: TenantId, operation: string): Promise<FindingEntry | undefined> =>
      (await host.admin.listFindings(staff, { tenantId: tenant, kind: 'recurring' })).find(
        (f) => f.operation === operation,
      );

    describe('the lifecycle', () => {
      it('opens on first sight, acks, resolves, and a fresh occurrence reopens it as regressed', async () => {
        const op = 'deploy.lifecycle';
        await fail(ta, op, { version: V1 });
        const opened = (await findingOf(ta, op))!;
        expect(opened).toMatchObject({
          tenantId: ta,
          kind: 'recurring',
          status: 'open',
          regressed: false,
          count: 1,
          codes: ['unavailable'],
          lastVersion: V1,
          likelyCause: null,
        });

        const acked = await host.admin.setFindingStatus(staff, ta, opened.id, 'acked');
        expect(acked?.status).toBe('acked');
        expect(acked?.acknowledgedAt).not.toBeNull();
        // Acked stays acked on a fresh occurrence: somebody is already on it.
        await fail(ta, op, { version: V1 });
        expect((await findingOf(ta, op))).toMatchObject({ status: 'acked', count: 2 });

        const resolved = await host.admin.setFindingStatus(staff, ta, opened.id, 'resolved');
        expect(resolved).toMatchObject({ status: 'resolved', resolution: 'verdict', resolvedVersion: V1 });

        // Seen again after resolved: back in the inbox, flagged regressed, with the version it
        // came back under named as the likely cause.
        await fail(ta, op, { version: V2 });
        const regressed = (await findingOf(ta, op))!;
        expect(regressed).toMatchObject({ status: 'open', regressed: true, count: 3, lastVersion: V2 });
        expect(regressed.likelyCause).toMatchObject({ kind: 'deploy', version: V2 });
        expect(regressed.likelyCause!.reason).toContain(V1);

        // The next resolve clears the badge; reopening drops the acknowledgement.
        const again = await host.admin.setFindingStatus(staff, ta, opened.id, 'resolved');
        expect(again?.regressed).toBe(false);
        const reopened = await host.admin.setFindingStatus(staff, ta, opened.id, 'open');
        expect(reopened).toMatchObject({ status: 'open', acknowledgedAt: null });
      });

      it('names no likely cause when the finding came back under the version it was resolved under', async () => {
        const op = 'deploy.same-version';
        await fail(ta, op, { version: V1 });
        const f = (await findingOf(ta, op))!;
        await host.admin.setFindingStatus(staff, ta, f.id, 'resolved');
        await fail(ta, op, { version: V1 });
        expect(await findingOf(ta, op)).toMatchObject({ status: 'open', regressed: true, likelyCause: null });
      });

      it('audits every verdict with the tenant and the before/after status', async () => {
        const op = 'deploy.audited';
        await fail(ta, op);
        const f = (await findingOf(ta, op))!;
        await host.admin.setFindingStatus(staff, ta, f.id, 'acked');
        const [row] = await host.admin.auditLog(staff, { tenantId: ta, action: 'setFindingStatus', order: 'desc', limit: 1 });
        expect(row).toMatchObject({
          actor: staff,
          tenantId: ta,
          before: { id: f.id, status: 'open' },
          after: { id: f.id, status: 'acked' },
        });
      });
    });

    describe('tenant isolation', () => {
      it('counts, reads and moves each tenant’s finding apart, while the fleet issue sums both', async () => {
        const op = 'intent.connector:shared';
        await fail(ta, op, { message: 'tenant A secret prose 01JAAAAAAAAAAAAAAAAAAAAAAA' });
        await fail(ta, op);
        await fail(tb, op, { message: 'tenant B text' });

        const a = (await findingOf(ta, op))!;
        const b = (await findingOf(tb, op))!;
        // Same fingerprint, two findings: the count is the tenant's own, never the fleet's.
        expect(a.subject).toBe(b.subject);
        expect(a.id).not.toBe(b.id);
        expect(a.count).toBe(2);
        expect(b.count).toBe(1);
        const [issue] = await host.admin.listIssues(staff, { operation: op });
        expect(issue!.count).toBe(3);

        // A tenant's read carries nothing of the other tenant: not its id, its scope, or the
        // free text of its failures. A finding carries no evidence text at all.
        const bRead = await host.admin.listFindings(staff, { tenantId: tb });
        const serialized = JSON.stringify(bRead);
        expect(bRead.every((f) => f.tenantId === tb)).toBe(true);
        expect(serialized).not.toContain(ta);
        expect(serialized).not.toContain(sa);
        expect(serialized).not.toContain('tenant A secret prose');
        expect(serialized).not.toContain('tenant B text');
        expect(serialized).not.toContain(staff);

        // B cannot move A's finding by its id: unknown to B, and A's is untouched.
        expect(await host.admin.setFindingStatus(staff, tb, a.id, 'resolved')).toBeUndefined();
        expect((await findingOf(ta, op))!.status).toBe('open');
        // Resolving B's leaves A's open.
        await host.admin.setFindingStatus(staff, tb, b.id, 'resolved');
        expect((await findingOf(ta, op))!.status).toBe('open');
        expect((await findingOf(tb, op))!.status).toBe('resolved');
      });

      it('opens no finding for a failure that belongs to no tenant', async () => {
        const op = 'platform.only';
        await fail(null, op);
        expect(await host.admin.listIssues(staff, { operation: op })).toHaveLength(1);
        const fleet = await host.admin.listFindings(staff, { limit: 500 });
        expect(fleet.some((f) => f.operation === op)).toBe(false);
      });

      it('keeps a tenant’s rules to that tenant', async () => {
        const op = 'deploy.rule-isolation';
        await fail(ta, op);
        await fail(tb, op);
        const { rule } = await host.admin.createFindingRule(staff, ta, {
          operation: op,
          expiresAt: instant.parse(new Date(Date.now() + 86_400_000).toISOString()),
          reason: 'known flake',
        });
        // A's rule suppresses A's finding and leaves B's alone.
        expect((await findingOf(ta, op))!.status).toBe('suppressed');
        expect((await findingOf(tb, op))!.status).toBe('open');
        await fail(tb, op);
        expect((await findingOf(tb, op))!.status).toBe('open');
        // B neither sees nor revokes A's rule.
        expect((await host.admin.listFindingRules(staff, tb)).some((r) => r.id === rule.id)).toBe(false);
        expect(await host.admin.revokeFindingRule(staff, tb, rule.id)).toBeUndefined();
        expect((await host.admin.listFindingRules(staff, ta, { active: true })).some((r) => r.id === rule.id)).toBe(true);
      });
    });

    describe('suppress rules', () => {
      const inADay = () => instant.parse(new Date(Date.now() + 86_400_000).toISOString());

      it('suppresses what it covers now, still counts later occurrences, and audits the rule', async () => {
        const op = 'deploy.suppressed';
        await fail(ta, op, { code: 'conflict' });
        const { rule, suppressed } = await host.admin.createFindingRule(staff, ta, {
          code: 'conflict',
          operation: op,
          expiresAt: inADay(),
          reason: 'expected during the migration',
        });
        expect(suppressed).toBe(1);
        expect((await findingOf(ta, op))).toMatchObject({ status: 'suppressed', ruleId: rule.id, count: 1 });

        // Recorded, but no finding opens.
        await fail(ta, op, { code: 'conflict' });
        expect((await findingOf(ta, op))).toMatchObject({ status: 'suppressed', ruleId: rule.id, count: 2 });

        const [row] = await host.admin.auditLog(staff, { tenantId: ta, action: 'createFindingRule', order: 'desc', limit: 1 });
        expect(row).toMatchObject({ actor: staff, tenantId: ta, after: { rule: { id: rule.id }, suppressed: 1 } });
      });

      it('covers only what it names: another operation, or another code, still opens', async () => {
        const op = 'deploy.narrow';
        await host.admin.createFindingRule(staff, ta, { operation: op, code: 'conflict', expiresAt: inADay(), reason: 'narrow' });
        await fail(ta, op, { code: 'unavailable' });
        await fail(ta, 'deploy.narrow-other', { code: 'conflict' });
        expect((await findingOf(ta, op))!.status).toBe('open');
        expect((await findingOf(ta, 'deploy.narrow-other'))!.status).toBe('open');
      });

      it('suppresses a NEW finding it covers from its first occurrence', async () => {
        const op = 'deploy.born-suppressed';
        await host.admin.createFindingRule(staff, ta, { operation: op, expiresAt: inADay(), reason: 'pre-emptive' });
        await fail(ta, op);
        expect((await findingOf(ta, op))!.status).toBe('suppressed');
      });

      it('lets a revoked rule go: the next occurrence opens the finding, and the revoke is audited', async () => {
        const op = 'deploy.revoked';
        await fail(ta, op);
        const { rule } = await host.admin.createFindingRule(staff, ta, { operation: op, expiresAt: inADay(), reason: 'temp' });
        expect((await findingOf(ta, op))!.status).toBe('suppressed');
        const revoked = await host.admin.revokeFindingRule(staff, ta, rule.id);
        expect(revoked!.expiresAt <= new Date().toISOString()).toBe(true);
        expect((await host.admin.listFindingRules(staff, ta, { active: true })).some((r) => r.id === rule.id)).toBe(false);
        await fail(ta, op);
        expect((await findingOf(ta, op))).toMatchObject({ status: 'open', ruleId: null, count: 2 });
        const [row] = await host.admin.auditLog(staff, { tenantId: ta, action: 'revokeFindingRule', order: 'desc', limit: 1 });
        expect(row).toMatchObject({ before: { id: rule.id }, after: { id: rule.id } });
      });

      it('refuses a rule that expires in the past, or past the longest suppression, as validation_failed', async () => {
        // The code, not only the words: the HTTP surface maps it to a 400, and on a host whose
        // store sits behind an RPC hop it survives only if the refusal happens before the hop.
        const refusal = async (expiresAt: string) => {
          try {
            await host.admin.createFindingRule(staff, ta, { operation: 'x', expiresAt: instant.parse(expiresAt), reason: 'r' });
          } catch (e) {
            return { code: errorCodeOf(e), message: (e as Error).message };
          }
          throw new Error('the rule was created');
        };
        expect(await refusal(new Date(Date.now() - 1000).toISOString())).toMatchObject({
          code: 'validation_failed',
          message: expect.stringMatching(/future/),
        });
        expect(await refusal(new Date(Date.now() + 91 * 86_400_000).toISOString())).toMatchObject({
          code: 'validation_failed',
          message: expect.stringMatching(/at most 90 days/),
        });
      });
    });

    describe('the `_substrat_issues` mapping', () => {
      it('maps new → open, regressed → open + regressed, resolved → resolved, ignored → suppressed', async () => {
        const op = 'deploy.mapping';
        await fail(ta, op);
        const [issue] = await host.admin.listIssues(staff, { operation: op });
        const f = (await findingOf(ta, op))!;
        // One fingerprint, one subject; the evidence walks to the tenant's own exemplars.
        expect(issue!.status).toBe('new');
        expect(f.status).toBe('open');
        expect(f.subject).toBe(issue!.fingerprint);
        expect(f.evidence).toEqual({ source: 'ops-failures', fingerprint: issue!.fingerprint });
        const exemplars = await host.admin.listOpsFailures(staff, { tenantId: ta, fingerprint: issue!.fingerprint });
        expect(exemplars.length).toBe(1);

        // resolved → resolved, and the same fresh arrival regresses both.
        await host.admin.setIssueStatus(staff, issue!.fingerprint, 'resolved');
        await host.admin.setFindingStatus(staff, ta, f.id, 'resolved');
        await fail(ta, op);
        const [regressedIssue] = await host.admin.listIssues(staff, { operation: op });
        expect(regressedIssue!.status).toBe('regressed');
        expect(await findingOf(ta, op)).toMatchObject({ status: 'open', regressed: true });

        // ignored → suppressed: a fresh arrival changes neither.
        await host.admin.setIssueStatus(staff, issue!.fingerprint, 'ignored');
        await host.admin.createFindingRule(staff, ta, {
          subject: f.subject,
          expiresAt: instant.parse(new Date(Date.now() + 86_400_000).toISOString()),
          reason: 'ignored',
        });
        await fail(ta, op);
        const [ignored] = await host.admin.listIssues(staff, { operation: op });
        expect(ignored!.status).toBe('ignored');
        expect((await findingOf(ta, op))!.status).toBe('suppressed');
      });
    });

    describe('the Invariant and Drift sources', () => {
      it('opens an Invariant finding for a failed schedule, and none for one that ran', async () => {
        const unit = `${sa}:findings/nightly`;
        const run = (outcome: 'ok' | 'failed') =>
          host.admin.recordSweepRun({
            kind: 'schedule',
            unit,
            outcome,
            tenantId: ta,
            scopeId: sa,
            operation: 'findings/nightly',
            error: outcome === 'failed' ? 'handler threw: secret detail' : null,
          });
        await run('ok');
        expect((await host.admin.listFindings(staff, { tenantId: ta, kind: 'invariant' })).some((f) => f.subject === unit)).toBe(false);
        await run('failed');
        await run('failed');
        const [f] = (await host.admin.listFindings(staff, { tenantId: ta, kind: 'invariant' })).filter((x) => x.subject === unit);
        expect(f).toMatchObject({
          status: 'open',
          severity: 'critical',
          count: 2,
          operation: 'findings/nightly',
          evidence: { source: 'sweep-runs', kind: 'schedule', unit },
        });
        expect(JSON.stringify(f)).not.toContain('secret detail');
      });

      it('opens a Drift finding for a stale freshness verdict', async () => {
        const unit = `${sa}:findings.thing-happened`;
        await host.admin.recordSweepRun({
          kind: 'freshness',
          unit,
          outcome: 'failed',
          tenantId: ta,
          scopeId: sa,
          eventType: 'findings.thing-happened',
        });
        const [f] = (await host.admin.listFindings(staff, { tenantId: ta, kind: 'drift' })).filter((x) => x.subject === unit);
        expect(f).toMatchObject({ status: 'open', severity: 'warning', title: 'findings.thing-happened has gone stale' });
      });

      it('counts a replayed drain once', async () => {
        const unit = `${sa}:findings/replayed`;
        const requestId = ulid();
        for (let i = 0; i < 2; i++) {
          await host.admin.recordSweepRun({
            kind: 'schedule',
            unit,
            outcome: 'failed',
            tenantId: ta,
            scopeId: sa,
            operation: 'findings/replayed',
            requestId,
          });
        }
        const [f] = (await host.admin.listFindings(staff, { tenantId: ta, kind: 'invariant' })).filter((x) => x.subject === unit);
        expect(f!.count).toBe(1);
      });
    });

    describe('retention', () => {
      const longAgo = () => instant.parse(new Date(Date.now() - (FINDING_RETENTION_DAYS + 10) * 86_400_000).toISOString());

      it('resolves a quiet open finding as stale, audited, and deletes a quiet suppressed one', async () => {
        const quiet = `${sb}:findings/quiet`;
        const hidden = `${sb}:findings/hidden`;
        await host.admin.createFindingRule(staff, tb, {
          subject: hidden,
          expiresAt: instant.parse(new Date(Date.now() + 86_400_000).toISOString()),
          reason: 'retention fixture',
        });
        for (const unit of [quiet, hidden]) {
          await host.admin.recordSweepRun({
            kind: 'schedule',
            unit,
            outcome: 'failed',
            tenantId: tb,
            scopeId: sb,
            operation: unit.split(':')[1]!,
            at: longAgo(),
          });
        }
        const before = await host.admin.listFindings(staff, { tenantId: tb, kind: 'invariant' });
        expect(before.find((f) => f.subject === quiet)!.status).toBe('open');
        expect(before.find((f) => f.subject === hidden)!.status).toBe('suppressed');

        const report = await host.admin.pruneFindings!(staff, 500);
        expect(report.staled).toBeGreaterThanOrEqual(1);
        expect(report.deleted).toBeGreaterThanOrEqual(1);

        const after = await host.admin.listFindings(staff, { tenantId: tb, kind: 'invariant' });
        const stale = after.find((f) => f.subject === quiet)!;
        // Not deleted: resolved as stale, and kept readable for one more window.
        expect(stale).toMatchObject({ status: 'resolved', resolution: 'stale' });
        expect(after.some((f) => f.subject === hidden)).toBe(false);

        const audit = await host.admin.auditLog(staff, { tenantId: tb, action: 'resolveStaleFinding' });
        expect(audit.find((r) => (r.after as { id: string }).id === stale.id)).toMatchObject({
          actor: staff,
          tenantId: tb,
          before: { id: stale.id, status: 'open' },
          after: { id: stale.id, status: 'resolved', resolution: 'stale' },
        });

        // A second pass changes nothing: the stale-resolved finding's resolve is recent.
        await host.admin.pruneFindings!(staff, 500);
        expect((await host.admin.listFindings(staff, { tenantId: tb, kind: 'invariant' })).find((f) => f.id === stale.id)).toBeDefined();
      });
    });
  });
}
