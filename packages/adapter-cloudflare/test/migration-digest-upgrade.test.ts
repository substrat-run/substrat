/**
 * #2066's ALTER on a real Durable Object: a scope whose journal predates `sql_digest` gains the
 * column on its next wake, its rows stay NULL — unrecorded, accepted, never backfilled — and a
 * second wake tolerates the repeat ALTER. The contract suite covers the digest rule itself; only
 * a test holding the raw DO stub can force the eviction a second wake needs.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { listMod } from '@substrat-run/contract-tests';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

it('adds sql_digest to a legacy journal on wake, leaves its rows NULL, and tolerates a second wake (#2066)', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  host.registerModule(listMod);
  const staff = platformActorId.parse(ulid());
  const who = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: `digest-up-${ulid().toLowerCase()}`, name: 'Digest upgrade' });
  await host.admin.grantEntitlement(staff, t, 'list');
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'list-vertical' });
  try {
    await host.admin.activateScope(staff, t, s);
    const add = async () =>
      (await host.getScope(who, t, s)).invoke('list/add', { id: ulid(), number: ulid(), status: 'open', kind: 'a' });
    await add();
    const fresh = () => env.SCOPE.get(env.SCOPE.idFromName(s));
    const digests = () =>
      runInDurableObject(fresh(), (_instance, state) =>
        state.storage.sql
          .exec("SELECT sql_digest FROM _substrat_migrations WHERE module_id = '@test/list'")
          .toArray()
          .map((r) => r.sql_digest));
    expect((await digests()).every((d) => typeof d === 'string' && /^[0-9a-f]{64}$/.test(d))).toBe(true);
    // The drop commits in a call of its own, before the eviction (see job-run-subject-upgrade).
    await runInDurableObject(fresh(), (_instance, state) => {
      state.storage.sql.exec('ALTER TABLE _substrat_migrations DROP COLUMN sql_digest');
    });
    await runInDurableObject(fresh(), (_instance, state) => {
      state.abort('evicted for the sql_digest upgrade');
    }).catch(() => undefined);
    await expect(add()).resolves.toBeDefined();
    const legacy = await digests();
    expect(legacy.length).toBeGreaterThan(0);
    expect(legacy.every((d) => d === null)).toBe(true);
    await runInDurableObject(fresh(), (_instance, state) => {
      state.abort('evicted to check the repeat sql_digest ALTER');
    }).catch(() => undefined);
    await expect(add()).resolves.toBeDefined();
    expect(await digests()).toEqual(legacy);
  } finally {
    await host.admin.archiveScope(staff, t, s);
  }
});
