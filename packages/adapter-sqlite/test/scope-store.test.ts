import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { errorCodeOf, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox, type ScopeStoreRunner } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

describe('scope store door (pure adapter, #2209)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('a host with no runner sizes a scope it has never opened', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-'));
    const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
    const staff = platformActorId.parse(ulid());
    try {
      expect(await host.admin.scopeStoreSizes(staff, tenantId.parse(ulid()), scopeId.parse(ulid()))).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it('checks the directory, then refuses because no runner is configured', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-'));
    const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
    const staff = platformActorId.parse(ulid());
    const principal = principalId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    try {
      await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
      await host.admin.activateScope(staff, t, s);
      const refusal = await host.getScopeStore(principal, t, s, 'GRAPH').then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(refusal)).toBe('unavailable');
      expect((refusal as Error).message).toMatch(/no scope-store runner/);
      expect(await host.admin.scopeStoreSizes(staff, t, s)).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it('refuses a scope whose vertical this host does not serve', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-'));
    const runner: ScopeStoreRunner = {
      kind: 'counter',
      async start() {},
      async stop() {},
      async invoke() {
        return { result: 0 };
      },
    };
    const host = new SqliteScopeHost({
      dir,
      checker: UNSAFE_allowAllChecker,
      scopeStores: { vertical: 'docs', runners: [{ binding: 'GRAPH', runner }] },
    });
    const staff = platformActorId.parse(ulid());
    const principal = principalId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    try {
      await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'other' });
      await host.admin.activateScope(staff, t, s);
      const refusal = await host.getScopeStore(principal, t, s, 'GRAPH').then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(refusal)).toBe('forbidden');
      expect((refusal as Error).message).toMatch(/serves vertical 'docs'/);
      const sizes = await host.admin.scopeStoreSizes(staff, t, s).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(sizes)).toBe('forbidden');
    } finally {
      await host.close();
    }
  });

  it('refuses an unknown scope before it mentions a runner', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-'));
    const host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
    const principal = principalId.parse(ulid());
    const refusal = await host.getScopeStore(principal, tenantId.parse(ulid()), scopeId.parse(ulid()), 'GRAPH').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(errorCodeOf(refusal)).toBe('not_found');
    expect((refusal as Error).message).not.toMatch(/runner/);
    await host.close();
  });

  it('a store that errors leaves the subject key, and a retry erases', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-'));
    let fail = true;
    const runner: ScopeStoreRunner = {
      kind: 'counter',
      async start() {},
      async stop() {},
      async invoke(_address, request) {
        if (request.operation === 'substrat.erase') {
          if (fail) return { error: { code: 'unavailable', status: 503 } };
          return { result: { erased: 1 } };
        }
        if (request.operation === 'substrat.size') return { result: { bytes: 0 } };
        return { result: 0 };
      },
    };
    const host = new SqliteScopeHost({
      dir,
      checker: UNSAFE_allowAllChecker,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      scopeStores: { runners: [{ binding: 'GRAPH', runner }] },
    });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const subject = ulid();
    try {
      await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
      await host.admin.activateScope(staff, t, s);
      const [sealed] = await host.admin.sealSubjectPayloads(staff, t, s, [{ subjectId: subject, plaintext: 'pii' }]);
      expect(sealed).not.toBeNull();
      const refusal = await host.admin.shredSubject(staff, t, s, subject).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(refusal)).toBe('unavailable');
      expect(await host.admin.openSubjectPayloads(staff, t, s, [{ subjectId: subject, sealed: sealed! }])).toEqual(['pii']);
      fail = false;
      const receipt = await host.admin.shredSubject(staff, t, s, subject);
      expect(receipt.storeErasures).toEqual([{ binding: 'GRAPH', erased: 1 }]);
      expect(receipt.keyDestroyed).toBe(true);
      expect(await host.admin.openSubjectPayloads(staff, t, s, [{ subjectId: subject, sealed: sealed! }])).toEqual([null]);
    } finally {
      await host.close();
    }
  });

  it('a scope with no vertical has nothing to export, and the runner is not asked', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-'));
    let asked = false;
    const runner: ScopeStoreRunner = {
      kind: 'counter',
      async start() {},
      async stop() {},
      async invoke() {
        asked = true;
        return { result: { tables: [] } };
      },
    };
    const host = new SqliteScopeHost({
      dir,
      checker: UNSAFE_allowAllChecker,
      scopeStores: { runners: [{ binding: 'GRAPH', runner }] },
    });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    try {
      await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await host.provisionScope(staff, { tenantId: t, scopeId: s });
      await host.admin.activateScope(staff, t, s);
      const dump = await host.admin.exportScope(staff, t, s);
      expect(dump.stores).toEqual([]);
      expect(asked).toBe(false);
    } finally {
      await host.close();
    }
  });

  it('a restore re-erases a subject shredded after the backup, and a retry finishes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-'));
    const held = new Set<string>();
    let fail = false;
    const runner: ScopeStoreRunner = {
      kind: 'counter',
      async start() {},
      async stop() {},
      async invoke(_address, request) {
        if (request.operation === 'plant') {
          const subjectId = Reflect.get(request.input ?? {}, 'subjectId');
          if (typeof subjectId === 'string') held.add(subjectId);
          return { result: {} };
        }
        if (request.operation === 'held') return { result: [...held] };
        if (request.operation === 'substrat.size') return { result: { bytes: held.size } };
        if (request.operation === 'substrat.wipe') {
          held.clear();
          return { result: {} };
        }
        if (request.operation === 'substrat.export') {
          return {
            result: {
              tables: [
                {
                  name: 'held',
                  ddl: 'CREATE TABLE held (subject_id TEXT NOT NULL)',
                  columns: ['subject_id'],
                  rows: [...held].map((id) => [id]),
                },
              ],
            },
          };
        }
        if (request.operation === 'substrat.import') {
          held.clear();
          const tables = Reflect.get(request.input ?? {}, 'tables');
          const first = Array.isArray(tables) ? tables[0] : undefined;
          const rows = typeof first === 'object' && first !== null ? Reflect.get(first, 'rows') : undefined;
          if (Array.isArray(rows)) {
            for (const row of rows) {
              const cell = Array.isArray(row) ? row[0] : undefined;
              if (typeof cell === 'string') held.add(cell);
            }
          }
          return { result: { tables: 1 } };
        }
        if (request.operation === 'substrat.erase') {
          if (fail) return { error: { code: 'unavailable', status: 503 } };
          const subjectId = Reflect.get(request.input ?? {}, 'subjectId');
          const had = typeof subjectId === 'string' && held.delete(subjectId);
          return { result: { erased: had ? 1 : 0 } };
        }
        return { result: {} };
      },
    };
    const host = new SqliteScopeHost({
      dir,
      checker: UNSAFE_allowAllChecker,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      scopeStores: { runners: [{ binding: 'GRAPH', runner }] },
    });
    const staff = platformActorId.parse(ulid());
    const principal = principalId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const subject = ulid();
    try {
      await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
      await host.admin.activateScope(staff, t, s);
      await host.admin.sealSubjectPayloads(staff, t, s, [{ subjectId: subject, plaintext: 'pii' }]);
      const store = await host.getScopeStore(principal, t, s, 'GRAPH');
      await store.invoke('plant', { subjectId: subject });
      const dump = await host.admin.exportScope(staff, t, s);
      await host.admin.shredSubject(staff, t, s, subject);
      const storeAfter = await host.getScopeStore(principal, t, s, 'GRAPH');
      expect(await storeAfter.invoke('held', {})).toEqual([]);

      fail = true;
      const incomplete = await host.restoreScope(staff, t, s, dump);
      expect(incomplete.storeErasureIncomplete).toBe(true);
      expect(await storeAfter.invoke('held', {})).toEqual([subject]);

      fail = false;
      const done = await host.restoreScope(staff, t, s, dump);
      expect(done).toEqual({ storeErasuresReplayed: 1, storeErasureIncomplete: false });
      expect(await storeAfter.invoke('held', {})).toEqual([]);
    } finally {
      await host.close();
    }
  });
});
