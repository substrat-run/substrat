import { describe, expect, it } from 'vitest';
import { errorCodeOf, StoreError } from '@substrat-run/contracts';
import { callScopeStore, scopeStoreLifecycleOf, type ScopeStoreRunner } from '../src/scope-store.js';

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
