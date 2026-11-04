import { describe, expect, expectTypeOf, it } from 'vitest';
import { errorCodeOf, mergeDumpPages, PLATFORM_STORE_CODE, platformActorId, scopeId, StoreError, STORE_STAGE_MAX_AGE_MS, substratError, tenantId, type ScopeDumpTable, type ScopeId } from '@substrat-run/contracts';
import {
  callReservedStoreOperation,
  callScopeStore,
  observeStoreCall,
  readStoreDump,
  replayStoreErasures,
  scopeStoreLifecycleOf,
  storeDumpPages,
  writeStoreDump,
  type ReservedStoreCall,
  type ScopeStoreRunner,
} from '../src/scope-store.js';
import { ulid } from '../src/ulid.js';
import { SCOPE_COPY_LEASE_MS } from '../src/scope-host.js';
import {
  STORE_CALL_LOG_CAP,
  STORE_CALL_SINK_KEY,
  tallyStoreCall,
  type StoreCallLine,
  type StoreCallTally,
} from '../src/invocation-line.js';

describe('callScopeStore (#2209)', () => {
  it('sends the envelope and returns the result', async () => {
    let sent: unknown;
    const result = await callScopeStore(async (request) => {
      sent = request;
      return { result: 3 };
    }, 'increment', { by: 1 });
    expect(sent).toEqual({ operation: 'increment', input: { by: 1 } });
    expect(result).toBe(3);
  });

  it('refuses a reserved operation before the store is called', async () => {
    let called = false;
    const refusal = await callScopeStore(async () => {
      called = true;
      return { result: 1 };
    }, 'substrat.wipe').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(called).toBe(false);
    expect(errorCodeOf(refusal)).toBe('forbidden');
    expect((refusal as Error).message).toMatch(/reserved/);
  });

  it('refuses a third argument', async () => {
    const refusal = await callScopeStore(async () => ({ result: 1 }), 'read', undefined, { ifMatch: 'x' }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(errorCodeOf(refusal)).toBe('forbidden');
    expect((refusal as Error).message).toMatch(/nothing else/);
  });

  it('shortens a long store code and drops the body of a 5xx', async () => {
    const refusal = await callScopeStore(
      async () => ({ error: { code: 'x'.repeat(80), status: 500, body: { stack: 'secret-trace' } } }),
      'read',
    ).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(refusal).toBeInstanceOf(StoreError);
    const error = refusal as StoreError;
    expect(error.storeCode).toHaveLength(64);
    expect(error.storeBody).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('secret-trace');
  });

  it('raises StoreError from the store envelope, keeping the store code', async () => {
    const refusal = await callScopeStore(async () => ({ error: { code: 'conflict', status: 409, body: { row: 1 } } }), 'write').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(refusal).toBeInstanceOf(StoreError);
    expect(errorCodeOf(refusal)).toBe('conflict');
    expect((refusal as StoreError).storeCode).toBe('conflict');
    expect((refusal as StoreError).storeBody).toEqual({ row: 1 });
  });

  it('refuses a body that is not the envelope', async () => {
    const refusal = await callScopeStore(async () => ({ nope: true }), 'read').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(refusal).toBeInstanceOf(StoreError);
    expect((refusal as StoreError).storeCode).toBe('substrat.bad_envelope');
  });

  it("answers a store's code reserved to the platform as a bad envelope, and keeps it through the platform's hop (#2815)", async () => {
    const answer = async () => ({ error: { code: 'substrat.refused', status: 403 } });
    const caught = (call: Promise<unknown>) => call.then(() => undefined, (err: unknown) => err as StoreError);
    expect(await caught(callScopeStore(answer, 'read'))).toMatchObject({ storeCode: 'substrat.bad_envelope', storeStatus: 502 });
    expect(await caught(callReservedStoreOperation(answer, 'substrat.size'))).toMatchObject({ storeCode: 'substrat.bad_envelope' });
    expect(await caught(callScopeStore({ send: answer, through: 'platform' }, 'read'))).toMatchObject({ code: 'forbidden', storeCode: 'substrat.refused' });
  });
});

describe('scopeStoreLifecycleOf (#2213)', () => {
  const runner = (name: string, log: string[], fail: { start?: number; stop?: boolean } = {}): ScopeStoreRunner => ({
    driver: 'counter',
    async start() {
      log.push(`start ${name}`);
      if ((fail.start ?? 0) > 0) {
        fail.start! -= 1;
        throw new Error(`${name} start broke`);
      }
    },
    async stop() {
      log.push(`stop ${name}`);
      if (fail.stop) throw new Error(`${name} stop broke`);
    },
    async invoke() {
      return { result: 0 };
    },
  });

  it('a retry after a failed start starts only the runners that had not started', async () => {
    const log: string[] = [];
    const a = runner('A', log);
    const b = runner('B', log, { start: 1 });
    const life = scopeStoreLifecycleOf(new Map([['A', a], ['B', b], ['A2', a]]));
    await expect(life.start()).rejects.toThrow(/B start broke/);
    await life.start();
    await life.start();
    expect(log).toEqual(['start A', 'start B', 'start B']);
  });

  it('concurrent starts share one pass', async () => {
    const log: string[] = [];
    const life = scopeStoreLifecycleOf(new Map([['A', runner('A', log)]]));
    await Promise.all([life.start(), life.start()]);
    expect(log).toEqual(['start A']);
  });

  it('a stop that throws does not keep the others running, and its error is the one rethrown', async () => {
    const log: string[] = [];
    const life = scopeStoreLifecycleOf(
      new Map([
        ['A', runner('A', log, { stop: true })],
        ['B', runner('B', log)],
      ]),
    );
    await life.start();
    await expect(life.stop()).rejects.toThrow(/A stop broke/);
    expect(log).toEqual(['start A', 'start B', 'stop A', 'stop B']);
  });
});

describe('scopeStoreLifecycleOf, stopping (#2266)', () => {
  const held = () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return { gate, release };
  };

  it('a stop during a start in flight waits for it, and no runner starts after the stops', async () => {
    const log: string[] = [];
    const a = held();
    const runner = (name: string, gate?: Promise<void>): ScopeStoreRunner => ({
      driver: 'counter',
      async start() {
        log.push(`start ${name}`);
        await gate;
      },
      async stop() {
        log.push(`stop ${name}`);
      },
      async invoke() {
        return { result: 0 };
      },
    });
    const life = scopeStoreLifecycleOf(new Map([['A', runner('A', a.gate)], ['B', runner('B')]]));
    const starting = life.start();
    const stopping = life.stop();
    a.release();
    await expect(starting).rejects.toThrow(/stopping/);
    await stopping;
    expect(log).toEqual(['start A', 'stop A', 'stop B']);
  });

  it('several failed stops are all reported', async () => {
    const failing = (name: string): ScopeStoreRunner => ({
      driver: 'counter',
      async start() {},
      async stop() {
        throw new Error(`${name} stop broke`);
      },
      async invoke() {
        return { result: 0 };
      },
    });
    const life = scopeStoreLifecycleOf(new Map([['A', failing('A')], ['B', failing('B')]]));
    const err = await life.stop().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors.map((e: Error) => e.message)).toEqual(['A stop broke', 'B stop broke']);
  });
});

describe('callReservedStoreOperation (#2207)', () => {
  it('parses a size', async () => {
    let sent: unknown;
    const result = await callReservedStoreOperation(async (request) => {
      sent = request;
      return { result: { bytes: 12 } };
    }, 'substrat.size');
    expect(sent).toEqual({ operation: 'substrat.size' });
    expect(result).toEqual({ bytes: 12 });
  });

  it('refuses an operation that is not reserved, before the store is called', async () => {
    let called = false;
    // The type is the reserved union. This value is the lie a caller could still pass.
    const operation = 'increment' as 'substrat.size';
    const refusal = await callReservedStoreOperation(async () => {
      called = true;
      return { result: { bytes: 1 } };
    }, operation).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(called).toBe(false);
    expect(errorCodeOf(refusal)).toBe('forbidden');
  });

  it('refuses input on an operation that takes none', async () => {
    const refusal = await callReservedStoreOperation(async () => ({ result: { bytes: 1 } }), 'substrat.size', {
      extra: true,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(errorCodeOf(refusal)).toBe('validation_failed');
  });

  it('refuses a size that is not the declared object', async () => {
    const refusal = await callReservedStoreOperation(async () => ({ result: 12 }), 'substrat.size').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(refusal).toBeInstanceOf(StoreError);
    expect((refusal as StoreError).storeCode).toBe('substrat.bad_envelope');
  });

  it('parses an erase, an export page, a stage, a commit and a discard', async () => {
    const table = {
      name: 'counter',
      ddl: 'CREATE TABLE counter (n INTEGER NOT NULL)',
      columns: ['n'],
      rows: [[1]],
    };
    const erased = await callReservedStoreOperation(
      async () => ({ result: { erased: 2 } }),
      'substrat.erase',
      { subjectId: 'subject-1' },
    );
    expect(erased).toEqual({ erased: 2 });
    const page = { tables: [table], next: null, revision: '7' };
    const exported = await callReservedStoreOperation(async () => ({ result: page }), 'substrat.export-page', { cursor: null, maxBytes: 100 });
    expect(exported).toEqual(page);
    const staged = await callReservedStoreOperation(async () => ({ result: { staged: true } }), 'substrat.stage-page', {
      stageId: 's',
      seq: 0,
      tables: [table],
    });
    expect(staged).toEqual({ staged: true });
    const committed = await callReservedStoreOperation(async () => ({ result: { tables: 1 } }), 'substrat.commit-stage', { stageId: 's' });
    expect(committed).toEqual({ tables: 1 });
    const discarded = await callReservedStoreOperation(async () => ({ result: { discarded: false } }), 'substrat.discard-stage', { stageId: 's' });
    expect(discarded).toEqual({ discarded: false });
    const wiped = await callReservedStoreOperation(async () => ({ result: {} }), 'substrat.wipe');
    expect(wiped).toEqual({});
  });

  it('refuses a paged operation whose input is not what it takes, before the store is called', async () => {
    const refuse = async (operation: 'substrat.export-page' | 'substrat.stage-page' | 'substrat.commit-stage' | 'substrat.discard-stage', input: unknown) => {
      let called = false;
      const refusal = await callReservedStoreOperation(
        async () => {
          called = true;
          return { result: {} };
        },
        operation,
        input,
      ).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(called, operation).toBe(false);
      expect(errorCodeOf(refusal), operation).toBe('validation_failed');
      expect((refusal as Error).message, operation).toContain(operation);
    };
    await refuse('substrat.export-page', undefined);
    await refuse('substrat.export-page', { cursor: null, maxBytes: 0 });
    await refuse('substrat.export-page', { cursor: '', maxBytes: 10 });
    await refuse('substrat.stage-page', { stageId: 's', seq: -1, tables: [] });
    await refuse('substrat.stage-page', { stageId: 's', tables: [] });
    await refuse('substrat.commit-stage', { stageId: '' });
    await refuse('substrat.discard-stage', {});
  });

  it('refuses an export page with no revision, and the removed whole-dump operations', async () => {
    const refusal = await callReservedStoreOperation(async () => ({ result: { tables: [], next: null } }), 'substrat.export-page', {
      cursor: null,
      maxBytes: 10,
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect((refusal as StoreError).storeCode).toBe(PLATFORM_STORE_CODE.badEnvelope);
    // The names are still on the reserved prefix, so a call that names them is refused before any store is asked.
    for (const removed of ['substrat.export', 'substrat.import']) {
      const gone = await callScopeStore(async () => ({ result: 1 }), removed).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(gone), removed).toBe('forbidden');
    }
  });
});

type Table = ScopeDumpTable;
const tableOf = (name: string, rows: unknown[][] = []): Table => ({ name, ddl: `CREATE TABLE ${name} (a TEXT)`, columns: ['a'], rows });

/** A small seeded generator, so a failing case reruns the same. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sizeOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

describe('storeDumpPages (D-69)', () => {
  it('gives no tables as one empty page, so an empty stage still replaces the object', () => {
    expect(storeDumpPages([], 100)).toEqual([[]]);
  });

  it('carries every table, empty or not, so its schema travels', () => {
    const pages = storeDumpPages([tableOf('a'), tableOf('b', [['x']]), tableOf('c')], 10_000);
    expect(pages.flat().map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(mergeDumpPages(pages)).toEqual([tableOf('a'), tableOf('b', [['x']]), tableOf('c')]);
  });

  it('puts a row larger than maxBytes in a page of its own, and keeps the rest within it', () => {
    const big = ['y'.repeat(500)];
    const tables = [tableOf('t', [['a'], ['b'], big, ['c']])];
    const pages = storeDumpPages(tables, 120);
    const rowsPerPage = pages.map((page) => page.flatMap((t) => t.rows));
    expect(rowsPerPage.find((rows) => rows.includes(big))).toEqual([big]);
    for (const page of pages) {
      if (page.flatMap((t) => t.rows).includes(big)) continue;
      expect(sizeOf(page)).toBeLessThanOrEqual(120);
    }
    expect(mergeDumpPages(pages)).toEqual(tables);
  });

  it('names a table again on every page it continues on', () => {
    const rows = Array.from({ length: 20 }, (_, i) => [`row-${i}`]);
    const pages = storeDumpPages([tableOf('t', rows)], 90);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.map((t) => t.name)).toEqual(['t']);
  });

  it('is lossless and within the page size, over random row sizes and page sizes', () => {
    const random = seeded(2811);
    for (let round = 0; round < 200; round += 1) {
      const tables = Array.from({ length: Math.floor(random() * 5) }, (_, index) =>
        tableOf(
          `table_${index}`,
          Array.from({ length: Math.floor(random() * 30) }, () => ['z'.repeat(Math.floor(random() * 200))]),
        ),
      );
      const maxBytes = 1 + Math.floor(random() * 600);
      const pages = storeDumpPages(tables, maxBytes);
      expect(pages.length, `round ${round}`).toBeGreaterThan(0);
      expect(mergeDumpPages(pages), `round ${round}`).toEqual(tables);
      for (const page of pages) {
        const rows = page.reduce((sum, t) => sum + t.rows.length, 0);
        // Over the size only by a row that rides alone with its own table, or a heading no smaller page could hold.
        if (sizeOf(page) > maxBytes) expect(rows <= 1 && page.length === 1, `round ${round}: ${sizeOf(page)} > ${maxBytes}`).toBe(true);
      }
    }
  });
});

describe('readStoreDump (D-69)', () => {
  const page = (rows: unknown[][], next: string | null, revision = '1') => ({ tables: [tableOf('t', rows)], next, revision });

  it('asks from the start and merges a chain, handing each cursor back', async () => {
    const asked: unknown[] = [];
    const chain = [page([['a']], 'c1'), page([['b']], 'c2'), page([['c']], null)];
    const dump = await readStoreDump((async (operation: string, input: unknown) => {
      expect(operation).toBe('substrat.export-page');
      asked.push(input);
      return chain[asked.length - 1];
    }) as ReservedStoreCall, 77);
    expect(dump).toEqual([tableOf('t', [['a'], ['b'], ['c']])]);
    expect(asked).toEqual([
      { cursor: null, maxBytes: 77 },
      { cursor: 'c1', maxBytes: 77 },
      { cursor: 'c2', maxBytes: 77 },
    ]);
  });

  it('starts again when the revision changes along a chain, and answers the later read whole', async () => {
    const answers = [page([['old']], 'c1', '1'), page([['moved']], null, '2'), page([['new-a']], 'd1', '2'), page([['new-b']], null, '2')];
    let at = 0;
    const asked: unknown[] = [];
    const dump = await readStoreDump((async (_operation: string, input: unknown) => {
      asked.push(input);
      return answers[at++];
    }) as ReservedStoreCall, 50);
    expect(dump).toEqual([tableOf('t', [['new-a'], ['new-b']])]);
    expect(asked[2]).toEqual({ cursor: null, maxBytes: 50 });
  });

  it('refuses as a conflict once three chains have moved, rather than answer a dump of no one moment', async () => {
    let calls = 0;
    const refusal = await readStoreDump((async () => {
      calls += 1;
      return calls % 2 === 1 ? page([['a']], 'c', String(calls)) : page([['b']], null, String(calls));
    }) as ReservedStoreCall, 50).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(errorCodeOf(refusal)).toBe('conflict');
    expect(calls).toBe(6);
  });

  it('passes a store failure on unchanged', async () => {
    const failure = new Error('down');
    await expect(readStoreDump((async () => Promise.reject(failure)) as ReservedStoreCall, 50)).rejects.toBe(failure);
  });

  it('refuses a chain that answers a cursor it was already asked with: stuck, or in a cycle', async () => {
    // Each chain lists the `next` its pages answer in turn; the read must stop at the first repeat.
    const cases: [string, string[], number][] = [
      ['stuck', ['A', 'A'], 2],
      ['A -> B -> A', ['A', 'B', 'A'], 3],
    ];
    for (const [name, nexts, pages] of cases) {
      let asked = 0;
      const refusal = await readStoreDump((async () => page([['a']], nexts[asked++] ?? null)) as ReservedStoreCall, 50).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(refusal, name).toMatchObject({ storeCode: PLATFORM_STORE_CODE.badEnvelope, storeStatus: 502 });
      expect(asked, name).toBe(pages);
    }
  });

  it('refuses a chain of more than 100 000 pages, and reads one of exactly that many', async () => {
    const chain = (pages: number) => {
      let asked = 0;
      return readStoreDump((async () => {
        asked += 1;
        return page([], asked < pages ? `c${asked}` : null);
      }) as ReservedStoreCall, 50);
    };
    expect(await chain(100_000)).toEqual([tableOf('t', [])]);
    const refusal = await chain(100_001).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(refusal).toMatchObject({ storeCode: PLATFORM_STORE_CODE.badEnvelope, storeStatus: 502 });
  });
});

describe('writeStoreDump (D-69)', () => {
  const rows = Array.from({ length: 12 }, (_, i) => [`row-${i}`]);
  const tables = [tableOf('t', rows), tableOf('empty')];

  /** A store that records its calls and fails the ones `fail` names, by operation and call index. */
  function store(fail: (operation: string, nth: number) => Error | undefined = () => undefined) {
    const calls: { operation: string; input: any }[] = [];
    const names = new Set<string>();
    const call = (async (operation: string, input: any) => {
      const nth = calls.filter((c) => c.operation === operation).length;
      calls.push({ operation, input });
      const failure = fail(operation, nth);
      if (failure) throw failure;
      if (operation === 'substrat.stage-page') for (const table of input.tables) names.add(table.name);
      if (operation === 'substrat.commit-stage') return { tables: names.size };
      if (operation === 'substrat.discard-stage') return { discarded: true };
      return { staged: true };
    }) as ReservedStoreCall;
    return { calls, call };
  }

  it('stages every page in order under one stage id, then commits that stage', async () => {
    const { calls, call } = store();
    const answer = await writeStoreDump(call, tables, 100);
    expect(answer).toEqual({ tables: 2 });
    const staged = calls.slice(0, -1);
    expect(staged.length).toBeGreaterThan(1);
    expect(staged.every((c) => c.operation === 'substrat.stage-page')).toBe(true);
    expect(staged.map((c) => c.input.seq)).toEqual(staged.map((_, i) => i));
    const stageId = staged[0]!.input.stageId;
    expect(new Set(staged.map((c) => c.input.stageId))).toEqual(new Set([stageId]));
    expect(calls.at(-1)).toEqual({ operation: 'substrat.commit-stage', input: { stageId } });
    expect(mergeDumpPages(staged.map((c) => c.input.tables))).toEqual(tables);
  });

  it('refuses a page the store says it did not stage, and discards the stage', async () => {
    const { calls, call } = store((operation, nth) => undefined);
    const lying = (async (operation: string, input: unknown) => {
      if (operation === 'substrat.stage-page' && calls.length === 1) {
        calls.push({ operation, input });
        return { staged: false };
      }
      return call(operation as never, input);
    }) as ReservedStoreCall;
    const refusal = await writeStoreDump(lying, tables, 100).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(refusal).toMatchObject({ storeCode: PLATFORM_STORE_CODE.badEnvelope, storeStatus: 502 });
    expect(calls.map((c) => c.operation)).not.toContain('substrat.commit-stage');
    expect(calls.at(-1)!.operation).toBe('substrat.discard-stage');
  });

  it('refuses a commit that answers another number of tables than the distinct tables sent', async () => {
    for (const wrote of [1, 3]) {
      const { calls, call } = store();
      const miscounting = (async (operation: string, input: unknown) =>
        operation === 'substrat.commit-stage' ? call(operation, input).then(() => ({ tables: wrote })) : call(operation as never, input)) as ReservedStoreCall;
      const refusal = await writeStoreDump(miscounting, tables, 100).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(refusal, String(wrote)).toMatchObject({
        storeCode: PLATFORM_STORE_CODE.badEnvelope,
        storeStatus: 502,
        message: expect.stringContaining('may already have been replaced'),
      });
      expect(calls.at(-1)!.operation).toBe('substrat.discard-stage');
    }
  });

  it('counts a table once however many fragments it was sent as', async () => {
    const { call } = store();
    // 12 rows at 100 bytes are several fragments of one table, and one empty table beside it.
    expect(await writeStoreDump(call, tables, 100)).toEqual({ tables: 2 });
  });

  it('stages an empty dump as one page and commits it', async () => {
    const { calls, call } = store();
    await writeStoreDump(call, [], 100);
    expect(calls.map((c) => c.operation)).toEqual(['substrat.stage-page', 'substrat.commit-stage']);
    expect(calls[0]!.input.tables).toEqual([]);
  });

  it('discards the stage when a page fails, rethrows that failure, and never commits', async () => {
    const failure = new Error('page 2 lost');
    const { calls, call } = store((operation, nth) => (operation === 'substrat.stage-page' && nth === 2 ? failure : undefined));
    await expect(writeStoreDump(call, tables, 100)).rejects.toBe(failure);
    expect(calls.map((c) => c.operation)).toEqual([
      'substrat.stage-page',
      'substrat.stage-page',
      'substrat.stage-page',
      'substrat.discard-stage',
    ]);
    expect(calls.at(-1)!.input.stageId).toBe(calls[0]!.input.stageId);
  });

  it('discards the stage when the commit fails, and rethrows the commit failure', async () => {
    const failure = new Error('commit refused');
    const { calls, call } = store((operation) => (operation === 'substrat.commit-stage' ? failure : undefined));
    await expect(writeStoreDump(call, tables, 100)).rejects.toBe(failure);
    expect(calls.at(-1)!.operation).toBe('substrat.discard-stage');
  });

  it('does not let a failed discard hide the failure that led to it', async () => {
    const original = new Error('page lost');
    const { calls, call } = store((operation) => {
      if (operation === 'substrat.stage-page') return original;
      if (operation === 'substrat.discard-stage') return new Error('discard also lost');
      return undefined;
    });
    await expect(writeStoreDump(call, tables, 100)).rejects.toBe(original);
    expect(calls.map((c) => c.operation)).toEqual(['substrat.stage-page', 'substrat.discard-stage']);
  });
});

describe('replayStoreErasures (#2207)', () => {
  const actor = platformActorId.parse(ulid());
  const tenant = tenantId.parse(ulid());
  const target = scopeId.parse(ulid());
  const source = scopeId.parse(ulid());

  /** Marks per scope, served in pages of `size`, as the directory serves them. A scope absent here is unknown. */
  const adminOf = (marks: Map<ScopeId, string[]>, size = 2, fault?: Error) => ({
    listShreddedSubjects: async (_a: unknown, _t: unknown, scope: ScopeId, cursor?: string) => {
      if (fault && scope === source) throw fault;
      const all = marks.get(scope);
      if (!all) throw substratError('not_found', `unknown scope for tenant: (${tenant}, ${scope})`);
      const from = cursor ? all.indexOf(cursor) + 1 : 0;
      const subjects = all.slice(from, from + size);
      return { subjects, nextCursor: from + size < all.length ? (subjects.at(-1) ?? null) : null };
    },
  });
  const run = (admin: ReturnType<typeof adminOf>, erase: (s: string) => Promise<number>, from = source) =>
    replayStoreErasures({ admin, actor, tenantId: tenant, target, source: from, erase });

  it('walks every page of both scopes and erases each subject once', async () => {
    const erased: string[] = [];
    const result = await run(
      adminOf(new Map([[target, ['a', 'b', 'c']], [source, ['b', 'c', 'd', 'e', 'f']]])),
      async (s) => {
        erased.push(s);
        return 1;
      },
    );
    expect(erased.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(result).toEqual({ storeErasuresReplayed: 6, storeErasureIncomplete: false });
  });

  it('reads the target once when the source is the target', async () => {
    let lists = 0;
    const admin = adminOf(new Map([[target, ['a']]]));
    const counted = { listShreddedSubjects: (...args: Parameters<typeof admin.listShreddedSubjects>) => {
      lists += 1;
      return admin.listShreddedSubjects(...args);
    } };
    expect(await run(counted, async () => 1, target)).toEqual({ storeErasuresReplayed: 1, storeErasureIncomplete: false });
    expect(lists).toBe(1);
  });

  it("an unknown source is reported, and the target's marks are still erased", async () => {
    const erased: string[] = [];
    const result = await run(adminOf(new Map([[target, ['a']]])), async (s) => {
      erased.push(s);
      return 1;
    });
    expect(erased).toEqual(['a']);
    expect(result).toEqual({ storeErasuresReplayed: 1, storeErasureIncomplete: true, storeErasureSourceUnknown: true });
  });

  it('nothing to replay and nothing missing answers nothing, as a restore did before stores', async () => {
    expect(await run(adminOf(new Map([[target, []], [source, []]])), async () => 1)).toBeUndefined();
  });

  it('any other failure to read the source is thrown, not called unknown', async () => {
    const refusal = await run(
      adminOf(new Map([[target, []], [source, []]]), 2, substratError('unavailable', 'directory down')),
      async () => 1,
    ).then(() => undefined, (e: unknown) => e);
    expect(errorCodeOf(refusal)).toBe('unavailable');
  });

  it('a failed erase marks the replay incomplete and the rest still run', async () => {
    const erased: string[] = [];
    const result = await run(adminOf(new Map([[target, ['a', 'b']], [source, []]])), async (s) => {
      if (s === 'a') throw new StoreError({ code: 'unavailable', status: 503 });
      erased.push(s);
      return 1;
    });
    expect(erased).toEqual(['b']);
    expect(result).toEqual({ storeErasuresReplayed: 1, storeErasureIncomplete: true });
  });
});

describe('observeStoreCall (#2245)', () => {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const key = Symbol.for(STORE_CALL_SINK_KEY);
  const withSlot = async (slot: unknown, run: () => Promise<void>) => {
    const before = g[key];
    g[key] = slot;
    try {
      await run();
    } finally {
      g[key] = before;
    }
  };

  it('reports to the current request when no observer is passed, and a passed one wins', async () => {
    const tally: StoreCallTally = {};
    await withSlot({ current: () => (call: StoreCallLine) => tallyStoreCall(tally, call) }, async () => {
      await observeStoreCall('GRAPH', 'read', async () => 1);
      const heard: StoreCallLine[] = [];
      await observeStoreCall('GRAPH', 'write', async () => 1, (r) => heard.push(r));
      expect(heard.map((r) => r.operation)).toEqual(['write']);
    });
    expect(tally.storeCalls?.map((c) => c.operation)).toEqual(['read']);
  });

  it('logs nothing and throws nothing with no slot, an empty one, or a broken one', async () => {
    for (const slot of [undefined, {}, { current: () => undefined }, { current: () => { throw new Error('slot'); } }, { current: () => () => { throw new Error('sink'); } }]) {
      await withSlot(slot, async () => {
        expect(await observeStoreCall('GRAPH', 'read', async () => 5)).toBe(5);
      });
    }
  });

  it('refuses a name that is not a fixed label before the call and before any report', async () => {
    for (const name of ['a:b', 'a b', 'a@b', 'x'.repeat(65)]) {
      let ran = false;
      const heard: StoreCallLine[] = [];
      const refusal = await observeStoreCall('GRAPH', name, async () => { ran = true; }, (r) => heard.push(r)).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(refusal), name).toBe('validation_failed');
      expect(ran).toBe(false);
      expect(heard).toEqual([]);
    }
    expect(await observeStoreCall('GRAPH', 'x'.repeat(64), async () => 1)).toBe(1);
  });

  it('names the first calls, counts the rest, and keeps only the four fields', () => {
    const tally: StoreCallTally = {};
    for (let i = 0; i < STORE_CALL_LOG_CAP + 2; i++) {
      tallyStoreCall(tally, { binding: 'GRAPH', operation: 'read', outcome: 'ok', durationMs: i, input: 'x' } as StoreCallLine);
    }
    expect(tally.storeCalls).toHaveLength(STORE_CALL_LOG_CAP);
    expect(tally.storeCallsDropped).toBe(2);
    expect(Object.keys(tally.storeCalls![0]!).sort()).toEqual(['binding', 'durationMs', 'operation', 'outcome']);
  });
});

describe('callReservedStoreOperation returns the parsed result type (#2239)', () => {
  it('a size read is typed as its schema, not unknown', async () => {
    const size = callReservedStoreOperation(async () => ({ result: { bytes: 4 } }), 'substrat.size');
    expectTypeOf(size).resolves.toEqualTypeOf<{ bytes: number }>();
    expect(await size).toEqual({ bytes: 4 });
  });
});

describe('the age of an abandoned store stage (D-69)', () => {
  it('is the age the scope\'s own staged load holds: six hours of copying and three copy leases', () => {
    expect(STORE_STAGE_MAX_AGE_MS).toBe(6 * 3_600_000 + 3 * SCOPE_COPY_LEASE_MS);
  });
});

describe('a store refusing a page as too large', () => {
  const refusing = (seen: string[]): ReservedStoreCall =>
    ((operation, input) =>
      callReservedStoreOperation(
        async (request) => {
          seen.push(request.operation);
          return request.operation === 'substrat.discard-stage'
            ? { result: { discarded: false } }
            : { error: { code: 'payload_too_large', status: 413 } };
        },
        operation,
        input,
      )) as ReservedStoreCall;

  it('is a StoreError at status 413 with the store\'s code', async () => {
    const error = await callReservedStoreOperation(async () => ({ error: { code: 'payload_too_large', status: 413 } }), 'substrat.size').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(StoreError);
    expect(error).toMatchObject({ storeStatus: 413, storeCode: 'payload_too_large' });
  });

  it('is never retried: a read asks once, a stage-page is sent once', async () => {
    const reads: string[] = [];
    await expect(readStoreDump(refusing(reads), 50)).rejects.toMatchObject({ storeStatus: 413 });
    expect(reads).toEqual(['substrat.export-page']);
    const writes: string[] = [];
    const tables = [{ name: 't', ddl: 'CREATE TABLE t (a TEXT)', columns: ['a'], rows: [['x']] }];
    await expect(writeStoreDump(refusing(writes), tables, 100)).rejects.toMatchObject({ storeStatus: 413 });
    expect(writes.filter((operation) => operation === 'substrat.stage-page')).toHaveLength(1);
  });
});
