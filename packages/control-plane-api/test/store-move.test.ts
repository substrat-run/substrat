import { describe, expect, it } from 'vitest';
import { moveStores, type StoreRequestBudget } from '../src/store-move.js';
import { commitStages, snapshotEnds, StoreLandFailure, storeHoldsRows } from '../src/store-move-ends.js';
import { fakeStoreDriver, platformOver, storeObject } from './helpers/store-fakes.js';

/**
 * The store-move stepper (D-69), driven through the real signed caller over a fake driver that keeps
 * the paged contract. A snapshot's ends (store to stage) stand for every end: the stepper is the same.
 */
const from = { tenantId: 'T', scopeId: 'S1', vertical: 'acme/crm' };
const to = { ...from, scopeId: 'S2' };
const GRAPH = { binding: 'GRAPH', driver: 'graph' };
const DOCS = { binding: 'DOCS', driver: 'graph' };
const objectOf = (place: typeof from, binding: string) => storeObject(place.tenantId, place.vertical, place.scopeId, binding);
const noWait = (waits: number[] = []): StoreRequestBudget => ({ pages: 300, ms: 60_000, sleep: async (ms) => void waits.push(ms) });
const noRetry = <T>(run: () => Promise<T>) => run();

function world(pageRows = 10) {
  const driver = fakeStoreDriver({ pageRows });
  const caller = platformOver(driver);
  return { driver, caller, ends: snapshotEnds(caller, from, to) };
}

describe('the store-move stepper (D-69)', () => {
  it('stages every store page by page, changes nothing until the commits, and loses no row', async () => {
    const { driver, caller, ends } = world();
    driver.put(objectOf(from, 'GRAPH'), 35);
    driver.put(objectOf(from, 'DOCS'), 3);
    const moved = await moveStores(ends, [GRAPH, DOCS], 'the stores', noWait());
    expect(moved.map((m) => [m.binding, m.pages, m.tables])).toEqual([['GRAPH', 4, 1], ['DOCS', 1, 1]]);
    expect(driver.idsOf(objectOf(to, 'GRAPH'))).toEqual([]);
    expect(await commitStages(caller, to, moved, noRetry)).toEqual(['GRAPH', 'DOCS']);
    expect(driver.idsOf(objectOf(to, 'GRAPH'))).toEqual(driver.idsOf(objectOf(from, 'GRAPH')));
    expect(driver.idsOf(objectOf(to, 'DOCS'))).toHaveLength(3);
  });

  it('starts a chain again under a new stage when its revision moves, after a wait, and drops the stale stage', async () => {
    const { driver, ends } = world();
    driver.put(objectOf(from, 'GRAPH'), 25);
    let wrote = false;
    driver.before(async (call) => {
      if (!wrote && call.operation === 'substrat.export-page' && call.input && (call.input as { cursor: unknown }).cursor !== null) {
        wrote = true;
        driver.write(objectOf(from, 'GRAPH'));
      }
    });
    const waits: number[] = [];
    const [moved] = await moveStores(ends, [GRAPH], 'the stores', noWait(waits));
    expect(waits).toEqual([1_000]);
    const discarded = driver.calls.filter((c) => c.operation === 'substrat.discard-stage').map((c) => (c.input as { stageId: string }).stageId);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).not.toBe(moved!.moveId);
    expect(driver.stageOf(objectOf(to, 'GRAPH'))?.id).toBe(moved!.moveId);
  });

  it('refuses after five chains each moved, waiting 1, 2, 4 and 8 s, with the far end holding nothing', async () => {
    const { driver, ends } = world();
    driver.put(objectOf(from, 'GRAPH'), 25);
    driver.before(async (call) => {
      if (call.operation === 'substrat.export-page' && (call.input as { cursor: unknown }).cursor !== null) driver.write(objectOf(from, 'GRAPH'));
    });
    const waits: number[] = [];
    const refused = moveStores(ends, [GRAPH], 'the stores', noWait(waits));
    await expect(refused).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/written to throughout 5 reads/) });
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(driver.stageOf(objectOf(to, 'GRAPH'))).toBeUndefined();
  });

  it('refuses past its page budget, naming it, and discards every stage it made', async () => {
    const { driver, ends } = world();
    driver.put(objectOf(from, 'DOCS'), 5);
    driver.put(objectOf(from, 'GRAPH'), 50);
    const refused = moveStores(ends, [DOCS, GRAPH], 'the stores', { ...noWait(), pages: 3 });
    await expect(refused).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/budget of 3 pages/) });
    expect(driver.stageOf(objectOf(to, 'DOCS'))).toBeUndefined();
    expect(driver.stageOf(objectOf(to, 'GRAPH'))).toBeUndefined();
  });

  it("refuses a chain that answers the cursor it was asked with, as the driver's fault", async () => {
    const { driver, ends } = world();
    driver.intercept((call) =>
      call.operation === 'substrat.export-page'
        ? Response.json({ result: { tables: [], next: 'same', revision: 'r' } })
        : undefined,
    );
    const stuck = moveStores(ends, [GRAPH], 'the stores', noWait());
    // The first page names `same`; asked with it, the driver names it again.
    await expect(stuck).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/does not move/) });
  });

  it('a commit answering another count fails as a part landing, naming what was committed, and discards the rest', async () => {
    const { driver, caller, ends } = world();
    driver.put(objectOf(from, 'DOCS'), 2);
    driver.put(objectOf(from, 'GRAPH'), 2);
    driver.put(objectOf(from, 'MAIL'), 2);
    const moved = await moveStores(ends, [DOCS, GRAPH, { binding: 'MAIL', driver: 'graph' }], 'the stores', noWait());
    driver.intercept((call) =>
      call.operation === 'substrat.commit-stage' && call.objectName === objectOf(to, 'GRAPH') ? Response.json({ result: { tables: 7 } }) : undefined,
    );
    const failed = commitStages(caller, to, moved, noRetry);
    await expect(failed).rejects.toBeInstanceOf(StoreLandFailure);
    await expect(failed).rejects.toMatchObject({ committed: ['DOCS'], uncommitted: ['GRAPH', 'MAIL'], status: 502 });
    expect(driver.stageOf(objectOf(to, 'MAIL'))).toBeUndefined();
  });

  it('answers whether a store holds rows after one call, whatever its size', async () => {
    const { driver, caller } = world(1);
    driver.put(objectOf(from, 'GRAPH'), 500);
    expect(await storeHoldsRows(caller, from, GRAPH)).toBe(true);
    expect(driver.callsOf('substrat.export-page')).toBe(1);
    expect(await storeHoldsRows(caller, from, DOCS)).toBe(false);
  });
});
