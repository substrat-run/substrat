import { describe, expect, it } from 'vitest';
import { errorCodeOf, platformActorId, scopeId, StoreError, substratError, tenantId, type ScopeId } from '@substrat-run/contracts';
import { callReservedStoreOperation, callScopeStore, replayStoreErasures } from '../src/scope-store.js';
import { ulid } from '../src/ulid.js';

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
