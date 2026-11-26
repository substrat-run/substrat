import { describe, expect, it } from 'vitest';
import { platformActorId, tenantId, type PlatformActorId, type TenantId } from '@substrat-run/contracts';
import { DIRECTORY_LAKE_DATASET_NAMES, ulid, type DirectoryLakeRow, type ScopeHost } from '@substrat-run/kernel';

/** K-70: what the directory-outbox suite needs of an adapter. */
export interface DirectoryLakeFixture {
  host: ScopeHost;
  cleanup(): Promise<void>;
}

const newTenant = async (host: ScopeHost, staff: PlatformActorId): Promise<TenantId> => {
  const t = tenantId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: `lake-${t.toLowerCase()}`, name: 'Directory lake test' });
  return t;
};

/** Every queued row, oldest first. The directory may be shared with other files, so cases filter. */
const queued = async (host: ScopeHost, staff: PlatformActorId): Promise<DirectoryLakeRow[]> =>
  host.admin.directoryOutbox!(staff, 10_000);

/**
 * K-70 (tenants × time data leaves the objects): the directory's outbox to the lake holds on both
 * adapters. Capture is off until switched on, a captured row is queued in the same transaction as
 * the change that wrote it, and only rows the caller confirms leave the outbox. Every case switches
 * capture off again, because a hosted directory is shared by the files of one run.
 */
export function directoryLakeContractSuite(adapterName: string, makeFixture: () => Promise<DirectoryLakeFixture>): void {
  describe(`directory outbox to the lake (K-70) [${adapterName}]`, () => {
    it('queues nothing while off; switched on, queues each admin row with its change, and acks only what it is told', async () => {
      const { host, cleanup } = await makeFixture();
      const staff = platformActorId.parse(ulid());
      try {
        const before = await newTenant(host, staff);
        expect((await queued(host, staff)).filter((r) => r.tenantId === before)).toEqual([]);

        const on = await host.admin.setDirectoryLakeCapture!(staff, ['admin_log']);
        expect(on.enabled).toEqual(['admin_log']);
        expect(on.current.map((c) => c.dataset)).toEqual(['admin_log']);
        const t = await newTenant(host, staff);

        const [created] = await host.admin.auditLog(staff, { tenantId: t, action: 'createTenant' });
        const rows = await queued(host, staff);
        const mine = rows.filter((r) => r.tenantId === t);
        expect(mine.map((r) => [r.dataset, r.rowKey, r.kind])).toEqual([['admin_log', created!.id, 'createTenant']]);
        expect(JSON.parse(mine[0]!.row)).toMatchObject({ id: created!.id, action: 'createTenant', tenant_id: t });
        // The switch's own admin row is written after its triggers, in the same transaction.
        expect(rows.some((r) => r.kind === 'setDirectoryLakeCapture')).toBe(true);

        const upTo = mine[0]!.seq!;
        const acked = await host.admin.ackDirectoryOutbox!(staff, upTo, 'test:batch');
        expect(acked).toBeGreaterThanOrEqual(1);
        expect((await queued(host, staff)).filter((r) => r.seq! <= upTo)).toEqual([]);
        const [receipt] = await host.admin.auditLog(staff, { action: 'drainDirectoryOutbox', actor: staff });
        expect(receipt?.after).toMatchObject({ acked, upToSeq: upTo, ref: 'test:batch' });

        expect((await host.admin.setDirectoryLakeCapture!(staff, [])).disabled).toEqual(['admin_log']);
        const after = await newTenant(host, staff);
        expect((await queued(host, staff)).filter((r) => r.tenantId === after)).toEqual([]);
      } finally {
        await host.admin.setDirectoryLakeCapture!(staff, []);
        await cleanup();
      }
    });

    it('prunes nothing for a data set not capturing or not backfilled, and records no row when it pruned nothing', async () => {
      const { host, cleanup } = await makeFixture();
      const staff = platformActorId.parse(ulid());
      // A cut far in the past: this case asserts the refusals and the no-op, and never deletes a
      // row another case of a shared directory reads.
      const before = '2000-01-01T00:00:00.000Z';
      try {
        expect(await host.admin.pruneDirectoryLakeWindow!(staff, 'admin_log', before, 10)).toEqual({ pruned: 0, refused: 'not-capturing' });
        await host.admin.setDirectoryLakeCapture!(staff, ['admin_log']);
        expect(await host.admin.pruneDirectoryLakeWindow!(staff, 'admin_log', before, 10)).toEqual({ pruned: 0, refused: 'not-backfilled' });
        const [state] = await host.admin.directoryLakeCapture!(staff);
        await host.admin.advanceDirectoryLakeBackfill!(staff, 'admin_log', { after: 0, next: state!.backfillUntil, done: true });
        expect(await host.admin.pruneDirectoryLakeWindow!(staff, 'admin_log', before, 10)).toEqual({ pruned: 0, refused: null });
        expect(await host.admin.auditLog(staff, { action: 'pruneDirectoryLake', actor: staff })).toEqual([]);
      } finally {
        await host.admin.setDirectoryLakeCapture!(staff, []);
        await cleanup();
      }
    });

    it('builds every data set\'s capture against the tables this adapter creates, and backfills each in the outbox\'s shape', async () => {
      // The backfill and the capture of a data set both read its table as built, so a data set
      // whose table this adapter lacks, or spells differently, fails here and not on a real run.
      const { host, cleanup } = await makeFixture();
      const staff = platformActorId.parse(ulid());
      const operation = `contract.lake-${ulid().toLowerCase()}`;
      const unit = `contract-lake-${ulid().toLowerCase()}`;
      try {
        const on = await host.admin.setDirectoryLakeCapture!(staff, [...DIRECTORY_LAKE_DATASET_NAMES]);
        expect(on.current.map((c) => c.dataset).sort()).toEqual([...DIRECTORY_LAKE_DATASET_NAMES].sort());
        await host.admin.recordOpsFailure({ actor: staff, operation, message: 'lake capture' });
        await host.admin.recordSweepRun({ kind: 'connector', unit, outcome: 'ok' });
        const mine = (await queued(host, staff)).filter((r) => r.kind === operation || JSON.parse(r.row).unit === unit);
        expect(mine.map((r) => r.dataset).sort()).toEqual(['ops_failures', 'sweep_runs']);
        for (const dataset of DIRECTORY_LAKE_DATASET_NAMES) {
          const page = await host.admin.directoryLakeBackfill!(staff, dataset, 0, 2);
          expect(page.dataset).toBe(dataset);
          for (const r of page.rows) {
            expect(r).toMatchObject({ seq: null, dataset });
            expect(typeof JSON.parse(r.row)).toBe('object');
          }
        }
      } finally {
        await host.admin.setDirectoryLakeCapture!(staff, []);
        await cleanup();
      }
    });

    it('backfills rows written before capture, and records a backfill only while capturing and without a gap', async () => {
      const { host, cleanup } = await makeFixture();
      const staff = platformActorId.parse(ulid());
      try {
        const t = await newTenant(host, staff);
        const [created] = await host.admin.auditLog(staff, { tenantId: t, action: 'createTenant' });
        let found: DirectoryLakeRow | undefined;
        for (let after = 0; ;) {
          const page = await host.admin.directoryLakeBackfill!(staff, 'admin_log', after, 500);
          found ??= page.rows.find((r) => r.rowKey === created!.id);
          if (page.done || page.next === null) break;
          after = page.next;
        }
        expect(found).toMatchObject({ seq: null, dataset: 'admin_log', tenantId: t, kind: 'createTenant' });
        expect((await queued(host, staff)).filter((r) => r.tenantId === t)).toEqual([]);

        const page = { after: 0, next: 1, done: false };
        await expect(() => host.admin.advanceDirectoryLakeBackfill!(staff, 'admin_log', page)).rejects.toThrow(/not capturing/);
        await host.admin.setDirectoryLakeCapture!(staff, ['admin_log']);
        await expect(() => host.admin.advanceDirectoryLakeBackfill!(staff, 'admin_log', { after: 1, next: 2, done: true }))
          .rejects.toThrow(/resumes after rowid 0, not 1/);
        await host.admin.advanceDirectoryLakeBackfill!(staff, 'admin_log', page);
        expect(await host.admin.advanceDirectoryLakeBackfill!(staff, 'admin_log', { after: 1, next: 2, done: true }))
          .toMatchObject({ dataset: 'admin_log', backfillAfter: 2, backfilledAt: expect.any(String) });
        const receipts = await host.admin.auditLog(staff, { action: 'backfillDirectoryLake', actor: staff });
        expect(receipts.map((r) => r.after)).toEqual(expect.arrayContaining([expect.objectContaining({ dataset: 'admin_log', after: 1, next: 2, done: true })]));
      } finally {
        await host.admin.setDirectoryLakeCapture!(staff, []);
        await cleanup();
      }
    });
  });
}
