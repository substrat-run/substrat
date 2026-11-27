/**
 * K-69 (rfc/tenant-scale.md §7.5, step 5): a scope asks for its provision reconcile on its first
 * wake on a version, once, on a real Durable Object. The handler that answers the ask is the control
 * plane's (control-plane-api/test/provision-reconcile-intent.test.ts); this is the scope's half:
 * which wakes write the `provision-reconcile` intent, and the flag that makes the router kick it.
 *
 * A promote is the test moving `WAKE_VERSION`; a wake is `retryMigrations`, the same fresh pass a
 * revived object runs (a warm instance memoises its pass, so an invoke alone would not run another).
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_PENDING_PLATFORM_REQUESTS, PROVISION_RECONCILE_KIND, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { PLATFORM_SECRET_HEADER } from '@substrat-run/contracts/wire-headers';
import { listMod } from '@substrat-run/contract-tests';
import { markCopyOrigin, ulid, UNSAFE_allowAllChecker } from '@substrat-run/kernel';
import { CloudflareScopeHost } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';
import { WAKE_VERSION, WAKE_VERSION_CONTROL_PLANE_URL } from './worker.js';
import { RECONCILE_ASKED_KEY, RECONCILE_ON_WAKE_REQUESTED_BY } from '../src/reconcile-on-wake.js';
import { SCOPE_WAKE_INTENTS_DELAY_MS, SCOPE_WAKE_KEY, type ScopeWakeState, type WakeKick } from '../src/scope-wake.js';

const setVersion = (v: string | undefined) => {
  (globalThis as Record<symbol, string | undefined>)[WAKE_VERSION] = v;
};
type Ask = { status: string; payload: string; requested_by: string };

describe('the on-wake provision reconcile, the scope’s half (K-69)', () => {
  const staff = platformActorId.parse(ulid());
  const who = principalId.parse(ulid());
  const ns = () => env.WAKE_VERSION_SCOPE;
  const object = (s: string) => ns().get(ns().idFromName(s));
  let host: CloudflareScopeHost;
  /** The scope's own kicks (#3435), answered as a control plane whose pass still owns intents. */
  const kicks: { secret: string | null; body: WakeKick }[] = [];
  const realFetch = globalThis.fetch;
  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== WAKE_VERSION_CONTROL_PLANE_URL) return realFetch(input, init);
      kicks.push({ secret: new Headers(init?.headers).get(PLATFORM_SECRET_HEADER), body: JSON.parse(String(init?.body)) as WakeKick });
      return Response.json({ drained: 0, done: 0, failed: 0, pending: 0, wake: { platformRequests: 'pass', events: 'pass' } });
    });
    await warmControlPlane(env.CONTROL_PLANE);
    host = new CloudflareScopeHost({ scope: ns(), controlPlane: env.CONTROL_PLANE, checker: UNSAFE_allowAllChecker });
    host.registerModule(listMod);
  });
  afterEach(() => setVersion(undefined));
  afterAll(async () => {
    vi.restoreAllMocks();
    await host.close();
  });

  /** A live install provisioned on `version`: its migrations applied, its first wake behind it. */
  const install = async (version: string) => {
    setVersion(version);
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `wake-${ulid().toLowerCase()}`, name: 'Wake' });
    await host.admin.grantEntitlement(staff, t, 'list');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'list-vertical' });
    await host.admin.activateScope(staff, t, s);
    return { t, s };
  };
  const wake = (s: string) => (object(s) as unknown as { retryMigrations(): Promise<number | null> }).retryMigrations();
  const asks = (s: string) =>
    runInDurableObject(object(s), (_i, state) =>
      state.storage.sql
        .exec(`SELECT status, payload, requested_by FROM _substrat_platform_requests WHERE kind = ?`, PROVISION_RECONCILE_KIND)
        .toArray() as unknown as Ask[],
    );
  const asked = (s: string) =>
    runInDurableObject(object(s), (_i, state) =>
      (state.storage.sql.exec(`SELECT value FROM _substrat_meta WHERE key = ?`, RECONCILE_ASKED_KEY).toArray()[0] as { value: string } | undefined)
        ?.value ?? null,
    );
  /** How many intents the invoke's response would have flagged to the router (`onPlatformRequests`). */
  const flagged = async (t: ReturnType<typeof tenantId.parse>, s: ReturnType<typeof scopeId.parse>) => {
    let n = 0;
    const stub = await host.getScope(who, t, s, { onPlatformRequests: (count) => (n += count) });
    await stub.invoke('list/add', { id: ulid(), number: ulid(), status: 'open', kind: 'a' });
    return n;
  };

  it('asks nothing at provision, then once on the first wake after several promotes, whatever woke it, and flags one response', async () => {
    const { t, s } = await install('01JWAKEV1000000000000000AA');
    // The provision runs the hook and writes the receipt itself: nothing to ask for.
    expect(await asks(s)).toEqual([]);
    expect(await asked(s)).toBe('01JWAKEV1000000000000000AA');
    // Idle through three promotes; it wakes on the last one, and two requests race to wake it.
    setVersion('01JWAKEV4000000000000000AA');
    await Promise.all([wake(s), wake(s)]);
    expect(await asks(s)).toEqual([
      { status: 'pending', payload: JSON.stringify({ wokeOn: '01JWAKEV4000000000000000AA' }), requested_by: RECONCILE_ON_WAKE_REQUESTED_BY },
    ]);
    expect(await asked(s)).toBe('01JWAKEV4000000000000000AA');
    // The first committed response after the ask flags it once, so the router kicks a drain.
    expect(await flagged(t, s)).toBe(1);
    expect(await flagged(t, s)).toBe(0);
    // Another wake on the same version asks nothing more.
    await wake(s);
    expect(await asks(s)).toHaveLength(1);
  });

  it('a wake that commits nothing arms the scope’s own wake, whose alarm asks for its drain within seconds (#3435)', async () => {
    // Provisioned as a hosted scope is, with its roles projected, which records its tenant.
    const local = new CloudflareScopeHost({ scope: ns() });
    local.registerModule(listMod);
    setVersion('01JWAKEW1000000000000000AA');
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await local.provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner: who,
      roles: [{ key: 'owner', permissions: [], source: 'vertical' }],
      ownerRoleKey: 'owner',
    });
    // Whatever the provision armed is not this test's subject: start from a scope with no wake.
    await runInDurableObject(object(s), async (_i, state) => {
      await state.storage.delete(SCOPE_WAKE_KEY);
      await state.storage.deleteAlarm();
    });
    // The promote, then a wake by no invoke at all: no response will carry the router's flag.
    setVersion('01JWAKEW2000000000000000AA');
    const before = Date.now();
    await wake(s);
    expect(await asks(s)).toHaveLength(1);
    const armed = await runInDurableObject(object(s), async (_i, state) => ({
      wake: (await state.storage.get<ScopeWakeState>(SCOPE_WAKE_KEY)) ?? null,
      alarm: await state.storage.getAlarm(),
    }));
    expect(armed.wake).toMatchObject({ tenantId: t, scopeId: s });
    expect(armed.wake!.due.intents).toBeGreaterThanOrEqual(before + SCOPE_WAKE_INTENTS_DELAY_MS);
    expect(armed.wake!.due.intents).toBeLessThanOrEqual(Date.now() + SCOPE_WAKE_INTENTS_DELAY_MS);
    expect(armed.alarm).toBeLessThanOrEqual(armed.wake!.due.intents!);
    // The alarm, run now rather than in two seconds: it asks the control plane to drain this scope.
    await runInDurableObject(object(s), async (_i, state) => {
      const w = (await state.storage.get<ScopeWakeState>(SCOPE_WAKE_KEY))!;
      await state.storage.put(SCOPE_WAKE_KEY, { ...w, due: { ...w.due, intents: Date.now() - 1 } });
    });
    expect(await runDurableObjectAlarm(object(s))).toBe(true);
    // Filtered: the other tests' scopes armed their own alarms, which may fire meanwhile.
    expect(kicks.filter((k) => k.body.scopeId === s)).toEqual([
      { secret: 'wake-version-test-secret', body: { tenantId: t, scopeId: s, platformRequests: true, events: false, source: 'scope' } },
    ]);
    await local.close();
  });

  it('a pending ask from an earlier version is enough: the next promote records the version and writes nothing', async () => {
    const { s } = await install('01JWAKEP1000000000000000AA');
    setVersion('01JWAKEP2000000000000000AA');
    await wake(s);
    setVersion('01JWAKEP3000000000000000AA');
    await wake(s);
    expect((await asks(s)).map((a) => JSON.parse(a.payload).wokeOn)).toEqual(['01JWAKEP2000000000000000AA']);
    expect(await asked(s)).toBe('01JWAKEP3000000000000000AA');
  });

  it('a migration that fails on the wake answers the request with its failure and asks nothing; the wake that applies it asks once', async () => {
    const { t, s } = await install('01JWAKEF1000000000000000AA');
    // `0002-hold` forgotten from the journal: re-applied, its ADD COLUMN meets the column and fails.
    const key = `${listMod.manifest.id}@0002-hold`;
    const journal = await runInDurableObject(object(s), (instance, state) => {
      const where = `FROM _substrat_migrations WHERE module_id = '${listMod.manifest.id}' AND version = '0002-hold'`;
      const row = state.storage.sql.exec(`SELECT * ${where}`).toArray()[0]!;
      state.storage.sql.exec(`DELETE ${where}`);
      const applied = (instance as unknown as { applied: Map<string, string | null> }).applied;
      const digest = applied.get(key) ?? null;
      applied.delete(key);
      return { row, digest };
    });
    setVersion('01JWAKEF2000000000000000AA');
    await expect(() => wake(s)).rejects.toThrow(/migration failed/);
    // The request that woke it is refused with the same failure: the scope fails closed, as today.
    await expect(() => flagged(t, s)).rejects.toThrow(/migration failed/);
    expect(await asks(s)).toEqual([]);
    expect(await asked(s)).toBe('01JWAKEF1000000000000000AA');
    // The repair (the journal row back), then the retry: the pass succeeds, and only now does the scope ask.
    await runInDurableObject(object(s), (instance, state) => {
      const cols = Object.keys(journal.row);
      state.storage.sql.exec(
        `INSERT INTO _substrat_migrations (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        ...cols.map((c) => journal.row[c] as SqlStorageValue),
      );
      (instance as unknown as { applied: Map<string, string | null> }).applied.set(key, journal.digest);
    });
    await wake(s);
    expect((await asks(s)).map((a) => JSON.parse(a.payload).wokeOn)).toEqual(['01JWAKEF2000000000000000AA']);
  });

  it('a copy (a preview or a fork) asks for nothing, and a full journal asks again on the next wake', async () => {
    const copy = await install('01JWAKEC1000000000000000AA');
    await runInDurableObject(object(copy.s), (_i, state) => {
      markCopyOrigin(
        {
          all: (q, ...p) => state.storage.sql.exec(q, ...p).toArray() as Record<string, unknown>[],
          run: (q, ...p) => void state.storage.sql.exec(q, ...p),
        },
        new Date().toISOString(),
      );
    });
    setVersion('01JWAKEC2000000000000000AA');
    await wake(copy.s);
    expect(await asks(copy.s)).toEqual([]);

    const full = await install('01JWAKEJ1000000000000000AA');
    await runInDurableObject(object(full.s), (_i, state) => {
      for (let i = 0; i < MAX_PENDING_PLATFORM_REQUESTS; i++) {
        state.storage.sql.exec(
          `INSERT INTO _substrat_platform_requests (id, kind, payload, requested_by, status, attempts, requested_at)
           VALUES (?, 'provision-sibling', '{}', '"someone"', 'pending', 0, ?)`,
          ulid(),
          new Date().toISOString(),
        );
      }
    });
    setVersion('01JWAKEJ2000000000000000AA');
    await wake(full.s);
    expect(await asks(full.s)).toEqual([]);
    expect(await asked(full.s)).toBe('01JWAKEJ1000000000000000AA');
    await runInDurableObject(object(full.s), (_i, state) => {
      state.storage.sql.exec(`UPDATE _substrat_platform_requests SET status = 'done' WHERE kind = 'provision-sibling'`);
    });
    await wake(full.s);
    expect(await asks(full.s)).toHaveLength(1);
  });
});
