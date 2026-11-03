/**
 * #2213: the trivial driver is the runner a driver's author reads first, so its answers are
 * pinned here as well as by the suite: a size is always a valid `{ bytes }`, an erase
 * counts only what a subject actually had, and nothing about a subject outlives a wipe
 * or an import. Its dump moves in pages (D-69), so the paged contract is also shown on a driver
 * written in TypeScript, over a store that needs many pages.
 */
import { describe, expect, it } from 'vitest';
import { mergeDumpPages, STORE_STAGE_MAX_AGE_MS, type ScopeDumpTable } from '@substrat-run/contracts';
import { callReservedStoreOperation, callScopeStore, readStoreDump, ulid, writeStoreDump, type ScopeStoreAddress } from '@substrat-run/kernel';
import { counterScopeStoreRunner } from '../src/counter-runner.js';

const address: ScopeStoreAddress = { tenantId: 't', vertical: 'v', scopeId: 's', binding: 'B' };

function counter() {
  const runner = counterScopeStoreRunner();
  const send = (request: Parameters<typeof runner.invoke>[1]) => runner.invoke(address, request);
  const reserved = ((operation, input) => callReservedStoreOperation(send, operation, input)) as Parameters<typeof readStoreDump>[0];
  return {
    call: (operation: string, input?: unknown) => callScopeStore(send, operation, input),
    erase: (subjectId: string) => callReservedStoreOperation(send, 'substrat.erase', { subjectId }),
    size: () => callReservedStoreOperation(send, 'substrat.size'),
    wipe: () => callReservedStoreOperation(send, 'substrat.wipe'),
    exportPage: (cursor: string | null, maxBytes: number) => callReservedStoreOperation(send, 'substrat.export-page', { cursor, maxBytes }),
    exportTables: (maxBytes = 1024 * 1024) => readStoreDump(reserved, maxBytes),
    importTables: (tables: ScopeDumpTable[], maxBytes = 1024 * 1024) => writeStoreDump(reserved, tables, maxBytes),
    reserved,
  };
}

describe('counterScopeStoreRunner (#2213)', () => {
  it('refuses a negative increment, so a size is never negative', async () => {
    const store = counter();
    await expect(store.call('increment', { by: -1 })).rejects.toMatchObject({ storeCode: 'validation_failed', storeStatus: 400 });
    await store.call('increment', { by: 2 });
    expect(await store.size()).toEqual({ bytes: 2 });
  });

  it("erases the subject's part and counts it once; a subject that never wrote counts zero", async () => {
    const store = counter();
    await store.call('increment', { by: 3, subjectId: 'alice' });
    await store.call('increment', { by: 1 });
    expect(await store.erase('bob')).toEqual({ erased: 0 });
    expect(await store.erase('alice')).toEqual({ erased: 1 });
    expect(await store.call('read')).toBe(1);
    expect(await store.erase('alice')).toEqual({ erased: 0 });
  });

  it('a wipe takes the subjects with it', async () => {
    const store = counter();
    await store.call('increment', { by: 3, subjectId: 'alice' });
    await store.wipe();
    expect(await store.erase('alice')).toEqual({ erased: 0 });
  });

  it("an import replaces the subjects: one the dump does not hold has nothing left to erase, and one it holds does", async () => {
    const source = counter();
    await source.call('increment', { by: 2, subjectId: 'carol' });
    const tables = await source.exportTables();
    const target = counter();
    await target.call('increment', { by: 5, subjectId: 'alice' });
    expect(await target.importTables(tables)).toEqual({ tables: 1 });
    expect(await target.erase('alice')).toEqual({ erased: 0 });
    expect(await target.erase('carol')).toEqual({ erased: 1 });
    expect(await target.call('read')).toBe(0);
  });

  it('refuses an import whose counter rows are not [subject or null, a non-negative integer]', async () => {
    const store = counter();
    const tables = [{ name: 'counter', ddl: 'CREATE TABLE counter (subject TEXT, n INTEGER NOT NULL)', columns: ['subject', 'n'], rows: [[null, -4]] }];
    await expect(store.importTables(tables)).rejects.toMatchObject({ storeCode: 'validation_failed', storeStatus: 400 });
  });

  it('refuses an import that names one subject twice, and leaves the object as it was', async () => {
    const store = counter();
    await store.call('increment', { by: 5, subjectId: 'alice' });
    const table = (rows: unknown[][]) => [
      { name: 'counter', ddl: 'CREATE TABLE counter (subject TEXT, n INTEGER NOT NULL)', columns: ['subject', 'n'], rows },
    ];
    for (const rows of [[['a', 1], ['a', 2]], [[null, 1], [null, 2]]]) {
      await expect(store.importTables(table(rows))).rejects.toMatchObject({ storeCode: 'validation_failed', storeStatus: 400 });
      expect(await store.call('read')).toBe(5);
    }
    // The twin: distinct subjects load.
    expect(await store.importTables(table([['a', 1], ['b', 2], [null, 3]]))).toEqual({ tables: 1 });
    expect(await store.call('read')).toBe(6);
  });

  it('answers selfcheck with {} and leaves the object as it was', async () => {
    const store = counter();
    await store.call('increment', { by: 2 });
    expect(await store.reserved('substrat.selfcheck')).toEqual({});
    expect(await store.call('read')).toBe(2);
  });
});

describe('counterScopeStoreRunner moves its dump in pages (D-69)', () => {
  /** Forty subjects, so a small page holds a few rows and the dump needs many pages. */
  async function crowded() {
    const store = counter();
    for (let i = 0; i < 40; i += 1) await store.call('increment', { by: i + 1, subjectId: `subject-${i}` });
    return store;
  }

  const pagesOf = async (store: Awaited<ReturnType<typeof crowded>>, maxBytes: number) => {
    const pages: ScopeDumpTable[][] = [];
    const revisions = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await store.exportPage(cursor, maxBytes);
      pages.push(page.tables);
      revisions.add(page.revision);
      cursor = page.next;
    } while (cursor !== null);
    return { pages, revisions };
  };

  it('gives many pages for a small maxBytes and one for a large, and the merge is the single-page dump', async () => {
    const store = await crowded();
    const small = await pagesOf(store, 60);
    const large = await pagesOf(store, 1024 * 1024);
    expect(small.pages.length).toBeGreaterThan(10);
    expect(large.pages).toHaveLength(1);
    expect(mergeDumpPages(small.pages)).toEqual(mergeDumpPages(large.pages));
    expect(mergeDumpPages(small.pages)[0]!.rows).toHaveLength(40);
    // No write along the chain, so one revision.
    expect(small.revisions.size).toBe(1);
  });

  it('keeps a page, heading included, within maxBytes, except a page that holds one row', async () => {
    const store = await crowded();
    const { pages } = await pagesOf(store, 400);
    for (const page of pages) {
      const rows = page.flatMap((table) => table.rows);
      expect(rows.length).toBeGreaterThan(0);
      if (rows.length > 1) expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(400);
    }
    expect(pages.length).toBeGreaterThan(1);
    // A page size below one row still moves, one row a page.
    expect((await pagesOf(store, 1)).pages).toHaveLength(40);
  });

  it('changes its revision on a write, an erase and a wipe, and not on a read or a size', async () => {
    const store = await crowded();
    const revision = async () => (await store.exportPage(null, 1024)).revision;
    const first = await revision();
    await store.call('read');
    await store.size();
    expect(await revision()).toBe(first);
    await store.call('increment', { by: 1 });
    const second = await revision();
    expect(second).not.toBe(first);
    await store.erase('subject-3');
    const third = await revision();
    expect(third).not.toBe(second);
    await store.wipe();
    expect(await revision()).not.toBe(third);
  });

  it('a dump read in many pages and written in many pages arrives the same, subjects included', async () => {
    const source = await crowded();
    const target = counter();
    await target.call('increment', { by: 9, subjectId: 'stale' });
    const tables = await source.exportTables(120);
    expect(await target.importTables(tables, 120)).toEqual({ tables: 1 });
    expect(await target.exportTables()).toEqual(await source.exportTables());
    expect(await target.call('read')).toBe(await source.call('read'));
    expect(await target.erase('stale')).toEqual({ erased: 0 });
    expect(await target.erase('subject-7')).toEqual({ erased: 1 });
  });

  it('holds a stage aside: nothing is written until the commit, and a failed write drops it', async () => {
    const source = await crowded();
    const target = counter();
    await target.call('increment', { by: 4, subjectId: 'keep' });
    const tables = await source.exportTables(120);
    const stageId = ulid();
    const pages = [tables.map((t) => ({ ...t, rows: t.rows.slice(0, 20) })), tables.map((t) => ({ ...t, rows: t.rows.slice(20) }))];
    for (const [seq, page] of pages.entries()) {
      expect(await target.reserved('substrat.stage-page', { stageId, seq, tables: page })).toEqual({ staged: true });
      expect(await target.call('read'), 'a staged page changes nothing').toBe(4);
    }
    expect(await target.reserved('substrat.commit-stage', { stageId })).toEqual({ tables: 1 });
    expect(await target.call('read')).toBe(await source.call('read'));

    // A write that fails on a later page leaves the target as it was.
    const again = counter();
    await again.call('increment', { by: 4, subjectId: 'keep' });
    const bad = [...tables.map((t) => ({ ...t, rows: t.rows.slice(0, 5) })), ...tables.map((t) => ({ ...t, rows: [['keep', -1]] }))];
    await expect(again.importTables(bad, 120)).rejects.toMatchObject({ storeCode: 'validation_failed' });
    expect(await again.call('read')).toBe(4);
    expect(await again.reserved('substrat.discard-stage', { stageId })).toEqual({ discarded: false });
  });

  it('a new stage at seq 0 drops the one before it, which then cannot commit', async () => {
    const store = counter();
    const table = (rows: unknown[][]): ScopeDumpTable[] => [
      { name: 'counter', ddl: 'CREATE TABLE counter (subject TEXT, n INTEGER NOT NULL)', columns: ['subject', 'n'], rows },
    ];
    const first = ulid();
    const second = ulid();
    await store.reserved('substrat.stage-page', { stageId: first, seq: 0, tables: table([['a', 1]]) });
    await store.reserved('substrat.stage-page', { stageId: second, seq: 0, tables: table([['b', 2]]) });
    await expect(store.reserved('substrat.commit-stage', { stageId: first })).rejects.toMatchObject({ storeCode: 'stage_refused', storeStatus: 409 });
    expect(await store.reserved('substrat.commit-stage', { stageId: second })).toEqual({ tables: 1 });
    expect(await store.call('read')).toBe(2);
  });
});

describe('counterScopeStoreRunner keeps the contract the suite can only ask a driver about (D-69)', () => {
  const table = (rows: unknown[][]): ScopeDumpTable[] => [
    { name: 'counter', ddl: 'CREATE TABLE counter (subject TEXT, n INTEGER NOT NULL)', columns: ['subject', 'n'], rows },
  ];
  /** A counter on a clock the test moves. */
  function clocked() {
    let at = 1_000;
    const runner = counterScopeStoreRunner({ now: () => at });
    const send = (request: Parameters<typeof runner.invoke>[1]) => runner.invoke(address, request);
    return {
      advance: (ms: number) => (at += ms),
      call: (operation: string, input?: unknown) => callScopeStore(send, operation, input),
      reserved: ((operation, input) => callReservedStoreOperation(send, operation, input)) as Parameters<typeof readStoreDump>[0],
    };
  }

  it('moves the revision on an erase that erased something, and not on one that erased nothing', async () => {
    const store = counter();
    await store.call('increment', { by: 2, subjectId: 'alice' });
    const revision = async () => (await store.exportPage(null, 1024)).revision;
    const first = await revision();
    await store.erase('nobody');
    expect(await revision()).toBe(first);
    await store.erase('alice');
    expect(await revision()).not.toBe(first);
  });

  it('drops a stage on an erase, even one that erased nothing, so its commit is refused', async () => {
    const store = counter();
    await store.call('increment', { by: 3, subjectId: 'alice' });
    const stageId = ulid();
    await store.reserved('substrat.stage-page', { stageId, seq: 0, tables: table([['alice', 3]]) });
    await store.erase('nobody');
    await expect(store.reserved('substrat.commit-stage', { stageId })).rejects.toMatchObject({ storeCode: 'stage_refused', storeStatus: 409 });
    expect(await store.call('read')).toBe(3);
  });

  it('counts a stage in its size', async () => {
    const store = counter();
    await store.call('increment', { by: 2 });
    const stageId = ulid();
    await store.reserved('substrat.stage-page', { stageId, seq: 0, tables: table([['a', 5]]) });
    await store.reserved('substrat.stage-page', { stageId, seq: 1, tables: table([['b', 7]]) });
    expect(await store.size()).toEqual({ bytes: 2 + 12 });
    await store.reserved('substrat.discard-stage', { stageId });
    expect(await store.size()).toEqual({ bytes: 2 });
  });

  it('drops a stage unused for longer than the stage age by the next call, and keeps one used within it', async () => {
    const store = clocked();
    const kept = ulid();
    await store.reserved('substrat.stage-page', { stageId: kept, seq: 0, tables: table([['a', 1]]) });
    store.advance(STORE_STAGE_MAX_AGE_MS);
    // At the age it is still held, and using it renews it.
    expect(await store.reserved('substrat.stage-page', { stageId: kept, seq: 1, tables: table([['b', 1]]) })).toEqual({ staged: true });
    store.advance(STORE_STAGE_MAX_AGE_MS);
    expect(await store.reserved('substrat.stage-page', { stageId: kept, seq: 2, tables: table([['c', 1]]) })).toEqual({ staged: true });

    store.advance(STORE_STAGE_MAX_AGE_MS + 1);
    // Any call to the object finds it gone: here a size, which then counts no stage.
    expect(await store.reserved('substrat.size')).toEqual({ bytes: 0 });
    await expect(store.reserved('substrat.commit-stage', { stageId: kept })).rejects.toMatchObject({ storeCode: 'stage_refused', storeStatus: 409 });
    expect(await store.call('read')).toBe(0);
  });

  it('answers a commit asked again with the same count, changes nothing, and refuses a stage it never held', async () => {
    const store = counter();
    const stageId = ulid();
    await store.reserved('substrat.stage-page', { stageId, seq: 0, tables: table([['a', 2]]) });
    expect(await store.reserved('substrat.commit-stage', { stageId })).toEqual({ tables: 1 });
    await store.call('increment', { by: 5, subjectId: 'later' });
    expect(await store.reserved('substrat.commit-stage', { stageId })).toEqual({ tables: 1 });
    expect(await store.call('read')).toBe(7);
    await expect(store.reserved('substrat.commit-stage', { stageId: ulid() })).rejects.toMatchObject({ storeCode: 'stage_refused', storeStatus: 409 });
    // A new stage, a wipe: the old commit is behind us.
    await store.wipe();
    await expect(store.reserved('substrat.commit-stage', { stageId })).rejects.toMatchObject({ storeCode: 'stage_refused', storeStatus: 409 });
  });

  it('counts distinct tables in a commit, however many fragments it was sent', async () => {
    const store = counter();
    const stageId = ulid();
    for (const [seq, row] of [['a', 1], ['b', 2], ['c', 3]].entries()) {
      await store.reserved('substrat.stage-page', { stageId, seq, tables: table([row]) });
    }
    expect(await store.reserved('substrat.commit-stage', { stageId })).toEqual({ tables: 1 });
    expect(await store.call('read')).toBe(6);
  });

  it('measures a page in UTF-8 bytes with its heading, and a page always holds a row', async () => {
    const store = counter();
    // A subject of multi-byte characters: more bytes than characters.
    for (let i = 0; i < 6; i += 1) await store.call('increment', { by: 1, subjectId: `${i}-${'å'.repeat(20)}` });
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    const maxBytes = 260;
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await store.exportPage(cursor, maxBytes);
      expect(bytes(page.tables)).toBeLessThanOrEqual(maxBytes);
      cursor = page.next;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBeGreaterThan(1);
    // Nothing fits beside a heading in one byte, and the page still holds one row.
    const smallest = await store.exportPage(null, 1);
    expect(smallest.tables).toHaveLength(1);
    expect(smallest.tables[0]!.rows).toHaveLength(1);
    expect(smallest.next).not.toBeNull();
  });

  it('refuses a cursor that is not one it gave', async () => {
    const store = counter();
    await expect(store.exportPage('not-a-number', 100)).rejects.toMatchObject({ storeCode: 'validation_failed' });
  });

  it('keeps the memory of the last commit across a new page 0 and an erase, and ends it only on a wipe', async () => {
    const store = counter();
    const first = ulid();
    await store.reserved('substrat.stage-page', { stageId: first, seq: 0, tables: table([['a', 2]]) });
    expect(await store.reserved('substrat.commit-stage', { stageId: first })).toEqual({ tables: 1 });
    // A new stage begins, and an erase runs: the lost answer of the first commit can still be retried.
    await store.reserved('substrat.stage-page', { stageId: ulid(), seq: 0, tables: table([['b', 1]]) });
    await store.erase('nobody');
    expect(await store.reserved('substrat.commit-stage', { stageId: first })).toEqual({ tables: 1 });
    await store.wipe();
    await expect(store.reserved('substrat.commit-stage', { stageId: first })).rejects.toMatchObject({ storeCode: 'stage_refused', storeStatus: 409 });
  });

  it('answers only for the stage last committed: an older one is refused', async () => {
    const store = counter();
    const [older, newer] = [ulid(), ulid()];
    await store.reserved('substrat.stage-page', { stageId: older, seq: 0, tables: table([['a', 1]]) });
    await store.reserved('substrat.commit-stage', { stageId: older });
    await store.reserved('substrat.stage-page', { stageId: newer, seq: 0, tables: table([['b', 1]]) });
    await store.reserved('substrat.commit-stage', { stageId: newer });
    await expect(store.reserved('substrat.commit-stage', { stageId: older })).rejects.toMatchObject({ storeCode: 'stage_refused' });
    expect(await store.reserved('substrat.commit-stage', { stageId: newer })).toEqual({ tables: 1 });
  });

  it('does not take a stage id again once it was committed', async () => {
    const store = counter();
    const stageId = ulid();
    await store.reserved('substrat.stage-page', { stageId, seq: 0, tables: table([['a', 1]]) });
    await store.reserved('substrat.commit-stage', { stageId });
    await expect(store.reserved('substrat.stage-page', { stageId, seq: 0, tables: table([['b', 9]]) })).rejects.toMatchObject({
      storeCode: 'stage_refused',
      storeStatus: 409,
    });
    expect(await store.call('read')).toBe(1);
  });

  it('refuses a negative count and a table it has no name for when they are staged, so size is never wrong', async () => {
    const store = counter();
    const stageId = ulid();
    await expect(store.reserved('substrat.stage-page', { stageId, seq: 0, tables: table([['a', -5]]) })).rejects.toMatchObject({
      storeCode: 'validation_failed',
    });
    const other: ScopeDumpTable[] = [{ name: 'other', ddl: 'CREATE TABLE other (x TEXT)', columns: ['x'], rows: [['y']] }];
    await expect(store.reserved('substrat.stage-page', { stageId, seq: 0, tables: other })).rejects.toMatchObject({ storeCode: 'validation_failed' });
    expect(await store.size()).toEqual({ bytes: 0 });
  });
});
