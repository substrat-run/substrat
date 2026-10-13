/**
 * A deployed vertical with no scope store answers an empty size list (#2239), on a worker that
 * binds no `SUBSTRAT_STORE_*` — this fixture, uploaded as the platform uploads it. The adapter's
 * main test worker always binds `SUBSTRAT_STORE_GRAPH`, so only here is the branch reachable.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';

describe('scope store sizes on a worker with no store (#2239)', () => {
  it('answer an empty list before the vertical, the gate or the directory is asked', async () => {
    expect(Object.keys(env).filter((key) => key.startsWith('SUBSTRAT_STORE_'))).toEqual([]);
    // No control plane and no `scopeStores.vertical`: any read past the empty check would refuse.
    const host = new CloudflareScopeHost({ scope: (env as unknown as { SCOPE: DurableObjectNamespace }).SCOPE });
    expect(await host.scopeStoreSizesLocal(tenantId.parse(ulid()), scopeId.parse(ulid()))).toEqual([]);
  });
});
