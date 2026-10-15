/**
 * A deployed vertical with no scope store (#2239), on a worker that binds no `SUBSTRAT_STORE_*` —
 * this fixture, uploaded as the platform uploads it. The adapter's main test worker always binds
 * `SUBSTRAT_STORE_GRAPH`, so only here is the storeless branch reachable.
 *
 * #2288: such a host takes the platform hop by default, and on the hop its local reads refuse
 * (its stores, if any, live behind the platform). The empty answers below are the direct-binding
 * host's, asked for with `transport: 'binding'`.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { errorCodeOf, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';

const SCOPE = (env as unknown as { SCOPE: DurableObjectNamespace }).SCOPE;

describe('scope store sizes on a worker with no store (#2239)', () => {
  it('answer an empty list before the vertical, the gate or the directory is asked', async () => {
    expect(Object.keys(env).filter((key) => key.startsWith('SUBSTRAT_STORE_'))).toEqual([]);
    // No control plane and no `scopeStores.vertical`: any read past the empty check would refuse.
    const host = new CloudflareScopeHost({ scope: SCOPE, scopeStores: { transport: 'binding' } });
    expect(await host.scopeStoreSizesLocal(tenantId.parse(ulid()), scopeId.parse(ulid()))).toEqual([]);
  });

  // #2243 r3: the export a backup, a full pull and a snapshot ask for. It used to read the
  // directory first, which a host with no control plane cannot do: a 400 for every copy of a
  // deployment that holds no store at all.
  it('answer an empty export, and erase nothing, before the directory is asked', async () => {
    const host = new CloudflareScopeHost({ scope: SCOPE, scopeStores: { transport: 'binding' } });
    const [t, s] = [tenantId.parse(ulid()), scopeId.parse(ulid())];
    expect(await host.scopeStoreExportLocal(t, s)).toEqual([]);
    await expect(host.scopeStoreImportLocal(t, s, [])).resolves.toBeUndefined();
    expect(await host.scopeStoreEraseLocal(t, s, ulid())).toEqual([]);
  });

  it('on the default platform hop, the same reads refuse rather than answer "no stores" (#2288)', async () => {
    const host = new CloudflareScopeHost({ scope: SCOPE });
    const [t, s] = [tenantId.parse(ulid()), scopeId.parse(ulid())];
    for (const read of [() => host.scopeStoreSizesLocal(t, s), () => host.scopeStoreExportLocal(t, s), () => host.scopeStoreEraseLocal(t, s, ulid())]) {
      expect(errorCodeOf(await read().then(() => undefined, (err: unknown) => err))).toBe('unavailable');
    }
  });
});
