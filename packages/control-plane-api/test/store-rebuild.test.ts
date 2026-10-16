import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateScopeStoreKeyPair } from '@substrat-run/contracts/scope-store-envelope';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { manualClock, ulid, type ManualClock } from '@substrat-run/kernel';
import {
  platformActorId,
  RESERVED_STORE_OPERATIONS,
  storeDriverReleaseDigest,
  type ReservedStoreOperation,
  type StoreDriverRegistration,
} from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  createScopeStoreEnsurer,
  createStoreCanaryEnsurer,
  DEV_ACTOR_HEADER,
  runStoreDriverRollout,
  runStoreFleetRebuild,
  STORE_RELEASE_VAR,
  storedReleaseLoader,
  storeDriverRelease,
  storePlatformFingerprint,
  storeRebuildStatus,
  UNSAFE_devPlatformActorAuth,
  type CanaryCall,
} from '../src/index.js';
import { PUSH_HOLD_TTL_MS } from '../src/store-releases.js';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { STORE_REBUILD_REVERIFY_MS, STORE_REBUILD_SETTLE_MS } from '../src/store-rebuild.js';

/**
 * The platform's rebuild of every store script (#2309): a key list or the entry changes, no
 * vertical is pushed, and every script still comes to carry it, at the release it runs. The
 * scripts are a fake runtime that keeps each script's bindings; the ensurer, the loader, the
 * holds and the directory are the real ones.
 */

const COMMIT = 'c'.repeat(40);
const CALLER_KEYS = 'SUBSTRAT_STORE_CALLER_KEYS';
const text = (s: string) => new TextEncoder().encode(s);
const bundle = (n: number) => ({
  sourceCommit: COMMIT,
  entry: 'driver_graph/store.py',
  modules: [{ name: 'driver_graph/store.py', content: text(`class Store:\n    v = ${n}\n`) }],
});
const wire = (b: ReturnType<typeof bundle>) => ({
  sourceCommit: b.sourceCommit,
  entry: b.entry,
  modules: b.modules.map((m) => ({ name: m.name, contentBase64: btoa(String.fromCharCode(...m.content)) })),
});
const scriptOf = (vertical: string) => `substrat-store-graph-${vertical}`;
const CANARY = 'substrat-store-graph--canary';

/** Every reserved call answers as an empty object does, so a canary passes. */
const canaryCall: CanaryCall = async (_target, operation: ReservedStoreOperation, input) => {
  switch (operation) {
    case 'substrat.export':
      return { tables: [] };
    case 'substrat.import':
      return { tables: (input as { tables: unknown[] }).tables.length };
    case 'substrat.erase':
      return { erased: 0 };
    default:
      return { bytes: 0 };
  }
};

describe('the fleet rebuild (#2309)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let clock: ManualClock;
  const staff = platformActorId.parse(ulid());
  const scripts = new Map<string, { name: string; text?: string }[]>();
  const puts: string[] = [];
  const settingsReads: string[] = [];
  const failPut = new Set<string>();
  const releaseBytes = new Map<string, Uint8Array>();
  const bytes = { get: async (k: string) => releaseBytes.get(k), put: async (k: string, b: Uint8Array) => void releaseBytes.set(k, b) };
  let registration: StoreDriverRegistration;
  let s1: string;
  let s2: string;
  let keysA: { caller: string; platform: string };
  let keysB: { caller: string; platform: string };

  const optionsWith = (keys: { caller: string; platform: string }) => ({
    accountId: 'a',
    namespace: 'n',
    apiToken: 't',
    callerPublicKeys: [keys.caller],
    platformPublicKeys: [keys.platform],
    drivers: [registration],
  });
  const ensureWith = (keys: { caller: string; platform: string }) => ({ loadRelease, ...input }: Parameters<ReturnType<typeof createScopeStoreEnsurer>>[0] & { loadRelease: Parameters<typeof createScopeStoreEnsurer>[0]['loadRelease'] }) =>
    createScopeStoreEnsurer({ ...optionsWith(keys), loadRelease })(input);
  const canaryWith = (keys: { caller: string; platform: string }) => async ({ loadRelease, ...input }: { driver: string; existingOnly: true; loadRelease: Parameters<typeof createScopeStoreEnsurer>[0]['loadRelease'] }) =>
    ({ uploaded: (await createStoreCanaryEnsurer({ ...optionsWith(keys), loadRelease })(input)).uploaded });
  const pass = async (keys: { caller: string; platform: string }, budget = 100, reverify: 'always' | 'when-due' = 'when-due') =>
    (
      await runStoreFleetRebuild({
        admin: host.admin,
        actor: staff,
        drivers: [registration],
        fingerprint: await storePlatformFingerprint({ callerPublicKeys: [keys.caller], platformPublicKeys: [keys.platform] }),
        bytes,
        ensure: ensureWith(keys),
        ensureCanary: canaryWith(keys),
        budget,
        reverify,
        now: () => Date.parse(clock.read()),
      })
    )[0]!;
  const binding = (script: string, name: string) => scripts.get(script)?.find((b) => b.name === name)?.text;
  const declare = async (slug: string) => {
    await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
    const id = ulid();
    await host.admin.publishVersion(staff, {
      id, verticalSlug: slug, version: '1.0.0', manifestDigest: `m-${id}`, permissionDigest: 'p', migrationDigest: 'g',
      deploymentRef: null, manifestJson: JSON.stringify({ scopeStores: [{ binding: 'GRAPH', driver: 'graph' }] }),
    });
  };
  /** Roll `sha` out with keys `keys`, up to `perRequest` verticals. */
  const rollOut = (sha: string, keys: { caller: string; platform: string }, perRequest?: number) => {
    const loadRelease = storedReleaseLoader({ admin: host.admin, actor: staff, bytes });
    return runStoreDriverRollout({
      admin: host.admin,
      actor: staff,
      registration,
      sha256: sha,
      action: 'rollout',
      ensure: async (input) => (await createScopeStoreEnsurer({ ...optionsWith(keys), loadRelease })(input)).uploaded > 0,
      ensureCanary: (to) => createStoreCanaryEnsurer({ ...optionsWith(keys), loadRelease })({ driver: 'graph', to }),
      callCanary: canaryCall,
      ...(perRequest ? { perRequest } : {}),
    });
  };
  /** A push of one vertical, with the keys the control plane holds then. */
  const push = (vertical: string, keys: { caller: string; platform: string }) =>
    createScopeStoreEnsurer({ ...optionsWith(keys), loadRelease: storedReleaseLoader({ admin: host.admin, actor: staff, bytes }) })({
      vertical,
      stores: [{ binding: 'GRAPH', driver: 'graph' }],
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-store-rebuild-'));
    clock = manualClock('2026-10-16T00:00:00.000Z');
    host = new SqliteScopeHost({ dir, clock: clock.read });
    for (const m of [scripts, releaseBytes]) m.clear();
    for (const l of [puts, settingsReads]) l.length = 0;
    failPut.clear();
    [s1, s2] = [await storeDriverReleaseDigest(bundle(1)), await storeDriverReleaseDigest(bundle(2))];
    registration = {
      driver: 'graph',
      releases: [
        { sha256: s1, sourceCommit: COMMIT, schema: 0 },
        { sha256: s2, sourceCommit: COMMIT, schema: 0 },
      ],
      className: 'Store',
      operations: [],
      platformOperations: [...RESERVED_STORE_OPERATIONS],
    };
    keysA = { caller: (await generateScopeStoreKeyPair()).publicKey, platform: (await generateScopeStoreKeyPair()).publicKey };
    keysB = { caller: (await generateScopeStoreKeyPair()).publicKey, platform: keysA.platform };
    for (const n of [1, 2]) await storeDriverRelease({ admin: host.admin, actor: staff, bytes, driver: 'graph', body: wire(bundle(n)) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: FormData }) => {
        const script = decodeURIComponent(url.split('/scripts/')[1]!.split('/')[0]!);
        if (url.endsWith('/settings')) {
          settingsReads.push(script);
          const bindings = scripts.get(script);
          return bindings ? Response.json({ result: { bindings } }) : new Response('{}', { status: 404 });
        }
        if (failPut.has(script)) return new Response('{}', { status: 500 });
        puts.push(script);
        scripts.set(script, JSON.parse(await (init!.body!.get('metadata') as File).text()).bindings);
        return new Response('{}', { status: 200 });
      }),
    );
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the fingerprint moves with a key list and nothing else of a script', async () => {
    const a = await storePlatformFingerprint({ callerPublicKeys: [keysA.caller], platformPublicKeys: [keysA.platform] });
    expect(await storePlatformFingerprint({ callerPublicKeys: [keysA.caller], platformPublicKeys: [keysA.platform] })).toBe(a);
    expect(await storePlatformFingerprint({ callerPublicKeys: [keysB.caller], platformPublicKeys: [keysB.platform] })).not.toBe(a);
    // A key added beside the one in use is a change too: the list is what a script verifies with.
    expect(await storePlatformFingerprint({ callerPublicKeys: [keysA.caller, keysB.caller], platformPublicKeys: [keysA.platform] })).not.toBe(a);
  });

  it('a revoked key leaves every script without a push, at the release each runs, and a second pass does nothing', async () => {
    for (const v of ['va', 'vb']) await declare(v);
    expect((await rollOut(s1, keysA)).complete).toBe(true);
    for (const s of [scriptOf('va'), scriptOf('vb'), CANARY]) expect(binding(s, CALLER_KEYS)).toBe(keysA.caller);
    // The caller key is revoked: the control plane now holds B. Nobody pushes.
    puts.length = 0;
    const done = await pass(keysB);
    expect(done).toMatchObject({ outcome: 'done', walked: ['-canary', 'va', 'vb'], uploaded: ['-canary', 'va', 'vb'] });
    for (const s of [scriptOf('va'), scriptOf('vb'), CANARY]) {
      expect(binding(s, CALLER_KEYS)).toBe(keysB.caller);
      expect(binding(s, STORE_RELEASE_VAR)).toBe(s1);
    }
    expect(puts.sort()).toEqual([CANARY, scriptOf('va'), scriptOf('vb')].sort());
    // Done at this fingerprint: the next pass reads the directory and nothing else.
    puts.length = 0;
    settingsReads.length = 0;
    expect(await pass(keysB)).toMatchObject({ outcome: 'current', walked: [] });
    expect([puts, settingsReads]).toEqual([[], []]);
  });

  it('creates no script: a vertical that declared the driver and has none is left without one', async () => {
    for (const v of ['va', 'vb']) await declare(v);
    expect((await rollOut(s1, keysA)).complete).toBe(true);
    await declare('vc');
    const done = await pass(keysB);
    expect(done).toMatchObject({ outcome: 'done', walked: ['-canary', 'va', 'vb', 'vc'], uploaded: ['-canary', 'va', 'vb'] });
    expect(scripts.has(scriptOf('vc'))).toBe(false);
  });

  it('walks at most its budget a pass, resumes at its cursor, and a vertical pushed meanwhile is neither walked twice nor uploaded again', async () => {
    for (const v of ['va', 'vb', 'vc']) await declare(v);
    expect((await rollOut(s1, keysA)).complete).toBe(true);
    const first = await pass(keysB, 2);
    expect(first).toMatchObject({ outcome: 'paused', walked: ['-canary', 'va'] });
    expect(first.rebuild).toMatchObject({ cursor: 'va', state: 'running' });
    // Mid-walk, a new vertical behind the cursor (v0 < va) is pushed for the first time, and one
    // ahead of it (vc) is pushed again, both with B: each push builds from the current fingerprint.
    await declare('v0');
    puts.length = 0;
    await push('v0', keysB);
    await push('vc', keysB);
    // va was rebuilt by the walk already, so its push uploads nothing either.
    await push('va', keysB);
    expect(puts).toEqual([scriptOf('v0'), scriptOf('vc')]);
    puts.length = 0;
    settingsReads.length = 0;
    const second = await pass(keysB, 2);
    // v0 and va are behind the cursor and not walked; vc is walked and found current, so not uploaded.
    expect(second).toMatchObject({ outcome: 'done', walked: ['vb', 'vc'], uploaded: ['vb'] });
    expect(puts).toEqual([scriptOf('vb')]);
    expect(settingsReads).toEqual([scriptOf('vb'), scriptOf('vc')]);
    for (const v of ['v0', 'va', 'vb', 'vc']) expect(binding(scriptOf(v), CALLER_KEYS)).toBe(keysB.caller);
  });

  it('starts over when the fingerprint changes mid-walk', async () => {
    for (const v of ['va', 'vb']) await declare(v);
    expect((await rollOut(s1, keysA)).complete).toBe(true);
    expect(await pass(keysB, 2)).toMatchObject({ outcome: 'paused', walked: ['-canary', 'va'] });
    // Another key change before the walk ended: va and the canary carry B, and must carry C.
    const keysC = { caller: (await generateScopeStoreKeyPair()).publicKey, platform: keysA.platform };
    const restarted = await pass(keysC, 2);
    expect(restarted).toMatchObject({ outcome: 'paused', walked: ['-canary', 'va'] });
    expect(binding(scriptOf('va'), CALLER_KEYS)).toBe(keysC.caller);
    expect(await pass(keysC)).toMatchObject({ outcome: 'done', walked: ['vb'] });
  });

  it('waits out a rollout that holds the driver, and leaves a paused rollout\'s fleet where it is', async () => {
    for (const v of ['va', 'vb']) await declare(v);
    expect((await rollOut(s1, keysA)).complete).toBe(true);
    // A rollout to s2 holds the driver: the pass walks nothing and uploads nothing.
    const rolling = ulid();
    expect(await host.admin.holdStoreDriver(staff, { driver: 'graph', holder: rolling, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
    puts.length = 0;
    settingsReads.length = 0;
    expect(await pass(keysB)).toMatchObject({ outcome: 'held', walked: [] });
    expect([puts, settingsReads]).toEqual([[], []]);
    await host.admin.releaseStoreDriverHold(staff, { driver: 'graph', holder: rolling });
    // The rollout to s2 pauses after one vertical: va runs s2, vb s1.
    expect(await rollOut(s2, keysA, 1)).toMatchObject({ complete: false, moved: ['va'] });
    expect([binding(scriptOf('va'), STORE_RELEASE_VAR), binding(scriptOf('vb'), STORE_RELEASE_VAR)]).toEqual([s2, s1]);
    // The rebuild (its lease released when it met the hold) moves no script to another release.
    expect(await pass(keysB)).toMatchObject({ outcome: 'done', uploaded: ['-canary', 'va', 'vb'] });
    expect([binding(scriptOf('va'), STORE_RELEASE_VAR), binding(scriptOf('vb'), STORE_RELEASE_VAR)]).toEqual([s2, s1]);
    for (const v of ['va', 'vb']) expect(binding(scriptOf(v), CALLER_KEYS)).toBe(keysB.caller);
    // The rollout, posted again, converges the fleet as before.
    expect(await rollOut(s2, keysB)).toMatchObject({ complete: true, moved: ['vb'] });
  });

  it('stops walking when its hold lapses mid-walk and a rollout takes the driver', async () => {
    for (const v of ['va', 'vb']) await declare(v);
    expect((await rollOut(s1, keysA)).complete).toBe(true);
    const rollout = ulid();
    const base = ensureWith(keysB);
    const stalled: typeof base = async (input) => {
      const result = await base(input);
      if (input.vertical === 'va') {
        // The upload of va outlasted the hold, and a rollout took the driver meanwhile.
        clock.advance(PUSH_HOLD_TTL_MS + 1);
        expect(await host.admin.holdStoreDriver(staff, { driver: 'graph', holder: rollout, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
      }
      return result;
    };
    puts.length = 0;
    const [stopped] = await runStoreFleetRebuild({
      admin: host.admin,
      actor: staff,
      drivers: [registration],
      fingerprint: await storePlatformFingerprint({ callerPublicKeys: [keysB.caller], platformPublicKeys: [keysB.platform] }),
      bytes,
      ensure: stalled,
      ensureCanary: canaryWith(keysB),
      budget: 100,
      reverify: 'when-due',
    });
    expect(stopped).toMatchObject({ outcome: 'held', walked: ['-canary', 'va'] });
    expect(puts).toEqual([CANARY, scriptOf('va')]);
    expect(binding(scriptOf('vb'), CALLER_KEYS)).toBe(keysA.caller);
    // Once the rollout ends, the next pass continues after va.
    await host.admin.releaseStoreDriverHold(staff, { driver: 'graph', holder: rollout });
    expect(await pass(keysB)).toMatchObject({ outcome: 'done', walked: ['vb'] });
  });

  it('a script an older control plane uploads after the walk is done is not reported current, and is rebuilt', async () => {
    for (const v of ['va', 'vb']) await declare(v);
    expect((await rollOut(s1, keysA)).complete).toBe(true);
    const fingerprint = await storePlatformFingerprint({ callerPublicKeys: [keysB.caller], platformPublicKeys: [keysB.platform] });
    const status = async () => storeRebuildStatus(await host.admin.storeDriverRebuild(staff, 'graph'), fingerprint, ['va', 'vb']);
    expect(await pass(keysB)).toMatchObject({ outcome: 'done' });
    // Done, but within the hour the new fingerprint appeared: a deploy may still be rolling out.
    expect(await status()).toMatchObject({ current: false, pending: [], settling: expect.any(String) });
    // The control plane still serving the old lists pushes vb after the walk.
    await push('vb', keysA);
    expect(binding(scriptOf('vb'), CALLER_KEYS)).toBe(keysA.caller);
    clock.advance(STORE_REBUILD_SETTLE_MS - 1);
    expect(await pass(keysB)).toMatchObject({ outcome: 'current', walked: [] });
    expect((await status()).current).toBe(false);
    // Once the hour has passed the walk goes again, rebuilds only vb, and now proves every script current.
    clock.advance(1);
    puts.length = 0;
    expect(await pass(keysB)).toMatchObject({ outcome: 'done', walked: ['-canary', 'va', 'vb'], uploaded: ['vb'] });
    expect(puts).toEqual([scriptOf('vb')]);
    expect(binding(scriptOf('vb'), CALLER_KEYS)).toBe(keysB.caller);
    expect(await status()).toMatchObject({ current: true, pending: [] });
    // A settled walk is still walked again a day after it finished, whatever changed meanwhile.
    await push('va', keysA);
    clock.advance(STORE_REBUILD_REVERIFY_MS - 1);
    expect(await pass(keysB)).toMatchObject({ outcome: 'current' });
    clock.advance(1);
    expect(await pass(keysB)).toMatchObject({ outcome: 'done', uploaded: ['va'] });
    // A person's run does not wait for either.
    await push('vb', keysA);
    expect(await pass(keysB, 100, 'always')).toMatchObject({ outcome: 'done', uploaded: ['vb'] });
    expect(binding(scriptOf('vb'), CALLER_KEYS)).toBe(keysB.caller);
  });

  it('rebuilds the script of a vertical whose stores cannot be named, by its name, and never reads current while that fails', async () => {
    for (const v of ['va', 'vb']) await declare(v);
    expect((await rollOut(s1, keysA)).complete).toBe(true);
    // vx's only version has a manifest nobody can read, yet a script of the driver runs under its name.
    await host.admin.registerVertical(staff, { slug: 'vx', name: 'vx', source: 'cli' });
    const id = ulid();
    await host.admin.publishVersion(staff, {
      id, verticalSlug: 'vx', version: '1.0.0', manifestDigest: `m-${id}`, permissionDigest: 'p', migrationDigest: 'g',
      deploymentRef: null, manifestJson: '{nope',
    });
    expect((await host.admin.storeDriverDeclarations(staff, 'graph')).unreadable).toEqual(['vx']);
    await push('vx', keysA);
    const fingerprint = await storePlatformFingerprint({ callerPublicKeys: [keysB.caller], platformPublicKeys: [keysB.platform] });
    // Its rebuild fails: the walk ends failing, and status lists it, not current.
    failPut.add(scriptOf('vx'));
    const failing = await pass(keysB);
    expect(failing).toMatchObject({ outcome: 'failing', walked: ['-canary', 'va', 'vb', 'vx'], uploaded: ['-canary', 'va', 'vb'] });
    expect(storeRebuildStatus(failing.rebuild, fingerprint, ['va', 'vb', 'vx'])).toEqual({ current: false, pending: ['vx'] });
    expect(binding(scriptOf('vx'), CALLER_KEYS)).toBe(keysA.caller);
    // Once it can be uploaded, it is rebuilt by its name like any other, and the driver is current.
    failPut.clear();
    expect(await pass(keysB)).toMatchObject({ outcome: 'done', walked: ['vx'], uploaded: ['vx'] });
    expect(binding(scriptOf('vx'), CALLER_KEYS)).toBe(keysB.caller);
    clock.advance(STORE_REBUILD_SETTLE_MS);
    expect(await pass(keysB)).toMatchObject({ outcome: 'done', walked: ['-canary', 'va', 'vb', 'vx'], uploaded: [] });
    expect(storeRebuildStatus(await host.admin.storeDriverRebuild(staff, 'graph'), fingerprint, ['va', 'vb', 'vx'])).toMatchObject({ current: true });
  });

  it('never takes a walk that began inside the window as proof, though it finished after it (review round 2)', async () => {
    for (const v of ['va', 'vb']) await declare(v);
    expect((await rollOut(s1, keysA)).complete).toBe(true);
    const fingerprint = await storePlatformFingerprint({ callerPublicKeys: [keysB.caller], platformPublicKeys: [keysB.platform] });
    const status = async () => storeRebuildStatus(await host.admin.storeDriverRebuild(staff, 'graph'), fingerprint, ['va', 'vb']);
    // T0: the first pass walks the canary and va, and pauses.
    expect(await pass(keysB, 2)).toMatchObject({ outcome: 'paused', walked: ['-canary', 'va'] });
    // T0+10m: the control plane still serving the old lists re-uploads va.
    clock.advance(10 * 60_000);
    await push('va', keysA);
    // T0+70m: the next pass walks vb and ends the walk, after the window.
    clock.advance(60 * 60_000);
    expect(await pass(keysB, 2)).toMatchObject({ outcome: 'done', walked: ['vb'] });
    // The walk began at T0, inside the window: not current, and the next pass walks it all again.
    expect(await status()).toMatchObject({ current: false, settling: expect.any(String) });
    expect(binding(scriptOf('va'), CALLER_KEYS)).toBe(keysA.caller);
    puts.length = 0;
    expect(await pass(keysB)).toMatchObject({ outcome: 'done', walked: ['-canary', 'va', 'vb'], uploaded: ['va'] });
    expect(binding(scriptOf('va'), CALLER_KEYS)).toBe(keysB.caller);
    expect(await status()).toMatchObject({ current: true });
  });

  it('stays current while a scheduled re-walk re-checks a fleet already proved, and not once a script fails', async () => {
    for (const v of ['va', 'vb']) await declare(v);
    expect((await rollOut(s1, keysA)).complete).toBe(true);
    const fingerprint = await storePlatformFingerprint({ callerPublicKeys: [keysB.caller], platformPublicKeys: [keysB.platform] });
    const status = async () => storeRebuildStatus(await host.admin.storeDriverRebuild(staff, 'graph'), fingerprint, ['va', 'vb']);
    expect(await pass(keysB)).toMatchObject({ outcome: 'done' });
    clock.advance(STORE_REBUILD_SETTLE_MS);
    expect(await pass(keysB)).toMatchObject({ outcome: 'done' });
    expect(await status()).toMatchObject({ current: true });
    // A day later the re-walk pauses part way: still current, and says it is re-verifying.
    clock.advance(STORE_REBUILD_REVERIFY_MS);
    expect(await pass(keysB, 1)).toMatchObject({ outcome: 'paused', walked: ['-canary'] });
    expect(await status()).toEqual({ current: true, pending: [], reverifying: true });
    // A script it reaches fails: not current, and named.
    await push('va', keysA);
    failPut.add(scriptOf('va'));
    expect(await pass(keysB, 1)).toMatchObject({ outcome: 'paused', walked: ['va'] });
    expect(await status()).toMatchObject({ current: false, pending: expect.arrayContaining(['va']) });
    // New lists are not re-verifying anything: nothing at them was ever proved.
    const keysC = { caller: (await generateScopeStoreKeyPair()).publicKey, platform: keysA.platform };
    failPut.clear();
    await pass(keysC, 1);
    const fc = await storePlatformFingerprint({ callerPublicKeys: [keysC.caller], platformPublicKeys: [keysC.platform] });
    expect(storeRebuildStatus(await host.admin.storeDriverRebuild(staff, 'graph'), fc, ['va', 'vb'])).toMatchObject({ current: false });
  });

  it('takes its settle window from the control plane, so a deploy that rolls out longer can be waited out', async () => {
    await declare('va');
    expect((await rollOut(s1, keysA)).complete).toBe(true);
    const fingerprint = await storePlatformFingerprint({ callerPublicKeys: [keysB.caller], platformPublicKeys: [keysB.platform] });
    const run = (settleMs: number) =>
      runStoreFleetRebuild({
        admin: host.admin, actor: staff, drivers: [registration], fingerprint, bytes,
        ensure: ensureWith(keysB), ensureCanary: canaryWith(keysB), budget: 100, reverify: 'when-due',
        now: () => Date.parse(clock.read()), settleMs,
      });
    expect((await run(3 * STORE_REBUILD_SETTLE_MS))[0]).toMatchObject({ outcome: 'done' });
    const row = async () => (await host.admin.storeDriverRebuild(staff, 'graph'))!;
    // Three hours: still settling after one, and walked again only after three.
    clock.advance(STORE_REBUILD_SETTLE_MS);
    expect(storeRebuildStatus(await row(), fingerprint, ['va'], 3 * STORE_REBUILD_SETTLE_MS)).toMatchObject({ current: false, settling: expect.any(String) });
    expect((await run(3 * STORE_REBUILD_SETTLE_MS))[0]).toMatchObject({ outcome: 'current' });
    clock.advance(2 * STORE_REBUILD_SETTLE_MS);
    expect((await run(3 * STORE_REBUILD_SETTLE_MS))[0]).toMatchObject({ outcome: 'done', walked: ['-canary', 'va'] });
    expect(storeRebuildStatus(await row(), fingerprint, ['va'], 3 * STORE_REBUILD_SETTLE_MS)).toMatchObject({ current: true });
    // With no window, a finished walk is proof at once.
    expect(storeRebuildStatus(await row(), fingerprint, ['va'], 0)).toMatchObject({ current: true });
  });

  it('drops a failure of a vertical that no longer declares the driver', async () => {
    for (const v of ['va', 'vb']) await declare(v);
    expect((await rollOut(s1, keysA)).complete).toBe(true);
    failPut.add(scriptOf('vb'));
    expect(await pass(keysB)).toMatchObject({ outcome: 'failing' });
    await host.admin.deleteVertical(staff, 'vb');
    expect(await pass(keysB)).toMatchObject({ outcome: 'done', walked: [] });
    expect((await host.admin.storeDriverRebuild(staff, 'graph'))!.failures).toEqual([]);
  });

  it('never walks a driver another pass holds the lease on', async () => {
    await declare('va');
    expect((await rollOut(s1, keysA)).complete).toBe(true);
    const fingerprint = await storePlatformFingerprint({ callerPublicKeys: [keysB.caller], platformPublicKeys: [keysB.platform] });
    expect(await host.admin.claimStoreDriverRebuild(staff, { driver: 'graph', fingerprint, holder: ulid(), ttlMs: 60_000 })).not.toBeNull();
    puts.length = 0;
    settingsReads.length = 0;
    expect(await pass(keysB)).toMatchObject({ outcome: 'busy', walked: [] });
    expect([puts, settingsReads]).toEqual([[], []]);
    expect(binding(scriptOf('va'), CALLER_KEYS)).toBe(keysA.caller);
  });

  it('records a script it could not rebuild, keeps walking, and retries it until it is rebuilt', async () => {
    for (const v of ['va', 'vb', 'vc']) await declare(v);
    expect((await rollOut(s1, keysA)).complete).toBe(true);
    failPut.add(scriptOf('vb'));
    const failing = await pass(keysB);
    expect(failing).toMatchObject({ outcome: 'failing', walked: ['-canary', 'va', 'vb', 'vc'], uploaded: ['-canary', 'va', 'vc'] });
    expect(failing.rebuild!.failures).toEqual([{ vertical: 'vb', detail: expect.stringMatching(/upload failed \(500\)/) }]);
    const recorded = await host.admin.listOpsFailures(staff, {});
    expect(recorded.filter((f) => f.operation === 'store-rebuild')).toEqual([
      expect.objectContaining({ vertical: 'vb', status: 502, message: expect.stringMatching(/store script rebuild of 'graph' for vb/) }),
    ]);
    const fingerprint = await storePlatformFingerprint({ callerPublicKeys: [keysB.caller], platformPublicKeys: [keysB.platform] });
    expect(storeRebuildStatus(failing.rebuild, fingerprint, ['va', 'vb', 'vc'])).toEqual({ current: false, pending: ['vb'] });
    // Still failing: retried, and nothing else walked again.
    expect(await pass(keysB)).toMatchObject({ outcome: 'failing', walked: ['vb'] });
    failPut.clear();
    const done = await pass(keysB);
    expect(done).toMatchObject({ outcome: 'done', walked: ['vb'], uploaded: ['vb'] });
    // Done, but this walk began inside the settle window, so it proves nothing yet.
    expect(storeRebuildStatus(done.rebuild, fingerprint, ['va', 'vb', 'vc'])).toMatchObject({ current: false, pending: [], settling: expect.any(String) });
    // After the window the scheduled pass walks it all again, from its first script, and that proves it.
    clock.advance(STORE_REBUILD_SETTLE_MS);
    const proved = await pass(keysB);
    expect(proved).toMatchObject({ outcome: 'done', walked: ['-canary', 'va', 'vb', 'vc'], uploaded: [] });
    expect(storeRebuildStatus(proved.rebuild, fingerprint, ['va', 'vb', 'vc'])).toMatchObject({ current: true, pending: [] });
    expect(binding(scriptOf('vb'), CALLER_KEYS)).toBe(keysB.caller);
  });

  describe('the staff route', () => {
    const person = platformActorId.parse(ulid());
    const appWith = (keys: { caller: string; platform: string }, fingerprint = true) =>
      createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        storeDrivers: [registration],
        humanStaffActor: async (r) => (r.headers.get(DEV_ACTOR_HEADER) === person ? person : null),
        ensureScopeStores: ensureWith(keys),
        storeReleases: {
          bytes,
          ensureCanary: ({ loadRelease, ...input }) => createStoreCanaryEnsurer({ ...optionsWith(keys), loadRelease })(input),
          callCanary: canaryCall,
          ...(fingerprint ? { fingerprint: () => storePlatformFingerprint({ callerPublicKeys: [keys.caller], platformPublicKeys: [keys.platform] }) } : {}),
        },
      });
    const call = (app: ReturnType<typeof createControlPlaneApi>, method: string, path: string, actor: string) =>
      app.request(path, { method, headers: { [DEV_ACTOR_HEADER]: actor, 'content-type': 'application/json' } });

    it('shows which scripts are not current, runs a pass for a person, audits it, and refuses the service token', async () => {
      for (const v of ['va', 'vb']) await declare(v);
      expect((await rollOut(s1, keysA)).complete).toBe(true);
      const app = appWith(keysB);
      const before = (await (await call(app, 'GET', '/store-drivers/graph', person)).json()) as { rebuild: { current: boolean; pending: string[] } };
      expect(before.rebuild).toMatchObject({ current: false, pending: ['-canary', 'va', 'vb'] });
      // A service token (no person behind it) runs nothing.
      const service = platformActorId.parse(ulid());
      expect((await call(app, 'POST', '/store-drivers/graph/rebuild', service)).status).toBe(403);
      expect(binding(scriptOf('va'), CALLER_KEYS)).toBe(keysA.caller);
      const ran = await call(app, 'POST', '/store-drivers/graph/rebuild', person);
      expect(ran.status).toBe(200);
      // Every script rebuilt; within the hour the new lists appeared it reads as settling, not current.
      expect(await ran.json()).toMatchObject({ pass: { outcome: 'done', uploaded: ['-canary', 'va', 'vb'] }, rebuild: { current: false, pending: [], settling: expect.any(String) } });
      expect(binding(scriptOf('vb'), CALLER_KEYS)).toBe(keysB.caller);
      const audit = await host.admin.auditLog(staff, { action: 'rebuildStoreDriver' });
      expect(audit).toEqual([expect.objectContaining({ actor: person, after: expect.objectContaining({ driver: 'graph', outcome: 'done' }) })]);
      // Again, once the deploy has surely rolled out: a person's run re-walks a driver that is done,
      // reads every script, uploads none, and now proves it current.
      clock.advance(STORE_REBUILD_SETTLE_MS);
      puts.length = 0;
      expect(await (await call(app, 'POST', '/store-drivers/graph/rebuild', person)).json()).toMatchObject({
        pass: { outcome: 'done', walked: ['-canary', 'va', 'vb'], uploaded: [] },
        rebuild: { current: true },
      });
      expect(puts).toEqual([]);
    });

    it("re-walks a driver a walk already proved, on a person's run, without waiting for the day", async () => {
      await declare('va');
      expect((await rollOut(s1, keysA)).complete).toBe(true);
      const app = appWith(keysB);
      expect((await call(app, 'POST', '/store-drivers/graph/rebuild', person)).status).toBe(200);
      clock.advance(STORE_REBUILD_SETTLE_MS);
      expect(await (await call(app, 'POST', '/store-drivers/graph/rebuild', person)).json()).toMatchObject({ rebuild: { current: true } });
      // Proved current; an older control plane then re-uploads va. A person's run walks again at once.
      await push('va', keysA);
      expect(await (await call(app, 'POST', '/store-drivers/graph/rebuild', person)).json()).toMatchObject({
        pass: { outcome: 'done', walked: ['-canary', 'va'], uploaded: ['va'] },
      });
      expect(binding(scriptOf('va'), CALLER_KEYS)).toBe(keysB.caller);
    });

    it('takes a person\'s attestation that no deploy is rolling out for a walk it starts, audited, and refuses it from a service token', async () => {
      for (const v of ['va', 'vb']) await declare(v);
      expect((await rollOut(s1, keysA)).complete).toBe(true);
      const app = appWith(keysB);
      const post = (actor: string, body: unknown) =>
        app.request('/store-drivers/graph/rebuild', { method: 'POST', headers: { [DEV_ACTOR_HEADER]: actor, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      // The scheduled pass begins a walk inside the window, and pauses.
      expect(await pass(keysB, 2)).toMatchObject({ outcome: 'paused', walked: ['-canary', 'va'] });
      // A service token may not attest.
      expect((await post(platformActorId.parse(ulid()), { deployFinished: true })).status).toBe(403);
      // Without the attestation a person's run finishes that walk as settling.
      const plain = (await (await post(person, {})).json()) as { pass: { walked: string[] }; rebuild: { current: boolean; settling?: string } };
      expect(plain.rebuild).toMatchObject({ current: false, settling: expect.any(String) });
      // With it, the run starts the walk over from its first script, and once done that walk proves it.
      const attested = await post(person, { deployFinished: true });
      expect(attested.status).toBe(200);
      expect(await attested.json()).toMatchObject({ pass: { outcome: 'done', walked: ['-canary', 'va', 'vb'] }, rebuild: { current: true, walk: { attestedBy: person } } });
      expect(await host.admin.auditLog(staff, { action: 'rebuildStoreDriver' })).toEqual(
        expect.arrayContaining([expect.objectContaining({ actor: person, after: expect.objectContaining({ driver: 'graph', outcome: 'done', deployFinished: true }) })]),
      );
      // A later walk the person did not attest carries no attestation, and is judged on the window again.
      await pass(keysB, 100, 'always');
      expect((await host.admin.storeDriverRebuild(staff, 'graph'))!.attestedBy).toBeNull();
      expect((await post(person, { deployFinished: 'yes' })).status).toBe(400);
    });

    it('audits a run refused because the key lists cannot be read', async () => {
      await declare('va');
      const app = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        storeDrivers: [registration],
        humanStaffActor: async () => person,
        ensureScopeStores: ensureWith(keysB),
        storeReleases: {
          bytes,
          ensureCanary: ({ loadRelease, ...input }) => createStoreCanaryEnsurer({ ...optionsWith(keysB), loadRelease })(input),
          callCanary: canaryCall,
          fingerprint: async () => {
            throw new ControlPlaneError(503, 'the store public keys are not usable');
          },
        },
      });
      expect((await call(app, 'POST', '/store-drivers/graph/rebuild', person)).status).toBe(503);
      expect(await host.admin.auditLog(staff, { action: 'rebuildStoreDriver' })).toEqual([
        expect.objectContaining({ actor: person, after: expect.objectContaining({ driver: 'graph', outcome: 'error', error: 'the store public keys are not usable' }) }),
      ]);
    });

    it('answers 501 when the control plane does not rebuild, and reports no rebuild', async () => {
      await declare('va');
      const app = appWith(keysB, false);
      expect((await call(app, 'POST', '/store-drivers/graph/rebuild', person)).status).toBe(501);
      expect(await (await call(app, 'GET', '/store-drivers/graph', person)).json()).not.toHaveProperty('rebuild');
    });
  });
});
