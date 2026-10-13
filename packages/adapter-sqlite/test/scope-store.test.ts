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
    } finally {
      await host.close();
    }
  });

  // #2213: a failed start is retried without starting the runners that already did, and
  // close stops every runner even when one stop throws.
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
