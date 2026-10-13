import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { errorCodeOf, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker, type ScopeStoreRunner } from '@substrat-run/kernel';
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
      kind: 'counter',
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

  // #2213: a failed start is retried without starting the runners that already did, and
  // close stops every runner even when one stop throws.
  // #2266: a close while the first start is in flight waits for it; no runner starts after it.
  it('a close during the first start leaves no runner started after it', async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runner = (name: string, held?: Promise<void>): ScopeStoreRunner => ({
      kind: 'counter',
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
      kind: 'counter',
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
});
