import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid, type CrossingInput, type DirectoryObjects } from '@substrat-run/kernel';

/**
 * K-68 (directory split), rfc/tenant-scale.md §11: the END STATE of a change that crosses two
 * directory objects is the same on every adapter. On Cloudflare the crossing commits in the tenant's
 * object, claims and confirms in the registry, and settles back, each its own transaction; on
 * `adapter-sqlite` all of it is one database and one transaction. This suite holds what a reader can
 * observe afterwards, never the steps. The steps — a crash between two commits, and a retry — are
 * the Cloudflare adapter's own fault-injection suite (`test/directory-objects.test.ts`).
 *
 * Step 3a: the seam is exercised directly; no `HostAdmin` path is wired onto it yet.
 */
export interface DirectoryCrossingFixture {
  objects: DirectoryObjects;
  cleanup?: () => Promise<void>;
}

export function directoryCrossingContractSuite(adapterName: string, makeFixture: () => Promise<DirectoryCrossingFixture>): void {
  describe(`directory crossing end state (K-68): ${adapterName}`, () => {
    let fixture: DirectoryCrossingFixture;
    let objects: DirectoryObjects;
    beforeAll(async () => {
      fixture = await makeFixture();
      objects = fixture.objects;
    });
    afterAll(async () => {
      await fixture?.cleanup?.();
    });

    const tenantA = ulid();
    const tenantB = ulid();
    /** A hostname bind for `holder`, on a hostname no other test uses. */
    const bind = (holder: string, hostname: string, leaseMs = 60_000): CrossingInput => ({
      crossingId: ulid(), kind: 'hostname-bind', namespace: 'hostname', key: hostname, holder, scopeId: ulid(), leaseMs,
    });
    const hostname = () => `${ulid().toLowerCase()}.example.test`;

    it('a completed bind leaves the crossing done and the hostname confirmed to its tenant and scope', async () => {
      const ledger = objects.tenant(tenantA);
      const input = bind(tenantA, hostname());
      await ledger.recordCrossing(input);
      expect(await objects.complete(ledger, input.crossingId)).toMatchObject({ state: 'done', outcome: null });
      expect(await objects.registry().readClaim('hostname', input.key)).toMatchObject({
        claimId: input.crossingId, holder: tenantA, scopeId: input.scopeId, state: 'confirmed', leaseUntil: null,
      });
      expect(await objects.complete(ledger, input.crossingId)).toMatchObject({ state: 'done' });
    });

    it('two tenants binding one hostname at once leave exactly one bound, and the other told who holds it', async () => {
      const name = hostname();
      const a = objects.tenant(tenantA);
      const b = objects.tenant(tenantB);
      const ia = bind(tenantA, name);
      const ib = bind(tenantB, name);
      await Promise.all([a.recordCrossing(ia), b.recordCrossing(ib)]);
      const [ea, eb] = await Promise.all([objects.complete(a, ia.crossingId), objects.complete(b, ib.crossingId)]);
      expect([ea.state, eb.state].sort()).toEqual(['done', 'failed']);
      const winner = ea.state === 'done' ? tenantA : tenantB;
      expect((ea.state === 'failed' ? ea : eb).outcome).toBe(`held by ${winner}`);
      expect(await objects.registry().readClaim('hostname', name)).toMatchObject({ holder: winner, state: 'confirmed' });
    });

    it('a crossing whose lease ran out before its confirm ends failed and leaves the hostname free', async () => {
      const ledger = objects.tenant(tenantA);
      const input = bind(tenantA, hostname(), 0);
      await ledger.recordCrossing(input);
      expect(await objects.complete(ledger, input.crossingId)).toMatchObject({ state: 'failed', outcome: 'expired' });
      expect(await objects.registry().readClaim('hostname', input.key)).toBeNull();
    });

    it('a reaped tenant’s id, kept as a tombstone, is never claimed again', async () => {
      const reaped = ulid();
      const registry = objects.registry();
      const create = { ...bind(reaped, reaped), kind: 'tenant-create', namespace: 'tenant-id' as const, scopeId: null };
      await registry.recordCrossing(create);
      expect(await objects.complete(registry, create.crossingId)).toMatchObject({ state: 'done' });
      expect(await registry.releaseClaim({ namespace: 'tenant-id', key: reaped, claimId: create.crossingId, tombstone: true })).toEqual({ released: true });

      const again = { ...create, crossingId: ulid() };
      await registry.recordCrossing(again);
      expect(await objects.complete(registry, again.crossingId)).toMatchObject({ state: 'failed', outcome: `tombstone of ${reaped}` });
    });

    it('a tenant’s ledger never answers another tenant’s crossing', async () => {
      const input = bind(tenantA, hostname());
      await objects.tenant(tenantA).recordCrossing(input);
      expect(await objects.tenant(tenantB).crossing(input.crossingId)).toBeNull();
      expect(await objects.tenant(tenantA).crossing(input.crossingId)).toMatchObject({ crossingId: input.crossingId, holder: tenantA });
    });
  });
}
