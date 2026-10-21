import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorCodeOf, mergeDumpPages, scopeId, type ScopeDumpPage, type ScopeDumpTable, type ScopeId } from '@substrat-run/contracts';
import { createUlid, SCOPE_COPY_LEASE_MS, ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #2450 on workerd: a scope read out in pages and staged into another, then loaded from the stage
 * in one transaction, lands exactly as the whole dump would have. A whole dump crosses a Durable
 * Object RPC and an isolate as one value, so past 32 MiB it cannot move at all; here the pages are
 * forced small (`maxBytes`) so a few rows already take many.
 */
const secretBox = webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
const stageBackstopMs = 6 * 3_600_000 + 3 * SCOPE_COPY_LEASE_MS;

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

const notes = (n: number): ScopeDumpTable => ({
  name: 'pg_notes',
  ddl: 'CREATE TABLE pg_notes (id TEXT PRIMARY KEY, body TEXT, n INTEGER)',
  columns: ['id', 'body', 'n'],
  rows: Array.from({ length: n }, (_, i) => [`n${String(i).padStart(4, '0')}`, `body ${i} `.repeat(20), i]),
});
// Read by offset: it has no rowid to page on.
const tags = (n: number): ScopeDumpTable => ({
  name: 'pg_tags',
  ddl: 'CREATE TABLE pg_tags (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID',
  columns: ['k', 'v'],
  rows: Array.from({ length: n }, (_, i) => [`k${String(i).padStart(4, '0')}`, `v${i}`]),
});
const empty: ScopeDumpTable = { name: 'pg_empty', ddl: 'CREATE TABLE pg_empty (x TEXT)', columns: ['x'], rows: [] };

/** The vertical's tables of a dump (the spine is the scope's own, and differs by scope id). */
const vertical = (tables: ScopeDumpTable[]) =>
  tables.filter((t) => t.name.startsWith('pg_')).sort((a, b) => a.name.localeCompare(b.name));

describe('a scope carried in pages lands as the whole dump would (#2450)', () => {
  let host: CloudflareScopeHost;
  beforeAll(() => {
    host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, secretBox });
  });

  const seed = async (rows = 60): Promise<ScopeId> => {
    const sid = scopeId.parse(ulid());
    await host.restoreScopeLocal(sid, [notes(rows), tags(rows), empty], { sourceScopeId: sid });
    return sid;
  };
  const readAll = async (sid: ScopeId, opts: { stamp?: boolean; maxBytes?: number }): Promise<ScopeDumpPage[]> => {
    const pages: ScopeDumpPage[] = [];
    let cursor: string | null = null;
    do {
      const page: ScopeDumpPage = await host.exportScopePageLocal(sid, cursor, opts);
      pages.push(page);
      cursor = page.next;
    } while (cursor !== null);
    return pages;
  };
  const stageAll = async (dest: ScopeId, stageId: string, pages: ScopeDumpPage[]) => {
    for (const [seq, page] of pages.entries()) {
      expect(await host.stageScopePageLocal(dest, stageId, seq, page.tables)).toEqual({ staged: true });
    }
  };

  it('pages the scope, every table in some page, and the pages merge into the whole dump', async () => {
    const source = await seed();
    const pages = await readAll(source, { maxBytes: 2_000 });
    expect(pages.length).toBeGreaterThan(5);
    const whole = await host.exportScopeLocal(source);
    expect(vertical(mergeDumpPages(pages.map((p) => p.tables)))).toEqual(vertical(whole));
    expect(mergeDumpPages(pages.map((p) => p.tables)).map((t) => t.name).sort()).toEqual(whole.map((t) => t.name).sort());
    // Nothing wrote between the pages, so they all read one revision.
    expect(new Set(pages.map((p) => p.revision)).size).toBe(1);
  });

  it('a row larger than a page rides alone', async () => {
    const source = await seed(3);
    const pages = await readAll(source, { maxBytes: 1 });
    expect(vertical(mergeDumpPages(pages.map((p) => p.tables)))).toEqual(vertical(await host.exportScopeLocal(source)));
    for (const page of pages) expect(page.tables.reduce((n, t) => n + t.rows.length, 0)).toBeLessThanOrEqual(1);
  });

  it('stages the pages and loads them in one commit, leaving no stage behind', async () => {
    const source = await seed();
    const dest = scopeId.parse(ulid());
    const stageId = ulid();
    const pages = await readAll(source, { maxBytes: 2_000 });
    await stageAll(dest, stageId, pages);
    const out = await host.restoreStagedScopeLocal(dest, stageId, { sourceScopeId: source, exact: true });
    expect(out.tables).toBe(mergeDumpPages(pages.map((p) => p.tables)).length);
    expect(vertical(await host.exportScopeLocal(dest))).toEqual(vertical(await host.exportScopeLocal(source)));
    // The stage went with the load; no dump ever carries it.
    const names = (await host.introspectScopeTables(dest)).map((t) => t.name);
    expect(names.filter((n) => n.startsWith('_substrat_stage'))).toEqual([]);
  });

  it('matches what the whole-dump load lands, spine included', async () => {
    const source = await seed(25);
    const pages = await readAll(source, { maxBytes: 1_500 });
    const viaStage = scopeId.parse(ulid());
    const viaWhole = scopeId.parse(ulid());
    const stageId = ulid();
    await stageAll(viaStage, stageId, pages);
    await host.restoreStagedScopeLocal(viaStage, stageId, { sourceScopeId: source, exact: true });
    await host.restoreScopeLocal(viaWhole, mergeDumpPages(pages.map((p) => p.tables)), { sourceScopeId: source, exact: true });
    const strip = (tables: ScopeDumpTable[], sid: ScopeId) =>
      JSON.parse(JSON.stringify(tables).replaceAll(sid, '<dest>')) as ScopeDumpTable[];
    const a = strip(await host.exportScopeLocal(viaStage), viaStage);
    const b = strip(await host.exportScopeLocal(viaWhole), viaWhole);
    // Each load mints its own event ids and timestamps; the tables and their row counts agree.
    expect(a.map((t) => [t.name, t.rows.length])).toEqual(b.map((t) => [t.name, t.rows.length]));
    expect(vertical(a)).toEqual(vertical(b));
  });

  it('staging moves neither the load stamp nor the write revision a carry fences on', async () => {
    const source = await seed(10);
    const dest = await seed(2);
    const before = await host.loadMarkerLocal(dest);
    await stageAll(dest, ulid(), await readAll(source, { maxBytes: 1_000 }));
    expect(await host.loadMarkerLocal(dest)).toEqual(before);
  });

  it('a retried page changes nothing; a page out of order is refused', async () => {
    const source = await seed(20);
    const dest = scopeId.parse(ulid());
    const stageId = ulid();
    const pages = await readAll(source, { maxBytes: 1_000 });
    expect(pages.length).toBeGreaterThan(2);
    expect(await host.stageScopePageLocal(dest, stageId, 0, pages[0]!.tables)).toEqual({ staged: true });
    expect(await host.stageScopePageLocal(dest, stageId, 0, pages[0]!.tables)).toEqual({ staged: false });
    const skipped = await host.stageScopePageLocal(dest, stageId, 2, pages[2]!.tables).catch((e: unknown) => e);
    expect(errorCodeOf(skipped)).toBe('precondition_failed');
    for (const [seq, page] of pages.entries()) if (seq > 0) await host.stageScopePageLocal(dest, stageId, seq, page.tables);
    await host.restoreStagedScopeLocal(dest, stageId, { sourceScopeId: source, exact: true });
    expect(vertical(await host.exportScopeLocal(dest))).toEqual(vertical(await host.exportScopeLocal(source)));
  });

  it('a competing stage leaves its owner able to finish, and only the named owner may discard it', async () => {
    const source = await seed(10);
    const dest = await seed(2);
    const pages = await readAll(source, { maxBytes: 1_000 });
    const older = ulid();
    await stageAll(dest, older, pages);
    const loser = ulid();
    const refused = await host.stageScopePageLocal(dest, loser, 0, pages[0]!.tables).catch((e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('conflict');
    expect(await host.discardStagedScopeLocal(dest, loser)).toEqual({ discarded: false });
    expect(await host.stageScopePageLocal(dest, older, 0, pages[0]!.tables)).toEqual({ staged: false });
    await host.restoreStagedScopeLocal(dest, older, { sourceScopeId: source });
    expect(vertical(await host.exportScopeLocal(dest))).toEqual(vertical(await host.exportScopeLocal(source)));
    // A retry after the winner loaded may open its own stage.
    await stageAll(dest, loser, pages);
    expect(await host.discardStagedScopeLocal(dest, older)).toEqual({ discarded: false });
    expect(await host.discardStagedScopeLocal(dest, loser)).toEqual({ discarded: true });
  });

  it('an abandoned stage past the copy deadline and leases is reclaimed by a new page zero', async () => {
    const source = await seed(10);
    const dest = await seed(2);
    const pages = await readAll(source, { maxBytes: 1_000 });
    // A valid ULID from epoch zero: well past the job's six-hour limit and three leases.
    const abandoned = '00000000000000000000000000';
    await stageAll(dest, abandoned, pages);
    const newcomer = ulid();
    expect(await host.stageScopePageLocal(dest, newcomer, 0, pages[0]!.tables)).toEqual({ staged: true });
    const refused = await host.restoreStagedScopeLocal(dest, abandoned, { sourceScopeId: source }).catch((e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('precondition_failed');
    expect(vertical(await host.exportScopeLocal(dest)).find((t) => t.name === 'pg_notes')?.rows).toHaveLength(2);
    for (const [seq, page] of pages.entries()) if (seq > 0) await host.stageScopePageLocal(dest, newcomer, seq, page.tables);
    await host.restoreStagedScopeLocal(dest, newcomer, { sourceScopeId: source });
    expect(vertical(await host.exportScopeLocal(dest))).toEqual(vertical(await host.exportScopeLocal(source)));
  });

  it('a stage just under the 7.5-hour backstop still refuses a competing page zero', async () => {
    const source = await seed(10);
    const dest = await seed(2);
    const pages = await readAll(source, { maxBytes: 1_000 });
    const owner = createUlid()(Date.now() - stageBackstopMs + 60_000);
    await stageAll(dest, owner, pages);
    const refused = await host.stageScopePageLocal(dest, ulid(), 0, pages[0]!.tables).catch((e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('conflict');
    await host.restoreStagedScopeLocal(dest, owner, { sourceScopeId: source });
    expect(vertical(await host.exportScopeLocal(dest))).toEqual(vertical(await host.exportScopeLocal(source)));
  });

  it('a stage just over the 7.5-hour backstop is reclaimed by a competing page zero', async () => {
    const source = await seed(10);
    const dest = await seed(2);
    const pages = await readAll(source, { maxBytes: 1_000 });
    const abandoned = createUlid()(Date.now() - stageBackstopMs - 60_000);
    await stageAll(dest, abandoned, pages);
    const newcomer = ulid();
    expect(await host.stageScopePageLocal(dest, newcomer, 0, pages[0]!.tables)).toEqual({ staged: true });
    const refused = await host.restoreStagedScopeLocal(dest, abandoned, { sourceScopeId: source }).catch((e: unknown) => e);
    expect(errorCodeOf(refused)).toBe('precondition_failed');
    for (const [seq, page] of pages.entries()) if (seq > 0) await host.stageScopePageLocal(dest, newcomer, seq, page.tables);
    await host.restoreStagedScopeLocal(dest, newcomer, { sourceScopeId: source });
    expect(vertical(await host.exportScopeLocal(dest))).toEqual(vertical(await host.exportScopeLocal(source)));
  });

  it('only a carry\'s export mints the source\'s load stamp; a fork\'s writes nothing', async () => {
    const source = await seed(5);
    const before = await host.loadMarkerLocal(source);
    expect(before.loadStamp).toBeNull();
    const fork = await host.exportScopePageLocal(source, null, { stamp: false });
    expect(fork.loadStamp).toBeNull();
    expect(await host.loadMarkerLocal(source)).toEqual(before);
    const carry = await host.exportScopePageLocal(source, null, { stamp: true });
    expect(carry.loadStamp).toEqual(expect.any(String));
    expect((await host.loadMarkerLocal(source)).loadStamp).toBe(carry.loadStamp);
  });

  it('a write between pages shows as a moved revision', async () => {
    const source = await seed(20);
    const first = await host.exportScopePageLocal(source, null, { stamp: true, maxBytes: 1_000 });
    expect(first.next).not.toBeNull();
    // Any write moves the revision; a restore is the one this suite can make without a module.
    await host.restoreScopeLocal(source, [notes(21), tags(20), empty], { sourceScopeId: source });
    const second = await host.exportScopePageLocal(source, first.next, { maxBytes: 1_000 });
    expect(second.revision).not.toBe(first.revision);
  });
});
