import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, type OrphanSweepReport } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ControlPlaneError, sweepScopeAttachments, VerticalClient } from '../src/index.js';

/**
 * #2314: the control plane's reach for one scope's orphan-attachment pass. The deployment that holds
 * a scope cannot tell it still serves it and a CP-less one cannot read the copy ledger, so every
 * refusal below is decided HERE, from the directory, before any deployment is asked; the twin of
 * each is a scope that passes and reaches exactly the script the directory routes it to.
 */
describe('sweepScopeAttachments (#2314)', () => {
  const staff = platformActorId.parse(ulid());
  const slug = 'sweep-vert';
  let dir: string;
  let host: SqliteScopeHost;
  let t: TenantId;
  let v1: string;
  let ref1: string;

  /** Every call a script was asked, by script. */
  const asked: { ref: string; scopeId: string; dryRun: boolean; copiesSettled: unknown; expectedVersionId?: string }[] = [];
  let answer: (ref: string) => Promise<OrphanSweepReport> = async () => ({ listed: 0, candidates: 0, orphans: 0, deleted: 0, keys: [], dryRun: true });
  const deployment = (ref: string) => ({
    sweepOrphanAttachments: async (input: { scopeId: ScopeId; dryRun: boolean; copiesSettled: true; expectedVersionId: string }) => {
      asked.push({ ref, scopeId: input.scopeId, dryRun: input.dryRun, copiesSettled: input.copiesSettled, expectedVersionId: input.expectedVersionId });
      return answer(ref);
    },
  });
  const reach = () => ({ admin: host.admin, actor: staff, resolveRef: async (ref: string) => deployment(ref) });

  const provision = async (extra: Record<string, unknown> = {}): Promise<ScopeId> => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: slug, ...extra });
    await host.admin.activateScope(staff, t, s);
    await host.admin.bindScopeVersion(staff, t, s, v1);
    return s;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-attachment-sweep-'));
    host = new SqliteScopeHost({ dir });
    t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'sweep-co', name: 'Sweep Co' });
    await host.admin.registerVertical(staff, { slug, name: 'Sweep Vert', source: 'cli', ownerTenant: t });
    v1 = ulid();
    ref1 = `${slug}-${v1.toLowerCase()}`;
    await host.admin.publishVersion(staff, {
      id: v1, verticalSlug: slug, version: '1.0.0', manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g', deploymentRef: ref1,
    });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reaches the bound version's script, with copiesSettled, and hands back its report", async () => {
    const s = await provision();
    asked.length = 0;
    answer = async () => ({ listed: 2, candidates: 1, orphans: 1, deleted: 0, keys: ['k'], dryRun: true });
    const out = await sweepScopeAttachments(reach(), t, s, { dryRun: true });
    expect(out).toEqual({ swept: { listed: 2, candidates: 1, orphans: 1, deleted: 0, keys: ['k'], dryRun: true } });
    expect(asked).toEqual([{ ref: ref1, scopeId: s, dryRun: true, copiesSettled: true, expectedVersionId: v1 }]);
  });

  it('a scope on a serving script reaches that script, not the bound version', async () => {
    const s = await provision();
    await host.admin.setScopeServingRef(staff, t, s, 'sweep-vert-serving');
    asked.length = 0;
    await sweepScopeAttachments(reach(), t, s, { dryRun: false });
    // No serving pointer names that script, so the version that runs there is the bound one.
    expect(asked.map((a) => [a.ref, a.dryRun, a.expectedVersionId])).toEqual([['sweep-vert-serving', false, v1]]);
  });

  describe('refused before any deployment is asked', () => {
    const refusedWithoutCall = async (tenant: TenantId, s: ScopeId, pattern: RegExp) => {
      asked.length = 0;
      const out = await sweepScopeAttachments(reach(), tenant, s, { dryRun: true });
      expect(out).toEqual({ refused: expect.stringMatching(pattern) });
      expect(asked).toEqual([]);
    };

    it('a scope not on record', async () => {
      await refusedWithoutCall(t, scopeId.parse(ulid()), /not on record/);
    });

    it('a scope in another tenant', async () => {
      const s = await provision();
      const other = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: other, slug: `other-${other.toLowerCase()}`, name: 'Other' });
      await refusedWithoutCall(other, s, /not on record/);
    });

    it('an archived scope, and a reaped one', async () => {
      const s = await provision();
      await host.admin.archiveScope(staff, t, s);
      await refusedWithoutCall(t, s, /is archived/);
      await host.admin.reapScope(staff, t, s, { force: true });
      await refusedWithoutCall(t, s, /is reaped/);
    });

    it('a fork and a clean-room preview', async () => {
      const source = await provision();
      await refusedWithoutCall(t, await provision({ forkedFrom: source, forkedAt: new Date().toISOString() }), /is a copy/);
      await refusedWithoutCall(t, await provision({ kind: 'preview' }), /is a copy/);
    });

    it('a scope bound to no vertical', async () => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s });
      await host.admin.activateScope(staff, t, s);
      await refusedWithoutCall(t, s, /no vertical/);
    });

    it('a scope under a suspended tenant', async () => {
      const held = tenantId.parse(ulid());
      await host.admin.createTenant(staff, { id: held, slug: `held-${held.toLowerCase()}`, name: 'Held' });
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: held, scopeId: s, vertical: slug });
      await host.admin.activateScope(staff, held, s);
      await host.admin.bindScopeVersion(staff, held, s, v1);
      await host.admin.setTenantStatus(staff, held, 'suspended');
      await refusedWithoutCall(held, s, /suspended/);
    });

    for (const state of ['pending', 'eligible', 'retained', 'kept'] as const) {
      it(`a scope with a ${state} copy in another script`, async () => {
        const s = await provision();
        const move = ulid();
        await host.admin.recordScopeScriptCopy(staff, t, s, 'sweep-vert-old', move, { role: 'source' });
        if (state !== 'pending') await host.admin.settleScopeScriptCopy(staff, t, s, 'sweep-vert-old', move, state);
        await refusedWithoutCall(t, s, new RegExp(`sweep-vert-old: ${state}`));
      });
    }

    it('… and a done copy is settled: the twin reaches the deployment', async () => {
      const s = await provision();
      const move = ulid();
      await host.admin.recordScopeScriptCopy(staff, t, s, 'sweep-vert-old', move, { role: 'source' });
      await host.admin.settleScopeScriptCopy(staff, t, s, 'sweep-vert-old', move, 'done');
      asked.length = 0;
      expect(await sweepScopeAttachments(reach(), t, s, { dryRun: true })).toHaveProperty('swept');
      expect(asked).toHaveLength(1);
    });

    it('a copy past the first ledger page still refuses', async () => {
      const s = await provision();
      for (let i = 0; i < 100; i++) {
        const move = ulid();
        await host.admin.recordScopeScriptCopy(staff, t, s, `sweep-vert-a${String(i).padStart(3, '0')}`, move, { role: 'source' });
        await host.admin.settleScopeScriptCopy(staff, t, s, `sweep-vert-a${String(i).padStart(3, '0')}`, move, 'done');
      }
      await host.admin.recordScopeScriptCopy(staff, t, s, 'sweep-vert-z', ulid(), { role: 'source' });
      await refusedWithoutCall(t, s, /sweep-vert-z: pending/);
    });

    it('a route whose script cannot be reached: never a fallback to another one', async () => {
      const s = await provision();
      asked.length = 0;
      const out = await sweepScopeAttachments({ ...reach(), resolveRef: async () => undefined }, t, s, { dryRun: true });
      expect(out).toEqual({ refused: expect.stringMatching(/cannot be reached/) });
      expect(asked).toEqual([]);
    });
  });

  describe("the deployment's answer", () => {
    const failing = (err: Error) => ({
      admin: host.admin,
      actor: staff,
      resolveRef: async () => ({ sweepOrphanAttachments: async () => Promise.reject(err) }),
    });

    it('a 501, and a route miss, are a deployment to redeploy, not an error', async () => {
      const s = await provision();
      for (const err of [new ControlPlaneError(501, 'cannot'), new ControlPlaneError(404, 'nope', undefined, { body: '404 Not Found' })]) {
        expect(await sweepScopeAttachments(failing(err), t, s, { dryRun: true })).toEqual({ unsupported: expect.stringMatching(/redeploy/) });
      }
    });

    it('a deployment answering another version than the one routed to (a promote mid-pass) is a refusal, not an error', async () => {
      const s = await provision();
      const promoted = new ControlPlaneError(409, 'refused: this script runs version B, not A, the one the platform routed this pass to');
      expect(await sweepScopeAttachments(failing(promoted), t, s, { dryRun: false })).toEqual({ refused: expect.stringMatching(/runs version B, not A/) });
    });

    it("the deployment's own refusal (a conflict, a JSON not-found) is a refusal", async () => {
      const s = await provision();
      for (const err of [new ControlPlaneError(409, 'is a copy'), new ControlPlaneError(404, 'unknown scope', undefined, { body: '{"error":"unknown scope"}' })]) {
        expect(await sweepScopeAttachments(failing(err), t, s, { dryRun: true })).toEqual({ refused: expect.stringMatching(/copy|unknown/) });
      }
    });

    it('any other failure throws, for the sweep to count', async () => {
      const s = await provision();
      await expect(sweepScopeAttachments(failing(new ControlPlaneError(502, 'unreachable')), t, s, { dryRun: true })).rejects.toThrow(/unreachable/);
      await expect(sweepScopeAttachments(failing(new Error('boom')), t, s, { dryRun: true })).rejects.toThrow(/boom/);
    });
  });
});

describe('VerticalClient.sweepOrphanAttachments (#2314)', () => {
  const s = scopeId.parse(ulid());
  const t = tenantId.parse(ulid());
  const clientAnswering = (status: number, body: unknown, sent: unknown[] = []) =>
    new VerticalClient({
      platformSecret: 'x',
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      },
    });

  it('posts the request as given and parses the report, the no-store marker included', async () => {
    const sent: unknown[] = [];
    const report = { listed: 0, candidates: 0, orphans: 0, deleted: 0, keys: [], dryRun: false, bucket: 'none' };
    expect(await clientAnswering(200, report, sent).sweepOrphanAttachments({ tenantId: t, scopeId: s, dryRun: false, copiesSettled: true, expectedVersionId: 'v9' })).toEqual(report);
    expect(sent).toEqual([{ tenantId: t, scopeId: s, dryRun: false, copiesSettled: true, expectedVersionId: 'v9' }]);
  });

  it('a 200 that is not a report throws rather than reading as a clean pass', async () => {
    await expect(clientAnswering(200, { ok: true }).sweepOrphanAttachments({ tenantId: t, scopeId: s, dryRun: true, copiesSettled: true, expectedVersionId: 'v9' })).rejects.toThrow(/without a report/);
  });
});
