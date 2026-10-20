import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { runPlatformSweep, StorageReadUnsupported, ulid, type FetchLike } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #2212: what `/meters` shows once the storage sweep has recorded a store read. A deployment that
 * predates the store route answers it as unsupported, which is a standing condition, not a
 * failure and not a size of 0 (RFC L13): its scopes keep their database sample and do not show
 * as failing. Every scope of a vertical pushed before the route would otherwise show failing.
 */
describe('a store read on /meters (#2212)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const meterAfterSweep = async (readStores: () => Promise<{ binding: string; bytes: number }[]>) => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-gauge-stores-'));
    dirs.push(dir);
    const host = new SqliteScopeHost({ dir });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `gauge-${t.toLowerCase()}`, name: 'Gauge' });
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    const report = await runPlatformSweep(host, {
      actor: staff,
      fetch: (() => Promise.reject(new Error('unused'))) as unknown as FetchLike,
      sweepers: {},
      drainRetries: false,
      drainPlatformRequestsFn: async () => ({ drained: 0, done: 0, failed: 0, pending: 0, attempted: [] }),
      storageGauge: { read: async () => 5, readStores },
    });
    const storage = (await host.admin.readMeters(staff, { tenantId: t })).perTenant[0]!.storage;
    await host.close();
    return { storage, report: report.storage };
  };

  it('an unsupported store read keeps the database sample and is not failing', async () => {
    const { storage, report } = await meterAfterSweep(async () => {
      throw new StorageReadUnsupported("vertical 'docs' cannot read scope store sizes (501); redeploy it");
    });
    expect(storage).toMatchObject({ bytes: 5, sampled: 1, failing: 0, lastFailedAt: null });
    expect(storage?.stores).toBeUndefined();
    expect(report).toMatchObject({ read: 1, failed: 0, unsupported: 1 });
  });

  it('a store read that fails keeps the database sample and is failing', async () => {
    const { storage, report } = await meterAfterSweep(async () => {
      throw new Error('store down');
    });
    expect(storage).toMatchObject({ bytes: 5, sampled: 1, failing: 1 });
    expect(storage?.stores).toBeUndefined();
    expect(report).toMatchObject({ read: 0, failed: 1, unsupported: 0 });
  });

  it('a store read that answers is on the gauge beside the database', async () => {
    const { storage } = await meterAfterSweep(async () => [{ binding: 'GRAPH', bytes: 11 }]);
    expect(storage).toMatchObject({ bytes: 5, sampled: 1, failing: 0, stores: { bytes: 11, sampled: 1 } });
  });
});
