import { describe, expect, it } from 'vitest';
import { platformActorId, tenantId, type PlatformActorId, type TenantId } from '@substrat-run/contracts';
import { ACCESS_SUMMARY_METHOD, ulid, type ScopeHost } from '@substrat-run/kernel';

/** K-73: what the access-summary suite needs of an adapter. */
export interface AccessSummaryFixture {
  host: ScopeHost;
  cleanup(): Promise<void>;
}

const newTenant = async (host: ScopeHost, staff: PlatformActorId): Promise<TenantId> => {
  const t = tenantId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: `sum-${t.toLowerCase()}`, name: 'Access summary test' });
  return t;
};

/** The access rows `actor` left, read as a third actor so the read itself is not among them. */
const rowsOf = async (host: ScopeHost, actor: PlatformActorId) =>
  host.admin.accessLog(platformActorId.parse(ulid()), { actor });

/**
 * K-73 (amends K-24; #3326): the platform's bookkeeping reads, one access-log row per pass, on both
 * adapters. While a summary is open for an actor, its reads write nothing and the flush writes one
 * row naming what was read; anyone else's reads are recorded exactly as before.
 */
export function accessSummaryContractSuite(adapterName: string, makeFixture: () => Promise<AccessSummaryFixture>): void {
  describe(`access summary for the platform's own reads (K-73) [${adapterName}]`, () => {
    it('folds a summarized actor into one row at the outermost flush, and records anyone else as before', async () => {
      const { host, cleanup } = await makeFixture();
      const sweep = platformActorId.parse(ulid());
      const staff = platformActorId.parse(ulid());
      try {
        const a = await newTenant(host, staff);
        const b = await newTenant(host, staff);

        await host.admin.summarizeAccess!(sweep);
        await host.admin.summarizeAccess!(sweep); // nested, as runPlatformSweep inside the scheduled pass
        await host.admin.getTenant(sweep, a);
        await host.admin.getTenant(sweep, b);
        await host.admin.getTenant(sweep, a);
        await host.admin.listTenants(sweep);
        await host.admin.getTenant(staff, a); // a person's read, during the summary
        await expect(() => host.admin.summarizeAccess!(staff)).rejects.toThrow(/already summarizing/);

        expect(await host.admin.flushAccessSummary!(sweep)).toBeNull(); // the inner level
        expect(await rowsOf(host, sweep)).toEqual([]);
        expect((await rowsOf(host, staff)).map((r) => [r.method, r.tenantId])).toEqual([['getTenant', a]]);

        const result = await host.admin.flushAccessSummary!(sweep);
        expect(result).toMatchObject({ reads: 4, methods: 2, tenants: 2 });
        const rows = await rowsOf(host, sweep);
        expect(rows.map((r) => [r.method, r.tenantId, r.scopeId])).toEqual([[ACCESS_SUMMARY_METHOD, null, null]]);
        const params = JSON.parse(rows[0]!.params!);
        expect(params).toMatchObject({ reads: { getTenant: 3, listTenants: 1 }, tenants: 2, since: expect.any(String) });

        // Closed: the actor's next read is its own row again.
        await host.admin.getTenant(sweep, a);
        expect((await rowsOf(host, sweep)).map((r) => r.method).sort()).toEqual([ACCESS_SUMMARY_METHOD, 'getTenant'].sort());
      } finally {
        await cleanup();
      }
    });

    it('writes nothing for a summary that read nothing', async () => {
      const { host, cleanup } = await makeFixture();
      const sweep = platformActorId.parse(ulid());
      try {
        await host.admin.summarizeAccess!(sweep);
        expect(await host.admin.flushAccessSummary!(sweep)).toBeNull();
        expect(await rowsOf(host, sweep)).toEqual([]);
      } finally {
        await cleanup();
      }
    });
  });
}
