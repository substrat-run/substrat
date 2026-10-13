import { describe, expect, expectTypeOf, it } from 'vitest';
import { errorCodeOf, StoreError } from '@substrat-run/contracts';
import { callReservedStoreOperation, callScopeStore, scopeStoreLifecycleOf, type ScopeStoreRunner } from '../src/scope-store.js';

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
    expect((refusal as StoreError).storeCode).toBe('bad_envelope');
  });
});

describe('scopeStoreLifecycleOf (#2213)', () => {
  const runner = (name: string, log: string[], fail: { start?: number; stop?: boolean } = {}): ScopeStoreRunner => ({
    kind: 'counter',
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
      kind: 'counter',
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
      kind: 'counter',
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
    expect((refusal as StoreError).storeCode).toBe('bad_envelope');
  });

  it('parses an erase, an export and an import count', async () => {
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
    const exported = await callReservedStoreOperation(async () => ({ result: { tables: [table] } }), 'substrat.export');
    expect(exported).toEqual({ tables: [table] });
    const imported = await callReservedStoreOperation(
      async () => ({ result: { tables: 1 } }),
      'substrat.import',
      { tables: [table] },
    );
    expect(imported).toEqual({ tables: 1 });
    const wiped = await callReservedStoreOperation(async () => ({ result: {} }), 'substrat.wipe');
    expect(wiped).toEqual({});
  });
});

describe('callReservedStoreOperation returns the parsed result type (#2239)', () => {
  it('a size read is typed as its schema, not unknown', async () => {
    const size = callReservedStoreOperation(async () => ({ result: { bytes: 4 } }), 'substrat.size');
    expectTypeOf(size).resolves.toEqualTypeOf<{ bytes: number }>();
    expect(await size).toEqual({ bytes: 4 });
  });
});
