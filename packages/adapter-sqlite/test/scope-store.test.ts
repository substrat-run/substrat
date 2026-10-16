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

  it('refuses a size read of one tenant’s scope asked under another tenant', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-'));
    const runner: ScopeStoreRunner = {
      driver: 'counter',
      async start() {},
      async stop() {},
      async invoke() {
        return { result: { bytes: 5 } };
      },
    };
    const host = new SqliteScopeHost({
      dir,
      checker: UNSAFE_allowAllChecker,
      scopeStores: { runners: [{ binding: 'GRAPH', runner }] },
    });
    const staff = platformActorId.parse(ulid());
    const a = tenantId.parse(ulid());
    const b = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    try {
      for (const t of [a, b]) await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await host.provisionScope(staff, { tenantId: a, scopeId: s, vertical: 'docs' });
      await host.admin.activateScope(staff, a, s);
      expect(await host.admin.scopeStoreSizes(staff, a, s)).toEqual([{ binding: 'GRAPH', bytes: 5 }]);
      const refusal = await host.admin.scopeStoreSizes(staff, b, s).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(refusal)).toBe('not_found');
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

  // CodeRabbit on #2244: the pin was checked only when the stores were imported, after the
  // scope's tables had been replaced (a restore) or the scope created (an import).
  it('a host pinned to one vertical refuses a store dump for a scope of another before any write', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-'));
    const log: string[] = [];
    const runner: ScopeStoreRunner = {
      driver: 'counter',
      async start() {},
      async stop() {},
      async invoke(_address, request) {
        log.push(request.operation);
        if (request.operation === 'substrat.export') return { result: { tables: [] } };
        return { result: { tables: 0 } };
      },
    };
    const open = (vertical?: string) =>
      new SqliteScopeHost({
        dir: dir!,
        checker: UNSAFE_allowAllChecker,
        scopeStores: { ...(vertical ? { vertical } : {}), runners: [{ binding: 'GRAPH', runner }] },
      });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const dest = scopeId.parse(ulid());
    const probe = { name: 'restore_probe', ddl: 'CREATE TABLE restore_probe (id TEXT)', columns: ['id'], rows: [['x']] };

    // The dump is taken by an unpinned host on the same directory, which also reads back after.
    let reader = open();
    await reader.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await reader.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'other' });
    await reader.admin.activateScope(staff, t, s);
    const dump = await reader.admin.exportScope(staff, t, s);
    expect(dump.stores).toEqual([{ binding: 'GRAPH', driver: 'counter', tables: [] }]);
    await reader.close();
    log.length = 0;

    const pinned = open('docs');
    try {
      const restored = await pinned.restoreScope(staff, t, s, { ...dump, tables: [...dump.tables, probe] }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(restored)).toBe('forbidden');
      const imported = await pinned.importScope(staff, { tenantId: t, scopeId: dest, vertical: 'other' }, dump).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(errorCodeOf(imported)).toBe('forbidden');
    } finally {
      await pinned.close();
    }
    expect(log).toEqual([]);

    reader = open();
    try {
      const after = await reader.admin.exportScope(staff, t, s);
      expect(after.tables.map((table) => table.name)).not.toContain(probe.name);
      expect(await reader.admin.getScopeRecord(staff, t, dest)).toBeUndefined();
    } finally {
      await reader.close();
    }
  });

  it('refuses a scope whose vertical this host does not serve', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-'));
    const runner: ScopeStoreRunner = {
      driver: 'counter',
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

  // #2213: a failed start is retried without starting the runners that already did, and
  // close stops every runner even when one stop throws.
  // #2266: a close while the first start is in flight waits for it; no runner starts after it.
  it('a close during the first start leaves no runner started after it', async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runner = (name: string, held?: Promise<void>): ScopeStoreRunner => ({
      driver: 'counter',
      async start() {
        log.push(`start ${name}`);
        await held;
      },
      async stop() {
        log.push(`stop ${name}`);
      },
      async invoke() {
        return { result: 0 };
      },
    });
    dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-'));
    const host = new SqliteScopeHost({
      dir,
      checker: UNSAFE_allowAllChecker,
      scopeStores: { runners: [{ binding: 'GRAPH', runner: runner('A', gate) }, { binding: 'OTHER', runner: runner('B') }] },
    });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    const opening = host.getScopeStore(principalId.parse(ulid()), t, s, 'GRAPH');
    // The first start is in flight once A has been asked.
    while (log.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const closing = host.close();
    release();
    await expect(opening).rejects.toThrow(/stopping/);
    await closing;
    expect(log).toEqual(['start A', 'stop A', 'stop B']);
  });

  it('a retried start does not start a runner twice, and close stops every runner', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-'));
    const log: string[] = [];
    let failStart = 1;
    const runner = (name: string, opts: { failStart?: boolean; failStop?: boolean } = {}): ScopeStoreRunner => ({
      driver: 'counter',
      async start() {
        log.push(`start ${name}`);
        if (opts.failStart && failStart-- > 0) throw new Error(`${name} start broke`);
      },
      async stop() {
        log.push(`stop ${name}`);
        if (opts.failStop) throw new Error(`${name} stop broke`);
      },
      async invoke() {
        return { result: 7 };
      },
    });
    const host = new SqliteScopeHost({
      dir,
      checker: UNSAFE_allowAllChecker,
      scopeStores: {
        runners: [
          { binding: 'GRAPH', runner: runner('A', { failStop: true }) },
          { binding: 'OTHER', runner: runner('B', { failStart: true }) },
        ],
      },
    });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    const open = () => host.getScopeStore(principalId.parse(ulid()), t, s, 'GRAPH');
    await expect(open()).rejects.toThrow(/B start broke/);
    expect(await (await open()).invoke('read')).toBe(7);
    await open();
    expect(log).toEqual(['start A', 'start B', 'start B']);
    await expect(host.close()).rejects.toThrow(/A stop broke/);
    expect(log.slice(3)).toEqual(['stop A', 'stop B']);
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
      driver: 'counter',
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

  // #2242: an empty erase list lets the subject key go, so it must mean "holds nothing".
  // A scope with no vertical, or on a vertical this host is not pinned to, has no store
  // object among this host's runners; the pinned vertical's scope is asked.
  it('an erasure asks only the scopes whose stores this host holds', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-'));
    const asked: string[] = [];
    const runner: ScopeStoreRunner = {
      driver: 'counter',
      async start() {},
      async stop() {},
      async invoke(address, request) {
        if (request.operation === 'substrat.erase') {
          asked.push(address.scopeId);
          return { result: { erased: 1 } };
        }
        return { result: { bytes: 0 } };
      },
    };
    const host = new SqliteScopeHost({
      dir,
      checker: UNSAFE_allowAllChecker,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      scopeStores: { vertical: 'docs', runners: [{ binding: 'GRAPH', runner }] },
    });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const [own, other, bare] = [scopeId.parse(ulid()), scopeId.parse(ulid()), scopeId.parse(ulid())];
    try {
      await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await host.provisionScope(staff, { tenantId: t, scopeId: own, vertical: 'docs' });
      await host.provisionScope(staff, { tenantId: t, scopeId: other, vertical: 'other' });
      await host.provisionScope(staff, { tenantId: t, scopeId: bare });
      for (const s of [own, other, bare]) await host.admin.activateScope(staff, t, s);
      expect((await host.admin.shredSubject(staff, t, own, ulid())).storeErasures).toEqual([{ binding: 'GRAPH', erased: 1 }]);
      expect((await host.admin.shredSubject(staff, t, other, ulid())).storeErasures).toEqual([]);
      expect((await host.admin.shredSubject(staff, t, bare, ulid())).storeErasures).toEqual([]);
      expect(asked).toEqual([own]);
    } finally {
      await host.close();
    }
  });

  // #2242: `erased` is what THIS attempt removed. A retry after a partial failure lists every
  // binding it asked, with zero for one an earlier attempt already erased. No count is carried.
  it('a retry after a partial failure lists every binding, zero for one already erased', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-'));
    let failSecond = true;
    const held = new Map<string, Set<string>>();
    const runner = (binding: string): ScopeStoreRunner => ({
      driver: 'counter',
      async start() {},
      async stop() {},
      async invoke(_address, request) {
        if (request.operation !== 'substrat.erase') return { result: { bytes: 0 } };
        if (binding === 'SECOND' && failSecond) return { error: { code: 'unavailable', status: 503 } };
        const subjectId = String(Reflect.get(request.input as object, 'subjectId'));
        const subjects = held.get(binding) ?? new Set([subjectId]);
        held.set(binding, subjects);
        return { result: { erased: subjects.delete(subjectId) ? 1 : 0 } };
      },
    });
    const host = new SqliteScopeHost({
      dir,
      checker: UNSAFE_allowAllChecker,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      scopeStores: { runners: [{ binding: 'FIRST', runner: runner('FIRST') }, { binding: 'SECOND', runner: runner('SECOND') }] },
    });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const subject = ulid();
    try {
      await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
      await host.admin.activateScope(staff, t, s);
      await host.admin.sealSubjectPayloads(staff, t, s, [{ subjectId: subject, plaintext: 'pii' }]);
      const refusal = await host.admin.shredSubject(staff, t, s, subject).then(() => undefined, (err: unknown) => err);
      expect(errorCodeOf(refusal)).toBe('unavailable');
      failSecond = false;
      const receipt = await host.admin.shredSubject(staff, t, s, subject);
      expect(receipt.storeErasures).toEqual([
        { binding: 'FIRST', erased: 0 },
        { binding: 'SECOND', erased: 1 },
      ]);
      expect(receipt.keyDestroyed).toBe(true);
    } finally {
      await host.close();
    }
  });

  it('a scope with no vertical has nothing to export, and the runner is not asked', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scope-store-'));
    let asked = false;
    const runner: ScopeStoreRunner = {
      driver: 'counter',
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
      driver: 'counter',
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
      expect(incomplete).toEqual({ storeErasuresReplayed: 0, storeErasureIncomplete: true });
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
