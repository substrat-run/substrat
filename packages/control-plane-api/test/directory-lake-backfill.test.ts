import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { platformActorId, tenantId } from '@substrat-run/contracts';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { UNSAFE_allowAllChecker, ulid, type DirectoryLakeRow } from '@substrat-run/kernel';
import { backfillDirectoryLake } from '../src/directory-lake-backfill.js';

const staff = platformActorId.parse(ulid());
let close: () => Promise<void> = async () => {};
afterEach(() => close());

/** A one-database host holding three admin rows (three tenants), and a sink that records. */
async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-lake-backfill-'));
  const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
  close = async () => { await host.close(); rmSync(dir, { recursive: true, force: true }); };
  for (let i = 0; i < 3; i++) {
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `b-${t.toLowerCase()}`, name: 'Backfill' });
  }
  const shipped: DirectoryLakeRow[][] = [];
  const sink = { ship: async (rows: DirectoryLakeRow[]) => (shipped.push(rows), { ref: `r${shipped.length}` }) };
  const run = (over: { dryRun?: boolean; after?: number; limit?: number }) =>
    backfillDirectoryLake({ admin: host.admin, actor: staff, sink },
      { dataset: 'admin_log', dryRun: true, after: 0, limit: 2, ...over });
  return { host, shipped, run };
}

describe('the directory lake backfill (K-70)', () => {
  it('reads on a dry run and ships nothing; a real run is refused while the data set is not capturing', async () => {
    const { shipped, run } = await world();
    expect(await run({})).toMatchObject({ dryRun: true, capturing: false, rows: 2, next: 2, done: false, ref: null });
    await expect(run({ dryRun: false })).rejects.toMatchObject({ reason: 'not-capturing' });
    expect(shipped).toEqual([]);
  });

  it('walks to the end page by page, refusing a page out of order before shipping it', async () => {
    const { host, shipped, run } = await world();
    await host.admin.setDirectoryLakeCapture!(staff, ['admin_log']);
    await expect(run({ dryRun: false, after: 2 })).rejects.toMatchObject({ reason: 'out-of-order' });
    expect(shipped).toEqual([]);

    let answer = await run({ dryRun: false });
    while (!answer.done) answer = await run({ dryRun: false, after: answer.next! });
    // The three rows before capture, in pages of two; the switch's own row and every receipt the
    // walk writes were captured by the trigger, so the walk does not chase them.
    expect(shipped.map((page) => page.map((r) => r.kind))).toEqual([['createTenant', 'createTenant'], ['createTenant']]);
    expect(answer).toMatchObject({ done: true, resumeAfter: 3, backfilledAt: expect.any(String) });
  });
});
