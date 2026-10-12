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
});
