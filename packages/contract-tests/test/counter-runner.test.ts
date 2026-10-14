/**
 * #2213: the trivial kind is the runner a kind's author reads first, so its answers are
 * pinned here as well as by the suite: a size is always a valid `{ bytes }`, an erase
 * counts only what a subject actually had, and nothing about a subject outlives a wipe
 * or an import.
 */
import { describe, expect, it } from 'vitest';
import { callReservedStoreOperation, callScopeStore, type ScopeStoreAddress } from '@substrat-run/kernel';
import { counterScopeStoreRunner } from '../src/counter-runner.js';

const address: ScopeStoreAddress = { tenantId: 't', vertical: 'v', scopeId: 's', binding: 'B' };

function counter() {
  const runner = counterScopeStoreRunner();
  const send = (request: Parameters<typeof runner.invoke>[1]) => runner.invoke(address, request);
  return {
    call: (operation: string, input?: unknown) => callScopeStore(send, operation, input),
    erase: (subjectId: string) => callReservedStoreOperation(send, 'substrat.erase', { subjectId }),
    size: () => callReservedStoreOperation(send, 'substrat.size'),
    wipe: () => callReservedStoreOperation(send, 'substrat.wipe'),
    exportTables: () => callReservedStoreOperation(send, 'substrat.export'),
    importTables: (tables: unknown) => callReservedStoreOperation(send, 'substrat.import', { tables }),
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
    const { tables } = await source.exportTables();
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
});
