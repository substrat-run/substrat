import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorCodeOf, platformActorId, principalId, scopeId, scopeStoreObjectName, tenantId } from '@substrat-run/contracts';
import { ulid, type ScopeStoreRunner } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

describe('scope store door (cloudflare host, #2209)', () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const staff = platformActorId.parse(ulid());
  const principal = principalId.parse(ulid());

  const world = async () => {
    const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    const t = tenantId.parse(ulid());
    const a = scopeId.parse(ulid());
    const b = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.provisionScope(staff, { tenantId: t, scopeId: a, vertical: 'docs' });
    await host.provisionScope(staff, { tenantId: t, scopeId: b, vertical: 'docs' });
    await host.admin.activateScope(staff, t, a);
    await host.admin.activateScope(staff, t, b);
    return { host, t, a, b };
  };

  it('reaches the bound object, and a second scope does not share it', async () => {
    const { host, t, a, b } = await world();
    const first = await host.getScopeStore(principal, t, a, 'GRAPH');
    expect(await first.invoke('increment', { by: 1 })).toBe(1);
    expect(await first.invoke('read')).toBe(1);
    const second = await host.getScopeStore(principal, t, b, 'GRAPH');
    expect(await second.invoke('read')).toBe(0);
  });

  it('refuses a reserved operation and leaves the counter where it was', async () => {
    const { host, t, a } = await world();
    const store = await host.getScopeStore(principal, t, a, 'GRAPH');
    await store.invoke('increment', { by: 4 });
    const refusal = await store.invoke('substrat.wipe').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(errorCodeOf(refusal)).toBe('forbidden');
    expect(await store.invoke('read')).toBe(4);
  });

  it('refuses a binding that was not injected', async () => {
    const { host, t, a } = await world();
    const refusal = await host.getScopeStore(principal, t, a, 'OTHER').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(errorCodeOf(refusal)).toBe('not_found');
    expect((refusal as Error).message).toMatch(/OTHER/);
  });

  it('refuses a scope the directory does not have, before any store call', async () => {
    const { host, t } = await world();
    const missing = scopeId.parse(ulid());
    const refusal = await host.getScopeStore(principal, t, missing, 'GRAPH').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(errorCodeOf(refusal)).toBe('not_found');
  });

  it('the store itself answers a reserved operation, which is how the stub refusal is visible', async () => {
    const { t, a } = await world();
    const name = scopeStoreObjectName(t, 'docs', a, 'GRAPH');
    const object = env.SUBSTRAT_STORE_GRAPH.get(env.SUBSTRAT_STORE_GRAPH.idFromName(name));
    const response = await object.fetch('https://scope-store/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'substrat.size' }),
    });
    const body: unknown = await response.json();
    const result = typeof body === 'object' && body !== null ? Reflect.get(body, 'result') : undefined;
    expect(typeof result).toBe('number');
    expect(Number(result)).toBeGreaterThan(0);
  });

  it('a host with no control plane and no binding refuses before asking the directory', async () => {
    const host = new CloudflareScopeHost({ scope: env.SCOPE });
    const refusal = await host.getScopeStore(principal, tenantId.parse(ulid()), scopeId.parse(ulid()), 'OTHER').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(errorCodeOf(refusal)).toBe('not_found');
  });

  it('a host with no control plane names the vertical it was given', async () => {
    const host = new CloudflareScopeHost({ scope: env.SCOPE, scopeStores: { vertical: 'docs', runners: [] } });
    const t = tenantId.parse(ulid());
    const a = scopeId.parse(ulid());
    const store = await host.getScopeStore(principal, t, a, 'GRAPH');
    expect(await store.invoke('increment', { by: 1 })).toBe(1);
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
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      scopeStores: { vertical: 'docs', runners: [{ binding: 'GRAPH', runner: runner('A', gate) }, { binding: 'OTHER', runner: runner('B') }] },
    });
    const opening = host.getScopeStore(principal, tenantId.parse(ulid()), scopeId.parse(ulid()), 'GRAPH');
    // The first start is in flight once A has been asked.
    while (log.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const closing = host.close();
    release();
    await expect(opening).rejects.toThrow(/stopping/);
    await closing;
    expect(log).toEqual(['start A', 'stop A', 'stop B']);
  });

  it('a retried start does not start a runner twice, and close stops every runner', async () => {
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
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      scopeStores: {
        vertical: 'docs',
        runners: [
          { binding: 'GRAPH', runner: runner('A', { failStop: true }) },
          { binding: 'OTHER', runner: runner('B', { failStart: true }) },
        ],
      },
    });
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const open = () => host.getScopeStore(principal, t, s, 'GRAPH');
    await expect(open()).rejects.toThrow(/B start broke/);
    expect(await (await open()).invoke('read')).toBe(7);
    await open();
    expect(log).toEqual(['start A', 'start B', 'start B']);
    await expect(host.close()).rejects.toThrow(/A stop broke/);
    expect(log.slice(3)).toEqual(['stop A', 'stop B']);
  });

  it('a host with no control plane and no vertical answers unavailable, not a raw error', async () => {
    const host = new CloudflareScopeHost({ scope: env.SCOPE });
    const refusal = await host.getScopeStore(principal, tenantId.parse(ulid()), scopeId.parse(ulid()), 'GRAPH').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(errorCodeOf(refusal)).toBe('unavailable');
    expect((refusal as Error).message).toMatch(/scopeStores.vertical/);
  });

  it('a body that is not the envelope is a store error, and a 5xx body is not forwarded', async () => {
    const { host, t, a } = await world();
    const store = await host.getScopeStore(principal, t, a, 'GRAPH');
    const plain = await store.invoke('plain').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(errorCodeOf(plain)).toBe('unavailable');
    expect((plain as { storeCode?: string }).storeCode).toBe('bad_envelope');
    const failed = await store.invoke('fail').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect((failed as { storeCode?: string }).storeCode).toHaveLength(64);
    expect((failed as { storeBody?: unknown }).storeBody).toBeUndefined();
  });
});
