import { describe, expect, it } from 'vitest';
import { STORE_CALL_MAX_BYTES, storeDriverDumpPageBytes, type PlatformActorId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { createR2BackupStore } from '../src/r2-backups.js';
import {
  movePages,
  newPageMove,
  newStorePlan,
  runStorePlanInRequest,
  STORE_MOVE_ATTEMPTS,
  STORE_MOVE_MAX_PAGES,
  storeMoveBackoffMs,
  unfinishedInRequest,
  type StoreRequestBudget,
} from '../src/store-move.js';
import {
  backupEnds,
  commitStages,
  refuseOverCap,
  restoreEnds,
  snapshotEnds,
  STORE_BACKUP_MAX_PAGES,
  storeHoldsRows,
  StoreLandFailure,
  writeBackupIndex,
} from '../src/store-move-ends.js';
import { readStoreForBody } from '../src/store-pull.js';
import {
  advanceStoreJob,
  storeJobAt,
  STORE_JOB_STALL_MS,
  newStoreJob,
  type StoreJobDeps,
  type StoreJobRecord,
  type StoreJobSpec,
} from '../src/store-jobs.js';
import { memoryStoreJobs } from './helpers/memory-store-jobs.js';
import { fakeBucket, fakeStoreDriver, platformOver, storeObject } from './helpers/store-fakes.js';

const place = { tenantId: 'T', scopeId: 'S', vertical: 'crm', capturedAt: '2026-11-03T10:00:00.000Z' };
const GRAPH = { binding: 'GRAPH', driver: 'graph' };
const OTHER = { binding: 'OTHER', driver: 'graph' };
const object = (binding = 'GRAPH', scopeId = 'S') => storeObject('T', 'crm', scopeId, binding);
const noWait: StoreRequestBudget = { pages: 1000, ms: 60_000, sleep: async () => undefined };
const scopeObject = { key: 'scopes/T/S/2026-11-03T10:00:00.000Z/scope.json', bytes: 2, digest: '0'.repeat(64), tables: 1 };

const fixture = (pageRows = 10) => {
  const driver = fakeStoreDriver({ pageRows });
  const r2 = fakeBucket({ held: driver.held });
  const stores = platformOver(driver);
  const backups = createR2BackupStore(r2.bucket);
  return { driver, r2, stores, backups, deps: { stores, backups } };
};

/** A backup of what the fixture's GRAPH holds, finished in one run, and the index it wrote. */
const backedUp = async (fx: ReturnType<typeof fixture>) => {
  const moved = await runStorePlanInRequest(backupEnds(fx.deps, place), newStorePlan([GRAPH]), noWait);
  if (!('done' in moved)) throw new Error('the backup did not finish');
  await writeBackupIndex(fx.backups, place, scopeObject, moved.done);
  return (await fx.backups.getIndex(place))!;
};

describe('a store moves a page at a time, holding a page (D-69)', () => {
  it('a backup of a store far larger than a page never holds more than one, and loses no row', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 5_000);
    const index = await backedUp(fx);
    expect(fx.driver.held.peak).toBeLessThanOrEqual(10);
    expect(fx.driver.held.now).toBe(0);
    expect(index.stores[0]!.pageCount).toBe(500);
    expect(index.stores[0]!.revision).toBe('r2');
    const rows = await Promise.all(index.stores[0]!.pages.map(async (ref) =>
      (JSON.parse((await fx.backups.readObject({ ...place, ref }))!) as { tables: { rows: unknown[] }[] }).tables[0]!.rows.length));
    expect(rows.reduce((a, b) => a + b, 0)).toBe(5_000);
  });

  it('a snapshot copies straight from one store to the other, and nothing changes until the commit', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 1_000);
    const to = object('GRAPH', 'FORK');
    const moved = await runStorePlanInRequest(snapshotEnds(fx.stores, { tenantId: 'T', vertical: 'crm', from: 'S', to: 'FORK' }), newStorePlan([GRAPH]), noWait);
    if (!('done' in moved)) throw new Error('the copy did not finish');
    expect(fx.driver.held.peak).toBeLessThanOrEqual(10);
    expect(fx.driver.idsOf(to)).toEqual([]);
    await commitStages(fx.stores, { tenantId: 'T', scopeId: 'FORK', vertical: 'crm' }, moved.done);
    expect(fx.driver.idsOf(to)).toEqual(fx.driver.idsOf(object()));
  });

  it('restores a backup page by page: nothing staged is more than the page being moved', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 100);
    const index = await backedUp(fx);
    fx.driver.put(object(), 3);
    const reads: string[] = [];
    const counting = { ...fx.backups, readObject: async (input: Parameters<typeof fx.backups.readObject>[0]) => {
      // By the time a page is read, every page before it has reached the stage.
      expect(fx.driver.stageOf(object())?.pages.length ?? 0).toBe(reads.length);
      reads.push(input.ref.key);
      return fx.backups.readObject(input);
    } };
    const moved = await runStorePlanInRequest(restoreEnds({ stores: fx.stores, backups: counting }, place, place, index.stores), newStorePlan([GRAPH]), noWait);
    if (!('done' in moved)) throw new Error('the restore did not finish');
    expect(reads).toHaveLength(10);
    expect(fx.driver.idsOf(object())).toHaveLength(3);
    await commitStages(fx.stores, place, moved.done);
    expect(fx.driver.idsOf(object())).toHaveLength(100);
  });

  it('moves several stores one after another, and the state it hands on holds no row', async () => {
    const fx = fixture(5);
    fx.driver.put(object(), 12);
    fx.driver.put(object('OTHER'), 12);
    const stopped = await runStorePlanInRequest(backupEnds(fx.deps, place), newStorePlan([GRAPH, OTHER]), { ...noWait, pages: 4 });
    if (!('state' in stopped)) throw new Error('the budget did not stop it');
    expect(stopped.state.at).toBe(1);
    expect(stopped.state.moved.map((m) => [m.binding, m.pages])).toEqual([['GRAPH', 3]]);
    expect(JSON.stringify(stopped.state)).not.toContain('n1');
    expect(stopped.state.pages).toBe(4);
  });
});

describe('what a restore and an index hold each other to (D-69)', () => {
  it('a page stored larger than the driver now takes is cut again, one stored page at a time, with no row lost', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 30);
    const index = await backedUp(fx);
    fx.driver.put(object(), 1);
    const reads: string[] = [];
    const counting = { ...fx.backups, readObject: async (input: Parameters<typeof fx.backups.readObject>[0]) => {
      // Each stored page reaches the stage, cut, before the next is read.
      expect(fx.driver.stageOf(object())?.pages.flat().flatMap((t) => t.rows).length ?? 0).toBe(reads.length * 10);
      reads.push(input.ref.key);
      return fx.backups.readObject(input);
    } };
    // A row here serializes at about 12 bytes, so the heading and three rows fill this.
    const moved = await runStorePlanInRequest(restoreEnds({ stores: fx.stores, backups: counting }, place, place, index.stores, () => 90), newStorePlan([GRAPH]), noWait);
    if (!('done' in moved)) throw new Error('the restore did not finish');
    const staged = fx.driver.stageOf(object())!.pages;
    expect(staged.length).toBeGreaterThan(index.stores[0]!.pageCount);
    for (const page of staged) expect(JSON.stringify(page).length).toBeLessThanOrEqual(90);
    expect(moved.done[0]!.pages).toBe(staged.length);
    await commitStages(fx.stores, place, moved.done);
    expect(fx.driver.idsOf(object())).toEqual(Array.from({ length: 30 }, (_, i) => `n${i}`));
  });

  it('a commit answering another count fails, naming the binding as unknown', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 5);
    fx.driver.intercept((call) => (call.operation === 'substrat.commit-stage' ? Response.json({ result: { tables: 7 } }) : undefined));
    const moved = { ...GRAPH, moveId: 'S1', revision: 'r1', tables: 1, pages: 1 };
    const error = await commitStages(fx.stores, place, [moved]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreLandFailure);
    expect(error).toMatchObject({ status: 502, committed: [], unknown: 'GRAPH' });
  });

  it('a commit that outlasts all its tries fails as unknown, for a later restore to settle', async () => {
    const stores = platformOver({
      fetch: (_script, request) => request.clone().text().then((body) => (body.includes('commit-stage') ? new Promise<Response>(() => undefined) : Response.json({ result: {} }))),
    }, { deadlineMs: 5, retryDelaysMs: [0, 0] });
    const moved = { ...GRAPH, moveId: 'S1', revision: 'r1', tables: 1, pages: 1 };
    await expect(commitStages(stores, place, [moved])).rejects.toMatchObject({ status: 504, committed: [], unknown: 'GRAPH' });
  });

  it('an index is not written when the listing holds fewer pages than the chain wrote', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 25);
    const moved = await runStorePlanInRequest(backupEnds(fx.deps, place), newStorePlan([GRAPH]), noWait);
    if (!('done' in moved)) throw new Error('the backup did not finish');
    const short = { ...fx.backups, listStorePages: async (input: Parameters<typeof fx.backups.listStorePages>[0]) => (await fx.backups.listStorePages(input)).slice(1) };
    await expect(writeBackupIndex(short, place, scopeObject, moved.done)).rejects.toMatchObject({ status: 502 });
    expect(await fx.backups.getIndex(place)).toBeNull();
  });

  it('an index whose page count disagrees with its pages refuses before any page is read', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 25);
    const index = await backedUp(fx);
    const lying = [{ ...index.stores[0]!, pageCount: index.stores[0]!.pageCount + 1 }];
    await expect(runStorePlanInRequest(restoreEnds(fx.deps, place, place, lying), newStorePlan([GRAPH]), noWait)).rejects.toMatchObject({ status: 422 });
    expect(fx.driver.callsOf('substrat.stage-page')).toBe(0);
  });

  it('a backup past the most one store may hold refuses, and is not retried', async () => {
    const fx = fixture(1);
    const ends = backupEnds(fx.deps, place)(GRAPH);
    await expect(ends.write('M', STORE_BACKUP_MAX_PAGES, [])).rejects.toMatchObject({ status: 413 });
    await expect(ends.write('M', STORE_BACKUP_MAX_PAGES - 1, [])).resolves.toEqual({ held: false });
  });
});

describe('limits count what they say (D-69)', () => {
  it('the page limit counts reads, not the places a re-cut took', async () => {
    let reads = 0;
    const ends = {
      read: async () => { reads += 1; return { tables: [], next: reads < 3 ? String(reads) : null, revision: 'r' }; },
      write: async () => ({ held: false, pages: STORE_MOVE_MAX_PAGES }),
      discard: async () => undefined,
    };
    expect(await movePages(ends, newPageMove(), 'x')).toMatchObject({ done: { reads: 3, seq: 3 * STORE_MOVE_MAX_PAGES } });
  });

  it('a store whose size says twice the cap is refused before anything is written, and one near it is not', async () => {
    const fx = fixture(10);
    const bytes = (pages: number) => pages * storeDriverDumpPageBytes('graph');
    fx.driver.intercept((call) => (call.operation === 'substrat.size' ? Response.json({ result: { bytes: bytes(2 * STORE_BACKUP_MAX_PAGES + 1) } }) : undefined));
    const call = fx.stores.callStore({ ...GRAPH, tenantId: 'T', scopeId: 'S', vertical: 'crm' });
    await expect(refuseOverCap(call, GRAPH)).rejects.toMatchObject({ status: 413 });
    fx.driver.intercept((seen) => (seen.operation === 'substrat.size' ? Response.json({ result: { bytes: bytes(2 * STORE_BACKUP_MAX_PAGES) } }) : undefined));
    await expect(refuseOverCap(call, GRAPH)).resolves.toBeUndefined();
  });

  it('a chain stopped under writes says so, not that the store is too large', () => {
    const plan = newStorePlan([GRAPH]);
    expect(unfinishedInRequest('A backup of it', plan, 'Way.').message).toContain('too many pages');
    const contended = { ...plan, move: { ...plan.move, attempt: 2 } };
    const { message } = unfinishedInRequest('A backup of it', contended, 'Way.');
    expect(message).toContain('written to while being read');
    expect(message).not.toContain('too many pages');
  });
});

describe('a store call under a deadline and a retry (D-69)', () => {
  it('a driver failing every call once still moves the whole store, and each page goes once', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 95);
    fx.driver.intercept((call) => (call.nth === 1 ? new Response('down', { status: 503 }) : undefined));
    const index = await backedUp(fx);
    expect(index.stores[0]!.pageCount).toBe(10);
    fx.driver.intercept(undefined);
    fx.driver.put(object(), 1);
    fx.driver.intercept((call) => (call.nth === 1 && call.operation !== 'substrat.export-page' ? new Response('down', { status: 503 }) : undefined));
    const moved = await runStorePlanInRequest(restoreEnds(fx.deps, place, place, index.stores), newStorePlan([GRAPH]), noWait);
    if (!('done' in moved)) throw new Error('the restore did not finish');
    await commitStages(fx.stores, place, moved.done);
    expect(fx.driver.idsOf(object())).toHaveLength(95);
  });

  it('a stage answer that was lost retries as staged, and a commit answer that was lost answers the same count', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 25);
    const index = await backedUp(fx);
    fx.driver.put(object(), 1);
    fx.driver.intercept((call) => (call.nth === 1 && ['substrat.stage-page', 'substrat.commit-stage'].includes(call.operation) ? 'lost' : undefined));
    const moved = await runStorePlanInRequest(restoreEnds(fx.deps, place, place, index.stores), newStorePlan([GRAPH]), noWait);
    if (!('done' in moved)) throw new Error('the restore did not finish');
    await commitStages(fx.stores, place, moved.done);
    expect(fx.driver.idsOf(object())).toHaveLength(25);
    expect(fx.driver.callsOf('substrat.commit-stage')).toBe(2);
  });

  it('a stage answer lost in a snapshot retries as staged, under the same stage', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 25);
    fx.driver.intercept((call) => (call.operation === 'substrat.stage-page' && call.nth === 1 ? 'lost' : undefined));
    const moved = await runStorePlanInRequest(snapshotEnds(fx.stores, { tenantId: 'T', vertical: 'crm', from: 'S', to: 'FORK' }), newStorePlan([GRAPH]), noWait);
    if (!('done' in moved)) throw new Error('the copy did not finish');
    expect(fx.driver.callsOf('substrat.discard-stage')).toBe(0);
    expect(fx.driver.stageOf(object('GRAPH', 'FORK'))?.id).toBe(moved.done[0]!.moveId);
  });

  it.each([
    ['a 413 from the store entry', 413, 'payload_too_large'],
    ['a 404', 404, 'not_found'],
    ['a 403', 403, 'forbidden'],
  ])('%s is never retried, and fails the move', async (_what, status, code) => {
    const fx = fixture(10);
    fx.driver.put(object(), 25);
    fx.driver.intercept((call) => (call.operation === 'substrat.export-page' ? Response.json({ error: { code, status } }) : undefined));
    await expect(runStorePlanInRequest(backupEnds(fx.deps, place), newStorePlan([GRAPH]), noWait)).rejects.toMatchObject({ status });
    expect(fx.driver.callsOf('substrat.export-page')).toBe(1);
  });

  it('a page over the 5 MB limit is refused before it is sent, and is not retried', async () => {
    const fx = fixture(10);
    const dropped = { key: 'x', bytes: 1, digest: '0'.repeat(64) };
    const backups = {
      ...fx.backups,
      readObject: async () => JSON.stringify({ tables: [{ name: 'nodes', ddl: 'd', columns: ['id'], rows: [['x'.repeat(STORE_CALL_MAX_BYTES)]] }] }),
    };
    const store = { ...GRAPH, revision: 'r1', tables: 1, pageCount: 1, pages: [dropped] };
    await expect(runStorePlanInRequest(restoreEnds({ stores: fx.stores, backups }, place, place, [store]), newStorePlan([GRAPH]), noWait)).rejects.toMatchObject({ status: 413 });
    expect(fx.driver.callsOf('substrat.stage-page')).toBe(0);
  });

  it('a call that never answers ends at its deadline, as a transient fault', async () => {
    const hanging = fakeStoreDriver();
    const stores = platformOver({ fetch: () => new Promise<Response>(() => undefined) }, { deadlineMs: 5, retryDelaysMs: [0] });
    await expect(stores.callStore({ ...GRAPH, tenantId: 'T', scopeId: 'S', vertical: 'crm' })('substrat.size')).rejects.toMatchObject({ status: 504 });
    expect(hanging.calls).toEqual([]);
  });

  it('an unreachable store script is a fault to retry, not a route error', async () => {
    let tries = 0;
    const stores = platformOver({ fetch: async () => { tries += 1; throw new Error('no such script'); } });
    await expect(stores.callStore({ ...GRAPH, tenantId: 'T', scopeId: 'S', vertical: 'crm' })('substrat.size')).rejects.toMatchObject({ status: 502 });
    expect(tries).toBe(3);
  });
});

describe('a chain whose revision moves starts again, backing off (D-69)', () => {
  it('starts again under a new stage after a write mid-chain, and the stale stage is dropped', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 50);
    const slept: number[] = [];
    let wrote = false;
    fx.driver.intercept((call) => {
      if (call.operation === 'substrat.export-page' && call.input && (call.input as { cursor: unknown }).cursor === '20' && !wrote) {
        wrote = true;
        fx.driver.write(object());
      }
      return undefined;
    });
    const moved = await runStorePlanInRequest(
      snapshotEnds(fx.stores, { tenantId: 'T', vertical: 'crm', from: 'S', to: 'FORK' }),
      newStorePlan([GRAPH]),
      { ...noWait, sleep: async (ms) => { slept.push(ms); } },
    );
    if (!('done' in moved)) throw new Error('the copy did not finish');
    expect(slept).toEqual([storeMoveBackoffMs(1)]);
    expect(moved.done[0]!.pages).toBe(5);
    await commitStages(fx.stores, { tenantId: 'T', scopeId: 'FORK', vertical: 'crm' }, moved.done);
    expect(fx.driver.idsOf(object('GRAPH', 'FORK'))).toHaveLength(50);
  });

  it('a page objects chain started over deletes the pages of the one it gave up', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 30);
    let wrote = false;
    fx.driver.intercept((call) => {
      if (call.operation === 'substrat.export-page' && (call.input as { cursor: unknown }).cursor === '20' && !wrote) {
        wrote = true;
        fx.driver.write(object());
      }
      return undefined;
    });
    const index = await backedUp(fx);
    const kept = [...fx.r2.objects.keys()].filter((key) => key.includes('/stores/'));
    expect(kept.sort()).toEqual(index.stores[0]!.pages.map((page) => page.key).sort());
  });

  it('refuses after each attempt moved, with a growing wait, leaving the object as it was', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 25);
    const before = fx.driver.idsOf(object('GRAPH', 'FORK'));
    const slept: number[] = [];
    fx.driver.intercept((call) => {
      if (call.operation === 'substrat.export-page' && (call.input as { cursor: unknown }).cursor !== null) fx.driver.write(object());
      return undefined;
    });
    await expect(runStorePlanInRequest(
      snapshotEnds(fx.stores, { tenantId: 'T', vertical: 'crm', from: 'S', to: 'FORK' }),
      newStorePlan([GRAPH]),
      { ...noWait, sleep: async (ms) => { slept.push(ms); } },
    )).rejects.toMatchObject({ status: 409 });
    expect(slept).toEqual(Array.from({ length: STORE_MOVE_ATTEMPTS - 1 }, (_, i) => storeMoveBackoffMs(i + 1)));
    expect(fx.driver.idsOf(object('GRAPH', 'FORK'))).toEqual(before);
    expect(fx.driver.stageOf(object('GRAPH', 'FORK'))).toBeUndefined();
  });

  it('a driver answering 409 to a read is the same conflict, so it backs off too', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 5);
    let refused = 0;
    fx.driver.intercept((call) => {
      if (call.operation === 'substrat.export-page' && refused < 2) {
        refused += 1;
        return Response.json({ error: { code: 'conflict', status: 409 } });
      }
      return undefined;
    });
    const slept: number[] = [];
    const moved = await runStorePlanInRequest(backupEnds(fx.deps, place), newStorePlan([GRAPH]), { ...noWait, sleep: async (ms) => { slept.push(ms); } });
    expect('done' in moved).toBe(true);
    expect(slept).toHaveLength(2);
  });

  it('a chain that does not move is refused as the driver\'s fault', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 25);
    fx.driver.intercept((call) => (call.operation === 'substrat.export-page' && (call.input as { cursor: unknown }).cursor === '10'
      ? Response.json({ result: { tables: [], next: '10', revision: 'r2' } })
      : undefined));
    await expect(runStorePlanInRequest(backupEnds(fx.deps, place), newStorePlan([GRAPH]), noWait)).rejects.toMatchObject({ status: 502 });
  });
});

describe('a store read for one body is bounded (D-69)', () => {
  it('counts a row beyond its bytes, so many small rows refuse long before the memory they parse to', async () => {
    const driver = fakeStoreDriver({ pageRows: 10 });
    driver.put(object(), 500);
    const call = platformOver(driver).callStore({ ...GRAPH, tenantId: 'T', scopeId: 'S', vertical: 'crm' });
    // These rows serialize to well under this budget; at 64 bytes each on top they do not fit.
    const serialized = JSON.stringify(driver.objects.get(object())!.tables).length;
    expect(serialized).toBeLessThan(10_000);
    await expect(readStoreForBody(call, GRAPH, 'S', { left: 10_000, limit: 10_000 })).rejects.toMatchObject({ status: 413 });
  });

  it('counts its calls across chains: chains started over spend the same request', async () => {
    const driver = fakeStoreDriver({ pageRows: 10 });
    driver.put(object(), 25);
    driver.intercept((call) => {
      if (call.operation === 'substrat.export-page' && (call.input as { cursor: unknown }).cursor !== null) driver.write(object());
      return undefined;
    });
    const call = platformOver(driver).callStore({ ...GRAPH, tenantId: 'T', scopeId: 'S', vertical: 'crm' });
    await expect(readStoreForBody(call, GRAPH, 'S', { left: 1_000_000, limit: 1_000_000 }, { pages: 5, ms: 1000, sleep: async () => undefined })).rejects.toMatchObject({ status: 413 });
    expect(driver.callsOf('substrat.export-page')).toBe(5);
  });

  it('refuses past the budget with 413, naming the size, having read no more than fits', async () => {
    const driver = fakeStoreDriver({ pageRows: 10 });
    driver.put(object(), 100_000);
    const call = platformOver(driver).callStore({ ...GRAPH, tenantId: 'T', scopeId: 'S', vertical: 'crm' });
    const budget = { left: 5_000, limit: 5_000 };
    await expect(readStoreForBody(call, GRAPH, 'S', budget)).rejects.toMatchObject({
      status: 413,
      message: expect.stringMatching(/store 'GRAPH' does not fit in one answer, which carries at most 5000 bytes.*reports about \d+ bytes.*No path exports.*cannot be downloaded/),
    });
    expect(driver.callsOf('substrat.export-page')).toBeLessThan(40);
  });

  it('a store of tiny pages refuses for the calls it would take, not for its bytes', async () => {
    const driver = fakeStoreDriver({ pageRows: 1 });
    driver.put(object(), 50);
    const call = platformOver(driver).callStore({ ...GRAPH, tenantId: 'T', scopeId: 'S', vertical: 'crm' });
    const error = await readStoreForBody(call, GRAPH, 'S', { left: 1_000_000, limit: 1_000_000 }, { pages: 5, ms: 1000 }).catch((e: Error) => e);
    expect(error).toMatchObject({ status: 413, message: expect.stringMatching(/more than the 5 page reads one request can make.*No path exports/) });
    expect((error as Error).message).not.toContain('does not fit');
  });

  it('spends one budget across stores, and answers a store that fits whole', async () => {
    const driver = fakeStoreDriver({ pageRows: 10 });
    driver.put(object(), 25);
    driver.put(object('OTHER'), 25);
    const stores = platformOver(driver);
    const budget = { left: 10_000, limit: 10_000 };
    const tables = await readStoreForBody(stores.callStore({ ...GRAPH, tenantId: 'T', scopeId: 'S', vertical: 'crm' }), GRAPH, 'S', budget);
    expect(tables[0]!.rows).toHaveLength(25);
    expect(budget.left).toBeLessThan(10_000);
    budget.left = 1;
    await expect(readStoreForBody(stores.callStore({ ...OTHER, tenantId: 'T', scopeId: 'S', vertical: 'crm' }), OTHER, 'S', budget)).rejects.toMatchObject({ status: 413 });
  });

  it('answers whether a store holds rows after one call, whatever its size', async () => {
    const driver = fakeStoreDriver({ pageRows: 10 });
    driver.put(object(), 100_000);
    driver.put(object('OTHER'), 0);
    const stores = platformOver(driver);
    expect(await storeHoldsRows(stores.callStore({ ...GRAPH, tenantId: 'T', scopeId: 'S', vertical: 'crm' }))).toBe(true);
    expect(driver.callsOf('substrat.export-page')).toBe(1);
    expect(await storeHoldsRows(stores.callStore({ ...OTHER, tenantId: 'T', scopeId: 'S', vertical: 'crm' }))).toBe(false);
  });
});

describe('a store job resumes from cursors alone (D-69)', () => {
  const actor = 'staff' as PlatformActorId;
  const scopeRecord: { status: string } = { status: 'active' };
  const specOf = (kind: StoreJobSpec['kind']): StoreJobSpec => ({
    id: `${kind}:S`, kind, tenantId: 'T' as TenantId, scopeId: 'S' as ScopeId, vertical: 'crm', capturedAt: place.capturedAt,
    ...(kind === 'store-backup' ? { scopeObject } : {}),
    actor, startedAt: 0, deadline: Number.MAX_SAFE_INTEGER,
  });
  const jobsOver = (fx: ReturnType<typeof fixture>, stepPages = 2) => {
    // A step's budget, in pages rather than real time: each call of the clock is a tick.
    let ticks = 0;
    const deps: StoreJobDeps = {
      stores: fx.stores,
      backups: fx.backups,
      admin: { getScopeRecord: async () => scopeRecord } as unknown as StoreJobDeps['admin'],
      now: () => (ticks += 1),
    };
    return { deps, jobs: memoryStoreJobs(deps, { stepMs: stepPages }) };
  };
  const pumpToEnd = async (jobs: ReturnType<typeof memoryStoreJobs>, id: string): Promise<StoreJobRecord> => {
    for (let i = 0; i < 200; i += 1) {
      const job = (await jobs.pump(id))!;
      if (job.status !== 'copying') return job;
    }
    throw new Error('the job did not end');
  };

  it('a backup job ends with its index, and its record never holds a row', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 200);
    const { jobs } = jobsOver(fx);
    const spec = specOf('store-backup');
    await jobs.start(spec, newStorePlan([GRAPH]));
    let job = await jobs.get(spec.id);
    while (job!.status === 'copying') {
      expect(JSON.stringify(job)).not.toContain('"n1"');
      job = await jobs.pump(spec.id);
      expect(fx.driver.held.now).toBe(0);
    }
    expect(job!.status).toBe('done');
    expect(job!.done?.backup?.capturedAt).toBe(place.capturedAt);
    const index = await fx.backups.getIndex(place);
    expect(index?.stores[0]?.pageCount).toBe(20);
    expect(fx.driver.held.peak).toBeLessThanOrEqual(10);
  });

  it.each([
    ['a step that died after writing pages, its record never stored', true],
    ['a step that answered', false],
  ])('a backup resumed after %s still holds every row', async (_what, dies) => {
    const fx = fixture(10);
    fx.driver.put(object(), 60);
    const { deps, jobs } = jobsOver(fx);
    const spec = specOf('store-backup');
    await jobs.start(spec, newStorePlan([GRAPH]));
    const before = (await jobs.get(spec.id))!;
    // A step runs and its answer is thrown away: the same record runs again.
    const after = await advanceStoreJob(deps, before, { stepMs: 2 });
    if (!dies) jobs.jobs.set(spec.id, after);
    const job = await pumpToEnd(jobs, spec.id);
    expect(job.status).toBe('done');
    const index = (await fx.backups.getIndex(place))!;
    expect(index.stores[0]!.pageCount).toBe(6);
    const ids = await Promise.all(index.stores[0]!.pages.map(async (ref) =>
      (JSON.parse((await fx.backups.readObject({ ...place, ref }))!) as { tables: { rows: unknown[][] }[] }).tables[0]!.rows.map((row) => row[0])));
    expect(ids.flat()).toEqual(fx.driver.idsOf(object()));
  });

  it('a restore resumed from an older record goes on under the same stage: its pages are immutable and verified', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 60);
    const index = await backedUp(fx);
    fx.driver.put(object(), 1);
    const { deps, jobs } = jobsOver(fx);
    const spec = specOf('store-restore');
    await jobs.start(spec, newStorePlan([GRAPH]));
    const before = (await jobs.get(spec.id))!;
    // A step stages some pages and its answer is thrown away, so the stored record is behind the stage.
    await advanceStoreJob(deps, before, { stepMs: 2 });
    const firstStage = fx.driver.stageOf(object())!.id;
    expect(firstStage).toBe(before.state!.move.moveId);
    const job = await pumpToEnd(jobs, spec.id);
    expect(job.status).toBe('done');
    expect(job.done!.moved[0]!.moveId).toBe(firstStage);
    expect(job.attempt).toBe(before.attempt);
    expect(fx.driver.callsOf('substrat.discard-stage')).toBe(0);
    expect(fx.driver.idsOf(object())).toHaveLength(1);
    await commitStages(fx.stores, place, job.done!.moved);
    expect(fx.driver.idsOf(object())).toHaveLength(index.stores[0]!.pageCount * 10);
  });

  it('a step stops at its pages, however much time it has left: an alarm has a request\'s subrequests', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 60);
    const { deps } = jobsOver(fx);
    const job = await advanceStoreJob(deps, { ...(await memoryStoreJobs(deps).start(specOf('store-backup'), newStorePlan([GRAPH]))) }, { stepMs: 1_000_000, stepPages: 2 });
    expect(job).toMatchObject({ status: 'copying', pages: 2 });
    expect(fx.driver.callsOf('substrat.export-page')).toBe(2);
  });

  it('a fault before the index is ridden out: the next step writes it', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 20);
    const { jobs } = jobsOver(fx, 1000);
    const spec = specOf('store-backup');
    await jobs.start(spec, newStorePlan([GRAPH]));
    fx.r2.failPutWhen((key) => key.endsWith(`${place.capturedAt}.json`));
    const faulted = (await jobs.pump(spec.id))!;
    expect(faulted).toMatchObject({ status: 'copying', faults: 1 });
    expect(await fx.backups.get(place)).toBeNull();
    fx.r2.failPutWhen(undefined);
    expect((await jobs.pump(spec.id))!.status).toBe('done');
    expect((await fx.backups.getIndex(place))?.stores[0]?.pageCount).toBe(2);
  });

  it('a backup job that fails leaves nothing behind, and is no backup', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 30);
    const { jobs } = jobsOver(fx);
    const spec = specOf('store-backup');
    await jobs.start(spec, newStorePlan([GRAPH]));
    await jobs.pump(spec.id);
    expect(fx.r2.objects.size).toBeGreaterThan(0);
    fx.driver.intercept((call) => (call.operation === 'substrat.export-page' ? Response.json({ error: { code: 'forbidden', status: 403 } }) : undefined));
    const job = (await jobs.pump(spec.id))!;
    expect(job).toMatchObject({ status: 'failed', error: { status: 403 } });
    expect(fx.r2.objects.size).toBe(0);
  });

  it('transient faults back off and fail the job past the limit', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 30);
    const { jobs } = jobsOver(fx);
    const spec = specOf('store-backup');
    await jobs.start(spec, newStorePlan([GRAPH]));
    fx.driver.intercept(() => new Response('down', { status: 503 }));
    const delays: number[] = [];
    let job = (await jobs.get(spec.id))!;
    while (job.status === 'copying') {
      job = (await jobs.pump(spec.id))!;
      delays.push(job.nextDelayMs);
    }
    expect(job.status).toBe('failed');
    expect(job.error?.message).toContain('after 6 attempts');
    expect(delays.slice(0, 2)).toEqual([2_000, 4_000]);
  });

  it('a scope reaped while a backup job runs stops it and drops what it wrote', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 30);
    const { jobs } = jobsOver(fx);
    const spec = specOf('store-backup');
    await jobs.start(spec, newStorePlan([GRAPH]));
    await jobs.pump(spec.id);
    const read = fx.driver.callsOf('substrat.export-page');
    scopeRecord.status = 'reaped';
    try {
      expect((await jobs.pump(spec.id))!).toMatchObject({ status: 'failed', error: { status: 409 } });
      expect(fx.r2.objects.size).toBe(0);
      expect(fx.driver.callsOf('substrat.export-page')).toBe(read);
    } finally {
      scopeRecord.status = 'active';
    }
  });

  it('a mangled page fails a restore job before any commit, and its stage is discarded', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 30);
    const index = await backedUp(fx);
    fx.driver.put(object(), 1);
    const victim = index.stores[0]!.pages[1]!.key;
    fx.r2.objects.get(victim)!.body = fx.r2.objects.get(victim)!.body.replace('n1', 'nX');
    const { jobs } = jobsOver(fx, 1000);
    const spec = specOf('store-restore');
    await jobs.start(spec, newStorePlan([GRAPH]));
    const job = await pumpToEnd(jobs, spec.id);
    expect(job).toMatchObject({ status: 'failed', error: { status: 422 } });
    expect(fx.driver.stageOf(object())).toBeUndefined();
    expect(fx.driver.callsOf('substrat.commit-stage')).toBe(0);
    expect(fx.driver.idsOf(object())).toHaveLength(1);
  });

  it('a transient fault mid-restore costs no chain: the next step goes on from its record', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 60);
    await backedUp(fx);
    fx.driver.put(object(), 1);
    const { jobs } = jobsOver(fx, 1000);
    const spec = specOf('store-restore');
    await jobs.start(spec, newStorePlan([GRAPH]));
    let failing = true;
    fx.driver.intercept((call) => (failing && call.operation === 'substrat.stage-page' && (call.input as { seq: number }).seq === 3 ? new Response('down', { status: 503 }) : undefined));
    expect(await jobs.pump(spec.id)).toMatchObject({ status: 'copying', faults: 1 });
    failing = false;
    const job = await pumpToEnd(jobs, spec.id);
    expect(job.status).toBe('done');
    await commitStages(fx.stores, place, job.done!.moved);
    expect(fx.driver.idsOf(object())).toHaveLength(60);
    expect(fx.driver.callsOf('substrat.discard-stage')).toBe(0);
  });

  it('a backup whose scope is reaped while its last pages move writes no index', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 20);
    const { jobs } = jobsOver(fx, 1000);
    const spec = specOf('store-backup');
    await jobs.start(spec, newStorePlan([GRAPH]));
    fx.driver.intercept((call) => {
      if (call.operation === 'substrat.export-page' && (call.input as { cursor: unknown }).cursor === '10') scopeRecord.status = 'reaped';
      return undefined;
    });
    try {
      expect(await jobs.pump(spec.id)).toMatchObject({ status: 'failed', error: { status: 409 } });
      expect(await fx.backups.get(place)).toBeNull();
      expect([...fx.r2.objects.keys()]).toEqual([]);
    } finally {
      scopeRecord.status = 'active';
    }
  });

  it('bindings that cannot be built are a counted fault, and past the deadline the job still fails', async () => {
    const job = newStoreJob(specOf('store-backup'), newStorePlan([GRAPH]));
    const throwing = () => { throw new Error('no such binding'); };
    expect(await advanceStoreJob(throwing, job)).toMatchObject({ status: 'copying', faults: 1, nextDelayMs: 2_000 });
    expect(await advanceStoreJob(throwing, { ...job, faults: 5 })).toMatchObject({ status: 'failed', error: { status: 500, message: expect.stringContaining('after 6 attempts') } });
    const late = { ...job, spec: { ...job.spec, deadline: 0 } };
    expect(await advanceStoreJob(throwing, late)).toMatchObject({ status: 'failed', error: { status: 504 } });
  });

  it('a job cuts at the size its spec fixed, not at what the driver declares by now', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 30);
    const index = await backedUp(fx);
    const { jobs } = jobsOver(fx, 1000);
    const spec = { ...specOf('store-restore'), pageBytes: { graph: 90 } };
    await jobs.start(spec, newStorePlan([GRAPH]));
    await pumpToEnd(jobs, spec.id);
    expect(fx.driver.stageOf(object())!.pages.length).toBeGreaterThan(index.stores[0]!.pageCount);
  });

  it('a fault leaves no page object its stored record does not name', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 15);
    fx.driver.put(object('OTHER'), 15);
    const { jobs } = jobsOver(fx, 1000);
    const spec = specOf('store-backup');
    await jobs.start(spec, newStorePlan([GRAPH, OTHER]));
    fx.driver.intercept((call) => (call.operation === 'substrat.export-page' && call.objectName === object('OTHER') && (call.input as { cursor: unknown }).cursor === '10'
      ? new Response('down', { status: 503 })
      : undefined));
    const stored = (await jobs.pump(spec.id))!;
    expect(stored).toMatchObject({ status: 'copying', faults: 1 });
    expect(stored.state!.at).toBe(0);
    const named = stored.state!.move.moveId;
    const pages = [...fx.r2.objects.keys()].filter((key) => key.includes('/stores/'));
    expect(pages.length).toBeGreaterThan(0);
    for (const key of pages) expect(key).toContain(named);
    fx.driver.intercept(undefined);
    expect((await pumpToEnd(jobs, spec.id)).status).toBe('done');
  });

  it('a job that fails gives up what it moved past its stored record too', async () => {
    const fx = fixture(10);
    fx.driver.put(object(), 15);
    fx.driver.put(object('OTHER'), 15);
    const { jobs } = jobsOver(fx, 1000);
    const spec = specOf('store-backup');
    await jobs.start(spec, newStorePlan([GRAPH, OTHER]));
    fx.driver.intercept((call) => (call.operation === 'substrat.export-page' && call.objectName === object('OTHER') && (call.input as { cursor: unknown }).cursor === '10'
      ? Response.json({ error: { code: 'forbidden', status: 403 } })
      : undefined));
    expect(await jobs.pump(spec.id)).toMatchObject({ status: 'failed' });
    expect([...fx.r2.objects.keys()]).toEqual([]);
  });

  it('a job whose steps have stopped reads as failed, so a caller settles it', () => {
    const job = { spec: specOf('store-backup'), status: 'copying', updatedAt: 0 } as StoreJobRecord;
    expect(storeJobAt(job, STORE_JOB_STALL_MS).status).toBe('copying');
    expect(storeJobAt(job, STORE_JOB_STALL_MS + 1)).toMatchObject({ status: 'failed', error: { status: 504 } });
  });
});
