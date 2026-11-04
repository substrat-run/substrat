import { env } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { mergeDumpPages, type DirectoryDumpPage, type ScopeDumpTable } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { warmControlPlane } from './do-warmup.js';

/**
 * #2868: the directory's dump a page at a time, which the scheduled backup reads now that the
 * whole dump no longer fits the directory's isolate. Run on a directory DO of its own, so no other
 * file's writes are in it.
 */
interface Directory {
  exportDump(): Promise<ScopeDumpTable[]>;
  exportDumpPage(cursor: string | null, opts?: { maxBytes?: number }): Promise<DirectoryDumpPage>;
  insertVertical(
    slug: string, name: string, source: string, ownerTenant: string | null,
    envSpec: string | null, installSpec: string | null, listed: number, createdAt: string,
  ): Promise<void>;
}

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

it('pages join into the whole dump, and a row written while they are read is in none of them', async () => {
  const dir = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`dump-pages-${ulid()}`)) as unknown as Directory;
  // Twenty verticals of about 2 KB each, against pages of 8 KB of cells: a table over several pages.
  const spec = JSON.stringify([{ key: 'x'.repeat(2_000) }]);
  for (let i = 0; i < 20; i++) {
    await dir.insertVertical(`v-${String(i).padStart(2, '0')}`, 'V', 'builtin', null, spec, null, 0, '2026-11-04T00:00:00.000Z');
  }
  const whole = await dir.exportDump();

  const pages: DirectoryDumpPage[] = [await dir.exportDumpPage(null, { maxBytes: 8_000 })];
  await dir.insertVertical('written-mid-copy', 'V', 'builtin', null, spec, null, 0, '2026-11-04T00:00:00.000Z');
  while (pages.at(-1)!.next !== null) pages.push(await dir.exportDumpPage(pages.at(-1)!.next, { maxBytes: 8_000 }));

  expect(pages.length).toBeGreaterThan(3);
  expect(new Set(pages.map((p) => p.capturedAt)).size).toBe(1);
  expect(mergeDumpPages(pages.map((p) => p.tables))).toEqual(whole);
});
