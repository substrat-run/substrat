import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { generateScopeStoreKeyPair } from '@substrat-run/contracts/scope-store-envelope';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { manualClock, ulid, type ManualClock } from '@substrat-run/kernel';
import {
  platformActorId,
  RESERVED_STORE_OPERATIONS,
  STORE_RELEASE_MAX_BYTES,
  STORE_RELEASE_MAX_MODULES,
  storeDriverReleaseDigest,
  type PlatformActorId,
  type ReservedStoreOperation,
  type StoreDriverRegistration,
} from '@substrat-run/contracts';
import {
  canaryStoreRelease,
  approveStoredDriverRelease,
  decodeStoreDriverRelease,
  createControlPlaneApi,
  createScopeStoreEnsurer,
  createStoreCanaryEnsurer,
  STORE_RELEASE_VAR,
  storedReleaseLoader,
  DEV_ACTOR_HEADER,
  ROLLOUT_WALKS_PER_REQUEST,
  ROLLOUT_HOLD_TTL_MS,
  runStoreDriverRollout,
  runStoreDriverRevoke,
  UNSAFE_devPlatformActorAuth,
  type CanaryCall,
} from '../src/index.js';

const storedBytes = (objects: Map<string, Uint8Array>) => ({
  get: async (key: string) => objects.get(key),
  put: async (key: string, value: Uint8Array) => { objects.set(key, value); },
  head: async (key: string) => {
    const value = objects.get(key);
    return value ? { size: value.byteLength } : undefined;
  },
  open: async (key: string) => {
    const value = objects.get(key);
    return value ? { size: value.byteLength, body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(value); controller.close(); },
    }) } : undefined;
  },
});

/**
 * A store driver's release flow (D-63, #2300): the canary on the platform's own object, the rollout
 * across every vertical that declared the driver, where a failure returns to, and the routes that
 * admit a person and refuse the service token. The scripts are a fake fleet that records which
 * release each one runs; the directory is the real pure host.
 */

/**
 * A refusal as a plain `{ status, message }`, matched with `expect.stringMatching`. A bare RegExp as a
 * `toMatchObject` value asserts nothing: subset equality reads it as an object with no keys, so
 * `{ message: /x/ }` matches any message. A promise that resolves fails here.
 */
async function refusal(p: Promise<unknown>): Promise<{ status?: number; message: string }> {
  return p.then(
    () => {
      throw new Error('expected a refusal, and the call resolved');
    },
    (e: Error & { status?: number }) => ({ status: e.status, message: e.message }),
  );
}

const sha = (c: string) => c.repeat(64);
const COMMIT = 'c'.repeat(40);

/** An object store the canary can drive: one table, kept per object name. */
function canaryStore(fail: Partial<Record<ReservedStoreOperation, (answer: unknown) => unknown>> = {}) {
  const calls: { scriptName: string; objectName: string; operation: ReservedStoreOperation }[] = [];
  const tables = new Map<string, { name: string; rows: unknown[] }[]>();
  const call: CanaryCall = async (target, operation, input) => {
    calls.push({ ...target, operation });
    const held = tables.get(target.objectName) ?? [{ name: 'nodes', rows: [] }];
    let answer: unknown;
    switch (operation) {
      case 'substrat.size':
        answer = { bytes: 0 };
        break;
      case 'substrat.export':
        answer = { tables: held };
        break;
      case 'substrat.import':
        tables.set(target.objectName, (input as { tables: { name: string; rows: unknown[] }[] }).tables);
        answer = { tables: (input as { tables: unknown[] }).tables.length };
        break;
      case 'substrat.erase':
        answer = { erased: 0 };
        break;
      case 'substrat.wipe':
        tables.delete(target.objectName);
        answer = {};
        break;
    }
    const override = fail[operation];
    return override ? override(answer) : answer;
  };
  return { call, calls };
}

describe('the canary runs every reserved operation on a fresh platform object (D-63)', () => {
  it('calls all five, in order, at the canary script, on an object no tenant route names', async () => {
    const store = canaryStore();
    await canaryStoreRelease({ call: store.call, scriptName: 'substrat-store-graph--canary' });
    expect(store.calls.map((c) => c.operation)).toEqual([
      'substrat.size',
      'substrat.export',
      'substrat.import',
      'substrat.export',
      'substrat.erase',
      'substrat.wipe',
      'substrat.export',
    ]);
    // Every reserved operation, the list D-63 names, is called.
    expect(new Set(store.calls.map((c) => c.operation))).toEqual(new Set(RESERVED_STORE_OPERATIONS));
    const [name] = new Set(store.calls.map((c) => c.objectName));
    expect(store.calls.every((c) => c.scriptName === 'substrat-store-graph--canary')).toBe(true);
    const [tenant, vertical, scope, binding] = name!.split('/');
    expect(vertical).toBe('-canary');
    expect(binding).toBe('CANARY');
    expect(tenant).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(scope).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // Two fresh ids, unrelated: their random halves share no long prefix, as a monotonic mint's
    // second id in the same millisecond would (the first plus one).
    const common = [...tenant!.slice(10)].findIndex((ch, i) => ch !== scope![10 + i]);
    expect(common).toBeLessThan(12);
    // A fresh object every canary.
    const again = canaryStore();
    await canaryStoreRelease({ call: again.call, scriptName: 'substrat-store-graph--canary' });
    expect(again.calls[0]!.objectName).not.toBe(name);
  });

  it('refuses at the first operation that fails or answers what an empty object would not', async () => {
    const boom = () => {
      throw new Error('boom');
    };
    const cases: [Partial<Record<ReservedStoreOperation, (answer: unknown) => unknown>>, RegExp][] = [
      [{ 'substrat.size': boom }, /size failed/],
      [{ 'substrat.export': () => ({ tables: [{ name: 'nodes', rows: [{ id: 1 }] }] }) }, /exported rows/],
      [{ 'substrat.import': () => ({ tables: 7 }) }, /imported 7 of 1/],
      [{ 'substrat.erase': () => ({ erased: 2 }) }, /erased rows/],
      [{ 'substrat.erase': boom }, /erase failed/],
      [{ 'substrat.wipe': boom }, /wipe failed/],
    ];
    for (const [fail, pattern] of cases) {
      const store = canaryStore(fail);
      expect(await refusal(canaryStoreRelease({ call: store.call, scriptName: 's' })), String(pattern)).toMatchObject({
        status: 502,
        message: expect.stringMatching(pattern),
      });
    }
    // An import the object does not keep: the second export differs.
    let exports = 0;
    const forgetful = canaryStore({ 'substrat.export': (a) => (++exports === 2 ? { tables: [] } : a) });
    expect(await refusal(canaryStoreRelease({ call: forgetful.call, scriptName: 's' }))).toMatchObject({ message: expect.stringMatching(/did not export what it imported/) });
    // A wipe that leaves rows behind: the export after it says so.
    let seen = 0;
    const sticky = canaryStore({ 'substrat.export': (x) => (++seen === 3 ? { tables: [{ name: 'nodes', rows: [{ id: 1 }] }] } : x) });
    expect(await refusal(canaryStoreRelease({ call: sticky.call, scriptName: 's' }))).toMatchObject({ message: expect.stringMatching(/still holds rows after its wipe/) });
  });
});

/** A fleet of store scripts: which release each vertical's script runs. */
function fleet() {
  const runs = new Map<string, string>();
  const events: string[] = [];
  /** Every vertical walked, as `<vertical>:<release>`, whether or not anything was uploaded. */
  const walks: string[] = [];
  const fail = new Set<string>();
  /** Uploads that land, then answer an error. */
  const landed = new Set<string>();
  /** Runs before an upload, by key: a test lets time pass or another holder in there. */
  const before = new Map<string, () => Promise<void>>();
  return {
    runs,
    events,
    walks,
    fail,
    landed,
    before,
    /** Uploads unless the script already runs `to`, as the real ensurer does, and says which. */
    ensure: async ({ vertical, to }: { vertical: string; to: string }) => {
      walks.push(`${vertical}:${to.slice(0, 1)}`);
      if (runs.get(vertical) === to) return false;
      const key = `${vertical}:${to.slice(0, 1)}`;
      await before.get(key)?.();
      events.push(key);
      if (landed.has(key)) {
        runs.set(vertical, to);
        throw new Error(`upload of ${vertical} answered 502 after it landed`);
      }
      if (fail.has(`${vertical}:${to.slice(0, 1)}`)) throw new Error(`upload of ${vertical} failed`);
      runs.set(vertical, to);
      return true;
    },
  };
}

describe('a rollout canaries, then moves every vertical that declared the driver, and returns on failure', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const registration: StoreDriverRegistration = {
    driver: 'graph',
    releases: [
      { sha256: sha('1'), sourceCommit: COMMIT, schema: 0 },
      { sha256: sha('2'), sourceCommit: COMMIT, schema: 0 },
      { sha256: sha('3'), sourceCommit: COMMIT, schema: 1 },
    ],
    className: 'Store',
    operations: [],
    platformOperations: [...RESERVED_STORE_OPERATIONS],
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-store-rollout-'));
    clock = manualClock();
    host = new SqliteScopeHost({ dir, clock: clock.read });
    for (const s of ['1', '2', '3']) await host.admin.recordStoreDriverRelease(staff, { driver: 'graph', sha256: sha(s), sourceCommit: COMMIT });
    for (const slug of ['va', 'vb', 'vc']) await declare(slug);
  });
  const declare = async (slug: string) => {
    await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
    const id = ulid();
    await host.admin.publishVersion(staff, {
      id,
      verticalSlug: slug,
      version: '1.0.0',
      manifestDigest: `m-${id}`,
      permissionDigest: 'p',
      migrationDigest: 'g',
      deploymentRef: null,
      manifestJson: JSON.stringify({ scopeStores: [{ binding: 'GRAPH', driver: 'graph' }] }),
    });
  };
  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (
    f: ReturnType<typeof fleet>,
    sha256: string,
    extra: { canaryFails?: boolean; perRequest?: number; perRequestWalks?: number; admin?: typeof host.admin } = {},
  ) =>
    runStoreDriverRollout({
      admin: extra.admin ?? host.admin,
      actor: staff,
      registration,
      sha256,
      action: 'rollout',
      ensure: f.ensure,
      ensureCanary: async (to) => {
        f.events.push(`canary:${to.slice(0, 1)}`);
        if (extra.canaryFails) throw new Error('canary upload refused');
        return { scriptName: 'substrat-store-graph--canary' };
      },
      callCanary: canaryStore().call,
      ...(extra.perRequest ? { perRequest: extra.perRequest } : {}),
      ...(extra.perRequestWalks ? { perRequestWalks: extra.perRequestWalks } : {}),
    });
  let clock: ManualClock;
  const current = async () => (await host.admin.storeDriverState(staff, 'graph')).current?.sha256;
  const lastState = async () => (await host.admin.storeDriverState(staff, 'graph')).rollouts.at(-1)?.state;

  it('canaries first, then moves each vertical, and makes the release current', async () => {
    const f = fleet();
    const result = await run(f, sha('1'));
    expect(f.events).toEqual(['canary:1', 'va:1', 'vb:1', 'vc:1']);
    expect(result).toMatchObject({ complete: true, moved: ['va', 'vb', 'vc'], rollout: { state: 'good' } });
    expect(await current()).toBe(sha('1'));
    // The hold is released: a push may hold the driver again.
    expect(await host.admin.holdStoreDriver(staff, { driver: 'graph', holder: ulid(), mode: 'shared', ttlMs: 1000 })).toBe(true);
  });

  it('moves no vertical when the canary fails, and the current release stays', async () => {
    const f = fleet();
    await run(f, sha('1'));
    f.events.length = 0;
    await expect(run(f, sha('2'), { canaryFails: true })).rejects.toThrow(/canary upload refused/);
    expect(f.events).toEqual(['canary:2']);
    expect(await current()).toBe(sha('1'));
    expect(await lastState()).toBe('failed');
    // A canary whose answers are wrong stops it the same way.
    f.events.length = 0;
    expect(await refusal(
      runStoreDriverRollout({
        admin: host.admin,
        actor: staff,
        registration,
        sha256: sha('2'),
        action: 'rollout',
        ensure: f.ensure,
        ensureCanary: async () => ({ scriptName: 'c' }),
        callCanary: canaryStore({ 'substrat.erase': () => ({ erased: 1 }) }).call,
      }),
    )).toMatchObject({ status: 502, message: expect.stringMatching(/canary refused/) });
    expect(f.events).toEqual([]);
    expect(await current()).toBe(sha('1'));
  });

  it('returns every vertical it reached to the release it started from when one upload fails', async () => {
    const f = fleet();
    await run(f, sha('1'));
    f.events.length = 0;
    f.fail.add('vb:2');
    expect(await refusal(run(f, sha('2')))).toMatchObject({ message: expect.stringMatching(/stopped at vb.*va, vb returned to 1{64}/) });
    // va moved and returned. vb failed, and its return is asked too, in case the upload landed; the
    // fleet finds it still on 1 and uploads nothing. vc never moved.
    expect(f.events).toEqual(['canary:2', 'va:2', 'vb:2', 'va:1']);
    expect([...f.runs]).toEqual([['va', sha('1')], ['vb', sha('1')], ['vc', sha('1')]]);
    expect(await current()).toBe(sha('1'));
    expect(await lastState()).toBe('failed');
  });

  it('ends diverged, returning nothing, on a first rollout, across a schema raise, or when a return fails', async () => {
    const first = fleet();
    first.fail.add('vb:1');
    expect(await refusal(run(first, sha('1')))).toMatchObject({ message: expect.stringMatching(/no earlier release/) });
    expect(first.events).toEqual(['canary:1', 'va:1', 'vb:1']);
    expect(await current()).toBeUndefined();
    expect(await lastState()).toBe('diverged');

    // Converged by running it again.
    first.fail.clear();
    expect((await run(first, sha('1'))).complete).toBe(true);
    await run(first, sha('2'));

    // 2 → 3 raises the schema: objects that woke under 3 may have migrated, so nothing returns to 2.
    first.events.length = 0;
    first.fail.add('vc:3');
    expect(await refusal(run(first, sha('3')))).toMatchObject({ message: expect.stringMatching(/lower the stored schema/) });
    expect(first.events).toEqual(['canary:3', 'va:3', 'vb:3', 'vc:3']);
    expect(await current()).toBe(sha('2'));
    expect(await lastState()).toBe('diverged');

    // A return that fails leaves it diverged and says which.
    const back = fleet();
    await run(back, sha('1'));
    back.fail.add('vb:2');
    back.fail.add('va:1');
    expect(await refusal(run(back, sha('2')))).toMatchObject({ message: expect.stringMatching(/Could not return va/) });
    expect(await lastState()).toBe('diverged');
  });

  it('returns a vertical whose failed upload landed anyway', async () => {
    const f = fleet();
    await run(f, sha('1'));
    f.landed.add('vb:2');
    expect(await refusal(run(f, sha('2')))).toMatchObject({ message: expect.stringMatching(/va, vb returned to 1{64}/) });
    expect([...f.runs]).toEqual([['va', sha('1')], ['vb', sha('1')], ['vc', sha('1')]]);
  });

  it('stops at once, returning nothing, when its hold lapsed and another holder took the driver', async () => {
    const f = fleet();
    await run(f, sha('1'));
    f.events.length = 0;
    const other = ulid();
    // During vb's upload the lease runs out and another rollout takes the driver.
    f.before.set('vb:2', async () => {
      clock.advance(ROLLOUT_HOLD_TTL_MS + 1);
      expect(await host.admin.holdStoreDriver(staff, { driver: 'graph', holder: other, mode: 'exclusive', ttlMs: ROLLOUT_HOLD_TTL_MS })).toBe(true);
    });
    expect(await refusal(run(f, sha('2')))).toMatchObject({ status: 409, message: expect.stringMatching(/lapsed or its rollout was ended by another.*Nothing was returned/) });
    // vc was never moved, and va and vb were not moved back under the other holder.
    expect(f.events).toEqual(['canary:2', 'va:2', 'vb:2']);
    // The stopped rollout reads as diverged, though nothing could write that.
    expect(await lastState()).toBe('diverged');
    await host.admin.releaseStoreDriverHold(staff, { driver: 'graph', holder: other });
  });

  it('does not take the driver back after its lease lapsed, even once the other holder is gone', async () => {
    const f = fleet();
    await run(f, sha('1'));
    f.events.length = 0;
    const other = ulid();
    // The lease runs out; another holder takes the driver, finishes, and lets it go again.
    f.before.set('vb:2', async () => {
      clock.advance(ROLLOUT_HOLD_TTL_MS + 1);
      expect(await host.admin.holdStoreDriver(staff, { driver: 'graph', holder: other, mode: 'exclusive', ttlMs: ROLLOUT_HOLD_TTL_MS })).toBe(true);
      const row = await host.admin.beginStoreDriverRollout(staff, { driver: 'graph', sha256: sha('1'), action: 'rollout', holder: other });
      await host.admin.finishStoreDriverRollout(staff, { driver: 'graph', seq: row.seq, holder: other, state: 'good', detail: null });
      await host.admin.releaseStoreDriverHold(staff, { driver: 'graph', holder: other });
    });
    expect(await refusal(run(f, sha('2')))).toMatchObject({ status: 409, message: expect.stringMatching(/lapsed or its rollout was ended by another/) });
    // vc is not moved to 2 while the state says 1 is current.
    expect(f.events).toEqual(['canary:2', 'va:2', 'vb:2']);
    expect(await current()).toBe(sha('1'));
  });

  it('stops returning when the hold is lost during the return', async () => {
    const f = fleet();
    await run(f, sha('1'));
    f.events.length = 0;
    f.fail.add('vc:2');
    const other = ulid();
    f.before.set('va:1', async () => {
      clock.advance(ROLLOUT_HOLD_TTL_MS + 1);
      await host.admin.holdStoreDriver(staff, { driver: 'graph', holder: other, mode: 'exclusive', ttlMs: ROLLOUT_HOLD_TTL_MS });
    });
    expect(await refusal(run(f, sha('2')))).toMatchObject({ message: expect.stringMatching(/hold was lost while returning; vb, vc may run/) });
    // va went back; vb was not touched once the hold was gone.
    expect(f.events).toEqual(['canary:2', 'va:2', 'vb:2', 'vc:2', 'va:1']);
    await host.admin.releaseStoreDriverHold(staff, { driver: 'graph', holder: other });
  });

  it('refuses while another holder holds the driver, and begins nothing', async () => {
    const f = fleet();
    const push = ulid();
    expect(await host.admin.holdStoreDriver(staff, { driver: 'graph', holder: push, mode: 'shared', ttlMs: 60_000 })).toBe(true);
    expect(await refusal(run(f, sha('1')))).toMatchObject({ status: 409, message: expect.stringMatching(/being rolled out or a vertical declaring it is being pushed/) });
    expect(f.events).toEqual([]);
    expect((await host.admin.storeDriverState(staff, 'graph')).rollouts).toEqual([]);
  });

  it('moves a fleet bigger than one request over several posts, each continuing where the last stopped', async () => {
    for (const slug of ['vd', 've']) await declare(slug);
    const f = fleet();
    const first = await run(f, sha('1'), { perRequest: 2 });
    expect(first).toMatchObject({ complete: false, moved: ['va', 'vb'], rollout: { state: 'paused' } });
    expect(await current()).toBeUndefined();
    const second = await run(f, sha('1'), { perRequest: 2 });
    expect(second).toMatchObject({ complete: false, moved: ['vc', 'vd'] });
    const third = await run(f, sha('1'), { perRequest: 2 });
    expect(third).toMatchObject({ complete: true, moved: ['ve'], rollout: { state: 'good' } });
    expect(await current()).toBe(sha('1'));
    // Each script was uploaded once, after one canary per post.
    expect(f.events).toEqual(['canary:1', 'va:1', 'vb:1', 'canary:1', 'vc:1', 'vd:1', 'canary:1', 've:1']);
  });

  it('continues a rollback bigger than one request onto its target, never turning it around', async () => {
    for (const slug of ['vd', 've']) await declare(slug);
    const f = fleet();
    await run(f, sha('1'));
    await run(f, sha('2'));
    f.events.length = 0;
    // Each post asks the state where a rollback goes, as the route does.
    const rollback = async () => {
      const target = (await host.admin.storeDriverState(staff, 'graph')).rollbackTarget!;
      return runStoreDriverRollout({
        admin: host.admin, actor: staff, registration, sha256: target, action: 'rollback', ensure: f.ensure,
        ensureCanary: async () => ({ scriptName: 'c' }), callCanary: canaryStore().call, perRequest: 2,
      });
    };
    expect(await rollback()).toMatchObject({ complete: false, moved: ['va', 'vb'], rollout: { sha256: sha('1'), state: 'paused' } });
    expect((await host.admin.storeDriverState(staff, 'graph')).rollbackTarget).toBe(sha('1'));
    expect(await rollback()).toMatchObject({ complete: false, moved: ['vc', 'vd'], rollout: { sha256: sha('1') } });
    expect(await rollback()).toMatchObject({ complete: true, moved: ['ve'], rollout: { sha256: sha('1'), state: 'good' } });
    expect(await current()).toBe(sha('1'));
    expect(new Set(f.runs.values())).toEqual(new Set([sha('1')]));
    expect(f.events).toEqual(['va:1', 'vb:1', 'vc:1', 'vd:1', 've:1']);
  });

  it('refuses a rollout while a rollback is unfinished, and a failed rollback post does not turn it around', async () => {
    for (const slug of ['vd', 've']) await declare(slug);
    const f = fleet();
    await run(f, sha('1'));
    await run(f, sha('2'));
    f.events.length = 0;
    const rollback = async () =>
      runStoreDriverRollout({
        admin: host.admin, actor: staff, registration, sha256: (await host.admin.storeDriverState(staff, 'graph')).rollbackTarget!,
        action: 'rollback', ensure: f.ensure, ensureCanary: async () => ({ scriptName: 'c' }), callCanary: canaryStore().call, perRequest: 2,
      });
    expect((await rollback()).rollout.state).toBe('paused');
    // The reviewer's sequence: a rollout of 3 now. It is refused before its canary, and moves nothing.
    expect(await refusal(run(f, sha('3')))).toMatchObject({ message: expect.stringMatching(/rollback .* is part way through; post the rollback again/) });
    expect(f.events).toEqual(['va:1', 'vb:1']);
    // A rollback post that fails part way returns what it moved, and the rollback still goes to 1.
    f.fail.add('vd:1');
    expect(await refusal(rollback())).toMatchObject({ message: expect.stringMatching(/stopped at vd/) });
    expect((await host.admin.storeDriverState(staff, 'graph')).rollbackTarget).toBe(sha('1'));
    f.fail.clear();
    let last;
    for (let i = 0; i < 4 && !(last = await rollback()).complete; i++);
    expect(last).toMatchObject({ complete: true, rollout: { sha256: sha('1'), state: 'good' } });
    expect(new Set(f.runs.values())).toEqual(new Set([sha('1')]));
  });

  it('refuses a rollout after a rollback continuation lost its hold, and the rollback still finishes on its target', async () => {
    for (const slug of ['vd', 've']) await declare(slug);
    const f = fleet();
    await run(f, sha('1'));
    await run(f, sha('2'));
    const rollback = async () =>
      runStoreDriverRollout({
        admin: host.admin, actor: staff, registration, sha256: (await host.admin.storeDriverState(staff, 'graph')).rollbackTarget!,
        action: 'rollback', ensure: f.ensure, ensureCanary: async () => ({ scriptName: 'c' }), callCanary: canaryStore().call, perRequest: 2,
      });
    expect((await rollback()).rollout.state).toBe('paused');
    // The next post loses its lease while moving vc: another holder takes the driver and lets it go.
    f.before.set('vc:1', async () => {
      clock.advance(ROLLOUT_HOLD_TTL_MS + 1);
      const other = ulid();
      expect(await host.admin.holdStoreDriver(staff, { driver: 'graph', holder: other, mode: 'exclusive', ttlMs: ROLLOUT_HOLD_TTL_MS })).toBe(true);
      await host.admin.releaseStoreDriverHold(staff, { driver: 'graph', holder: other });
    });
    expect(await refusal(rollback())).toMatchObject({ status: 409 });
    f.before.clear();
    expect((await host.admin.storeDriverState(staff, 'graph')).rollouts.at(-1)?.state).toBe('diverged');
    // The reviewer's sequence: a rollout of 3 now is refused, before its canary.
    const before = f.events.length;
    expect(await refusal(run(f, sha('3')))).toMatchObject({ message: expect.stringMatching(/is part way through; post the rollback again/) });
    expect(f.events.slice(before)).toEqual([]);
    expect((await host.admin.storeDriverState(staff, 'graph')).rollbackTarget).toBe(sha('1'));
    let last;
    for (let i = 0; i < 4 && !(last = await rollback()).complete; i++);
    expect(last).toMatchObject({ complete: true, rollout: { sha256: sha('1'), state: 'good' } });
    expect(new Set(f.runs.values())).toEqual(new Set([sha('1')]));
  });

  it('rolls a paused rollout back onto the current release', async () => {
    const f = fleet();
    await run(f, sha('1'));
    expect((await run(f, sha('2'), { perRequest: 2 })).rollout.state).toBe('paused');
    // Undoing the part-way rollout converges on 1, the release the fleet was on.
    expect((await host.admin.storeDriverState(staff, 'graph')).rollbackTarget).toBe(sha('1'));
  });

  it('returns the verticals earlier posts moved too, when a later post fails', async () => {
    const f = fleet();
    await run(f, sha('1'));
    f.events.length = 0;
    expect((await run(f, sha('2'), { perRequest: 2 })).complete).toBe(false);
    f.fail.add('vc:2');
    expect(await refusal(run(f, sha('2'), { perRequest: 2 }))).toMatchObject({ message: expect.stringMatching(/va, vb, vc returned to 1{64}/) });
    expect([...f.runs]).toEqual([['va', sha('1')], ['vb', sha('1')], ['vc', sha('1')]]);
    expect(await lastState()).toBe('failed');
  });

  it('pages a rollout past the walk cap: each vertical walked once, one declared between posts walked, one removed not (#2312)', async () => {
    for (const slug of ['vd', 've']) await declare(slug);
    const f = fleet();
    await run(f, sha('1'));
    f.walks.length = 0;
    expect(await run(f, sha('2'), { perRequestWalks: 2 })).toMatchObject({ complete: false, remaining: 3, moved: ['va', 'vb'], rollout: { state: 'paused' } });
    expect(await current()).toBe(sha('1'));
    // Between posts a vertical sorting before every one walked is pushed, at the release then
    // current, and vd is deleted.
    await declare('v0');
    f.runs.set('v0', sha('1'));
    await host.admin.deleteVertical(staff, 'vd');
    expect(await run(f, sha('2'), { perRequestWalks: 2 })).toMatchObject({ complete: false, remaining: 1, moved: ['v0', 'vc'], rollout: { state: 'paused' } });
    // While the last post walks, a push cannot take the driver, so it cannot add a script the list missed.
    f.before.set('ve:2', async () => {
      expect(await host.admin.holdStoreDriver(staff, { driver: 'graph', holder: ulid(), mode: 'shared', ttlMs: 1000 })).toBe(false);
    });
    expect(await run(f, sha('2'), { perRequestWalks: 2 })).toMatchObject({ complete: true, remaining: 0, moved: ['ve'], rollout: { state: 'good' } });
    expect(f.walks).toEqual(['va:2', 'vb:2', 'v0:2', 'vc:2', 've:2']);
    expect(await current()).toBe(sha('2'));
    expect(f.runs.get('v0')).toBe(sha('2'));
  });

  it('pages a rollback past the walk cap onto its target, each vertical walked once (#2312)', async () => {
    for (const slug of ['vd', 've']) await declare(slug);
    const f = fleet();
    await run(f, sha('1'));
    await run(f, sha('2'));
    f.walks.length = 0;
    const rollback = async () =>
      runStoreDriverRollout({
        admin: host.admin, actor: staff, registration, sha256: (await host.admin.storeDriverState(staff, 'graph')).rollbackTarget!,
        action: 'rollback', ensure: f.ensure, ensureCanary: async () => ({ scriptName: 'c' }), callCanary: canaryStore().call, perRequestWalks: 2,
      });
    expect(await rollback()).toMatchObject({ complete: false, remaining: 3, rollout: { sha256: sha('1'), state: 'paused' } });
    expect(await rollback()).toMatchObject({ complete: false, remaining: 1, rollout: { sha256: sha('1'), state: 'paused' } });
    expect((await host.admin.storeDriverState(staff, 'graph')).rollbackTarget).toBe(sha('1'));
    expect(await rollback()).toMatchObject({ complete: true, remaining: 0, rollout: { sha256: sha('1'), state: 'good' } });
    expect(f.walks).toEqual(['va:1', 'vb:1', 'vc:1', 'vd:1', 've:1']);
    expect(new Set(f.runs.values())).toEqual(new Set([sha('1')]));
  });

  it('rolls back to the previous good release after a re-post of the current one paused past the walk cap (#2312)', async () => {
    const f = fleet();
    await run(f, sha('1'));
    await run(f, sha('2'));
    f.walks.length = 0;
    // Re-posting the current release over a fleet bigger than one request walks: nothing moves,
    // and the request pauses.
    expect(await run(f, sha('2'), { perRequestWalks: 2 })).toMatchObject({ complete: false, moved: [], rollout: { state: 'paused' } });
    // The emergency rollback still escapes 2, onto 1, and never converges onto 2 first.
    expect((await host.admin.storeDriverState(staff, 'graph')).rollbackTarget).toBe(sha('1'));
    const rollback = () =>
      runStoreDriverRollout({
        admin: host.admin, actor: staff, registration, sha256: sha('1'), action: 'rollback', ensure: f.ensure,
        ensureCanary: async () => ({ scriptName: 'c' }), callCanary: canaryStore().call, perRequestWalks: 2,
      });
    expect(await rollback()).toMatchObject({ complete: false, moved: ['va', 'vb'] });
    expect(await rollback()).toMatchObject({ complete: true, moved: ['vc'], rollout: { state: 'good' } });
    expect(await current()).toBe(sha('1'));
    expect(f.walks).toEqual(['va:2', 'vb:2', 'va:1', 'vb:1', 'vc:1']);
  });

  it('walks again, never skips, the verticals a post uploaded before it could record them (#2312)', async () => {
    const f = fleet();
    await run(f, sha('1'));
    f.walks.length = 0;
    // The invocation ends after va's and vb's uploads, before the paused end records them.
    let crash = true;
    const crashing: typeof host.admin = {
      ...host.admin,
      finishStoreDriverRollout: async (actor, input) => {
        if (crash && input.state === 'paused') {
          crash = false;
          throw new Error('the invocation ended');
        }
        return host.admin.finishStoreDriverRollout(actor, input);
      },
    };
    expect(await refusal(run(f, sha('2'), { perRequestWalks: 2, admin: crashing }))).toMatchObject({ message: expect.stringMatching(/the invocation ended/) });
    expect(await lastState()).toBe('diverged');
    expect(await run(f, sha('2'), { perRequestWalks: 2 })).toMatchObject({ complete: false, moved: [] });
    expect(await run(f, sha('2'), { perRequestWalks: 2 })).toMatchObject({ complete: true, moved: ['vc'] });
    expect(f.walks).toEqual(['va:2', 'vb:2', 'va:2', 'vb:2', 'vc:2']);
    expect(await current()).toBe(sha('2'));
  });

  it('continues no attempt another rollout or rollback came between, so nothing it moved back is skipped (#2312)', async () => {
    const f = fleet();
    await run(f, sha('1'));
    expect(await run(f, sha('2'), { perRequestWalks: 2 })).toMatchObject({ moved: ['va', 'vb'], rollout: { state: 'paused' } });
    // Undoing it part way moves va and vb back to 1.
    const back = await runStoreDriverRollout({
      admin: host.admin, actor: staff, registration, sha256: sha('1'), action: 'rollback', ensure: f.ensure,
      ensureCanary: async () => ({ scriptName: 'c' }), callCanary: canaryStore().call, perRequestWalks: 2,
    });
    expect(back).toMatchObject({ moved: ['va', 'vb'], rollout: { state: 'paused' } });
    // Rolling 2 out again starts afresh: va and vb are on 1, and are moved again.
    expect(await run(f, sha('2'), { perRequestWalks: 2 })).toMatchObject({ moved: ['va', 'vb'], remaining: 1 });
    expect(await run(f, sha('2'), { perRequestWalks: 2 })).toMatchObject({ complete: true, moved: ['vc'] });
    expect(new Set(f.runs.values())).toEqual(new Set([sha('2')]));
  });

  it('ends diverged, returning nothing, when a failure comes after more verticals than one request returns (#2312)', async () => {
    const f = fleet();
    await run(f, sha('1'));
    f.events.length = 0;
    expect((await run(f, sha('2'), { perRequestWalks: 2 })).rollout.state).toBe('paused');
    f.fail.add('vc:2');
    expect(await refusal(run(f, sha('2'), { perRequestWalks: 2 }))).toMatchObject({
      message: expect.stringMatching(/stopped at vc.*reached 3 verticals, more than one request returns \(2\), so none was returned.*post a rollback/),
    });
    // Nothing was moved back.
    expect(f.events).toEqual(['canary:2', 'va:2', 'vb:2', 'canary:2', 'vc:2']);
    expect(await lastState()).toBe('diverged');
    // The rollback the refusal names converges every script on 1, paged.
    f.fail.clear();
    expect((await host.admin.storeDriverState(staff, 'graph')).rollbackTarget).toBe(sha('1'));
    const rollback = () =>
      runStoreDriverRollout({
        admin: host.admin, actor: staff, registration, sha256: sha('1'), action: 'rollback', ensure: f.ensure,
        ensureCanary: async () => ({ scriptName: 'c' }), callCanary: canaryStore().call, perRequestWalks: 2,
      });
    expect(await rollback()).toMatchObject({ complete: false });
    expect(await rollback()).toMatchObject({ complete: true, rollout: { state: 'good' } });
    expect(new Set(f.runs.values())).toEqual(new Set([sha('1')]));
  });

  it('lets one of two racing posts walk, refuses the other, and the ledger stays whole (#2312)', async () => {
    const f = fleet();
    await run(f, sha('1'));
    f.walks.length = 0;
    const [x, y] = await Promise.allSettled([run(f, sha('2'), { perRequestWalks: 2 }), run(f, sha('2'), { perRequestWalks: 2 })]);
    const won = [x, y].filter((r) => r.status === 'fulfilled');
    const lost = [x, y].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ status: 409, message: expect.stringMatching(/is being rolled out/) });
    expect((await host.admin.storeDriverState(staff, 'graph')).rollouts.filter((r) => r.sha256 === sha('2'))).toHaveLength(1);
    expect(await run(f, sha('2'), { perRequestWalks: 2 })).toMatchObject({ complete: true, moved: ['vc'] });
    expect(f.walks).toEqual(['va:2', 'vb:2', 'vc:2']);
  });

  it('refuses a rollout while a version cannot say which stores it declares', async () => {
    const id = ulid();
    await host.admin.registerVertical(staff, { slug: 'broken', name: 'broken', source: 'cli' });
    await host.admin.publishVersion(staff, {
      id,
      verticalSlug: 'broken',
      version: '1.0.0',
      manifestDigest: `m-${id}`,
      permissionDigest: 'p',
      migrationDigest: 'g',
      deploymentRef: null,
      manifestJson: '{nope',
    });
    const f = fleet();
    expect(await refusal(run(f, sha('1')))).toMatchObject({ status: 409, message: expect.stringMatching(/broken has a version whose stores cannot be named/) });
    expect(f.events).toEqual([]);
  });
});

describe('the release routes: a person stores and rolls out a pinned release (D-63)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const person = platformActorId.parse(ulid());
  const service = platformActorId.parse(ulid());
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
  const reviewed = (schema: number) => ({
    reason: 'Reviewed the release bundle and migration',
    sourceReferences: [{ repository: 'https://example.test/driver.git', commit: COMMIT }],
    isolationReview: {
      separateScriptPerTenant: { met: false, evidence: 'One script per vertical today' },
      noOutboundAccess: { met: false, evidence: 'Network access is not isolated yet' },
      envelopeVerifiedOutsideDriver: { met: true, evidence: 'Verifier is outside the bundle' },
      envelopeChecked: { checked: true, evidence: 'Read the envelope path' },
      reservedOperationsChecked: { checked: true, evidence: 'Read every reserved operation' },
      noModuleStateChecked: { checked: true, evidence: 'Read the modules' },
    },
    schema,
    className: 'Store',
    operations: [],
  });
  let shas: string[];
  let registration: StoreDriverRegistration;
  const bytes = new Map<string, Uint8Array>();
  const moves: string[] = [];
  const scripts = new Map<string, string | undefined>();
  const unreadableScripts = new Set<string>();
  /** Moves that fail, as `<vertical>:<release n>`. */
  const failMoves = new Set<string>();

  const appWith = (humanStaffActor?: (r: Request) => Promise<PlatformActorId | null>) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      storeDrivers: [registration],
      ...(humanStaffActor ? { humanStaffActor } : {}),
      // The fleet: each move loads the release through the API's own loader, so the stored bytes
      // are what is checked against the sha256 asked for.
      ensureScopeStores: async ({ vertical, to, loadRelease }) => {
        const release = await loadRelease({ driver: 'graph', vertical, ...(to ? { sha256: to } : {}) });
        if (!release || (await storeDriverReleaseDigest(release)) !== release.sha256) throw new Error('bytes are not the release');
        const move = `${vertical}:${shas.indexOf(release.sha256!) + 1}`;
        if (failMoves.has(move)) throw new Error(`upload of ${vertical} failed`);
        moves.push(move);
      },
      storeReleases: {
        bytes: storedBytes(bytes),
        ensureCanary: async ({ to }) => {
          scripts.set('substrat-store-graph--canary', to);
          return { scriptName: 'substrat-store-graph--canary' };
        },
        readScriptRelease: async (scriptName) => {
          if (unreadableScripts.has(scriptName)) throw new Error('settings unavailable');
          return scripts.has(scriptName) ? { exists: true, release: scripts.get(scriptName) } : { exists: false };
        },
        callCanary: canaryStore().call,
      },
    });
  const asPerson = async (r: Request) => (r.headers.get(DEV_ACTOR_HEADER) === person ? person : null);
  const call = (app: ReturnType<typeof createControlPlaneApi>, method: string, path: string, actor: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { [DEV_ACTOR_HEADER]: actor, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-store-routes-'));
    host = new SqliteScopeHost({ dir });
    bytes.clear();
    moves.length = 0;
    scripts.clear();
    unreadableScripts.clear();
    failMoves.clear();
    shas = [await storeDriverReleaseDigest(bundle(1)), await storeDriverReleaseDigest(bundle(2)), await storeDriverReleaseDigest(bundle(3))];
    registration = {
      driver: 'graph',
      // Three releases of different schema: 1 is schema 0, 2 and 3 are schema 1.
      releases: [
        { sha256: shas[0]!, sourceCommit: COMMIT, schema: 0 },
        { sha256: shas[1]!, sourceCommit: COMMIT, schema: 1 },
        { sha256: shas[2]!, sourceCommit: COMMIT, schema: 1 },
      ],
      className: 'Store',
      operations: [],
      platformOperations: [...RESERVED_STORE_OPERATIONS],
    };
    await host.admin.registerVertical(person, { slug: 'va', name: 'va', source: 'cli' });
    const id = ulid();
    await host.admin.publishVersion(person, {
      id,
      verticalSlug: 'va',
      version: '1.0.0',
      manifestDigest: `m-${id}`,
      permissionDigest: 'p',
      migrationDigest: 'g',
      deploymentRef: null,
      manifestJson: JSON.stringify({ scopeStores: [{ binding: 'GRAPH', driver: 'graph' }] }),
    });
  });
  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses every write by the service token, or with no human sign-in configured, and stores nothing', async () => {
    for (const app of [appWith(asPerson), appWith()]) {
      for (const [method, path, body] of [
        ['PUT', '/store-drivers/graph/releases', wire(bundle(1))],
        ['POST', '/store-drivers/graph/rollouts', { sha256: shas[0] }],
        ['POST', '/store-drivers/graph/rollback', undefined],
      ] as const) {
        const res = await call(app, method, path, service, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(await res.text()).toMatch(/published by a person/);
      }
    }
    // Nor does a person's sign-in that names someone else.
    const other = appWith(async () => person);
    expect((await call(other, 'PUT', '/store-drivers/graph/releases', service, wire(bundle(1)))).status).toBe(403);
    expect(bytes.size).toBe(0);
    expect(await host.admin.getStoreDriverRelease(person, 'graph', shas[0]!)).toBeUndefined();
    // Approval status is also person-only.
    expect((await call(appWith(asPerson), 'GET', '/store-drivers/graph', service)).status).toBe(403);
  });

  it('approves only stored bytes for a staff person, reports them, and preserves first facts on reapproval', async () => {
    const app = appWith(asPerson);
    const path = `/store-drivers/graph/releases/${shas[0]}/approvals`;
    const body = reviewed(0);
    expect((await call(app, 'POST', path, person, body)).status).toBe(404);
    expect((await call(app, 'POST', path, service, body)).status).toBe(403);
    expect((await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(1)))).status).toBe(201);
    expect((await call(app, 'POST', path, person, { ...body, isolationReview: {} })).status).toBe(422);
    expect((await call(app, 'POST', path, person, body, { origin: 'https://another.example' })).status).toBe(403);
    const first = await call(app, 'POST', path, person, body);
    expect(first.status, await first.clone().text()).toBe(201);
    expect(await first.json()).toMatchObject({ approval: { driver: 'graph', sha256: shas[0], sourceCommit: COMMIT, ...body }, currentSchema: null });
    expect((await call(app, 'POST', path, person, body)).status).toBe(409);
    const status = await call(app, 'GET', '/store-drivers/graph', person);
    expect((await status.json()).approvals).toMatchObject([{ driver: 'graph', sha256: shas[0], revokedAt: null }]);
    expect((await call(app, 'GET', '/store-drivers/graph', service)).status).toBe(403);
    expect((await call(app, 'POST', `/store-drivers/graph/releases/${shas[0]}/revoke`, service, { reason: 'Stop' })).status).toBe(403);
    const revoked = await call(app, 'POST', `/store-drivers/graph/releases/${shas[0]}/revoke`, person, { reason: 'Stop future uploads', emergency: true });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect(await revoked.json()).toMatchObject({ approval: { revokedBy: person, revokedReason: 'Stop future uploads', revokedEmergency: true }, complete: true, remaining: 0 });
    expect((await call(app, 'POST', path, person, { ...body, schema: 1 })).status).toBe(409);
    const again = await call(app, 'POST', path, person, body);
    expect(again.status, await again.clone().text()).toBe(201);
    const listed = await call(app, 'GET', '/store-drivers/graph', person);
    expect(((await listed.json()).approvals as unknown[]).length).toBe(2);
  });

  it('refuses approval when the stored release is missing or has a different digest', async () => {
    const app = appWith(asPerson);
    const release = shas[0]!;
    const path = `/store-drivers/graph/releases/${release}/approvals`;
    expect((await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(1)))).status).toBe(201);
    const saved = bytes.get(`graph/${release}`)!;
    bytes.delete(`graph/${release}`);
    expect((await call(app, 'POST', path, person, reviewed(0))).status).toBe(404);
    bytes.set(`graph/${release}`, new TextEncoder().encode(JSON.stringify(wire(bundle(2)))));
    expect((await call(app, 'POST', path, person, reviewed(0))).status).toBe(409);
    expect(await host.admin.storeDriverApprovals(person, 'graph')).toEqual([]);
    bytes.set(`graph/${release}`, saved);
    expect((await call(app, 'POST', path, person, reviewed(0))).status).toBe(201);
  });

  it('bounds the stored release before opening it for approval', async () => {
    const driver = 'graph';
    const sha256 = shas[0]!;
    await host.admin.recordStoreDriverRelease(person, { driver, sha256, sourceCommit: COMMIT });
    const raw = new TextEncoder().encode(JSON.stringify(wire(bundle(1))));
    const key = `${driver}/${sha256}`;
    const limit = Math.ceil((STORE_RELEASE_MAX_BYTES * 4) / 3) + 1024 * 1024;
    let object = new Uint8Array(limit + 1);
    let openedSize = raw.byteLength;
    const open = vi.fn(async () => ({ size: openedSize, body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(object); controller.close(); },
    }) }));
    const get = vi.fn(async () => object);
    let headSize = object.byteLength;
    const storedBytes = {
      get, put: async () => undefined,
      head: async (name: string) => name === key ? { size: headSize } : undefined,
      open,
    };
    const approve = () => approveStoredDriverRelease({ admin: host.admin, actor: person, bytes: storedBytes,
      driver, sha256, approval: reviewed(0) });
    expect(await refusal(approve())).toMatchObject({ status: 409 });
    expect(open).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    object = raw;
    headSize = raw.byteLength + 1;
    expect(await refusal(approve())).toMatchObject({ status: 409 });
    headSize = raw.byteLength - 1;
    openedSize = headSize;
    expect(await refusal(approve())).toMatchObject({ status: 409 });
    expect(await host.admin.storeDriverApprovals(person, driver)).toEqual([]);
  });

  it('validates repository and commit shapes in approval references', async () => {
    const app = appWith(asPerson);
    const release = shas[0]!;
    const path = `/store-drivers/graph/releases/${release}/approvals`;
    expect((await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(1)))).status).toBe(201);
    const body = reviewed(0);
    const missing = await call(app, 'POST', path, person, {});
    expect(missing.status).toBe(422);
    expect(await missing.text()).toMatch(/sourceReferences:/);
    const missingRevoke = await call(app, 'POST', `/store-drivers/graph/releases/${release}/revoke`, person, {});
    expect(missingRevoke.status).toBe(422);
    expect(await missingRevoke.text()).toMatch(/reason:/);
    const invalid = [
      { repository: 'x', commit: COMMIT },
      { repository: 'http://example.test/driver.git', commit: COMMIT },
      { repository: 'https://name@example.test/driver.git', commit: COMMIT },
      { repository: 'https://example.test/driver.git?view=1', commit: COMMIT },
      { repository: 'https://example.test/driver.git#readme', commit: COMMIT },
      { repository: 'https://example.test/', commit: COMMIT },
      { repository: 'https://example.test/driver\\branch', commit: COMMIT },
      { repository: 'https://example.test/driver git', commit: COMMIT },
      { repository: 'https://example.test/driver\u0085git', commit: COMMIT },
      { repository: 'https://example.test/driver\u202egit', commit: COMMIT },
      { repository: 'https://example.test/driver\u2066git', commit: COMMIT },
      { repository: 'https://example.test/driver\u2028git', commit: COMMIT },
      { repository: 'https://example.test/driver\ufeffgit', commit: COMMIT },
      { repository: `https://example.test/driver${'x'.repeat(1024)}`, commit: COMMIT },
      { repository: 'https://example.test/driver.git', commit: 'abc' },
      { repository: 'https://example.test/driver.git', commit: COMMIT.toUpperCase() },
      { repository: 'https://example.test/driver.git', commit: `${COMMIT.slice(0, -1)}\u0085` },
    ];
    for (const source of invalid) {
      expect((await call(app, 'POST', path, person, { ...body, sourceReferences: [source] })).status).toBe(422);
    }
    for (const field of ['reason', 'isolationReview'] as const) {
      const bad = field === 'reason'
        ? { ...body, reason: `Reviewed\u0085release` }
        : { ...body, isolationReview: { ...body.isolationReview, noModuleStateChecked: { checked: true, evidence: `Read\u202emodules` } } };
      expect((await call(app, 'POST', path, person, bad)).status).toBe(422);
    }
    expect((await call(app, 'POST', `/store-drivers/graph/releases/${release}/revoke`, person,
      { reason: 'Revoke\u2069release' })).status).toBe(422);
    expect(await host.admin.storeDriverApprovals(person, 'graph')).toEqual([]);
    const valid = { ...body, sourceReferences: [
      { repository: 'https://example.test/driver.git', commit: release },
      { repository: 'https://example.test/dependency', commit: COMMIT },
    ] };
    const approved = await call(app, 'POST', path, person, valid);
    expect(approved.status).toBe(201);
    expect(await approved.json()).toMatchObject({ approval: { sourceReferences: valid.sourceReferences } });
  });

  it('refuses a normal revoke while a script runs the release or its settings are unreadable', async () => {
    const app = appWith(asPerson);
    const release = shas[0]!;
    expect((await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(1)))).status).toBe(201);
    expect((await call(app, 'POST', `/store-drivers/graph/releases/${release}/approvals`, person, reviewed(0))).status).toBe(201);
    const revoke = (body: unknown = { reason: 'Review withdrawn' }) =>
      call(app, 'POST', `/store-drivers/graph/releases/${release}/revoke`, person, body);
    scripts.set('substrat-store-graph-va', release);
    const running = await revoke();
    expect(running.status).toBe(409);
    expect(await running.text()).toMatch(/still runs/);
    unreadableScripts.add('substrat-store-graph-va');
    expect((await revoke()).status).toBe(409);
    unreadableScripts.clear();
    scripts.set('substrat-store-graph-va', undefined);
    expect((await revoke()).status).toBe(409);
    scripts.set('substrat-store-graph-va', shas[1]);
    const done = await revoke();
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await done.json()).toMatchObject({ complete: true, approval: { revokedEmergency: false } });
  });

  it('guards the current release and returns a failed canary to the current good release', async () => {
    const app = appWith(asPerson);
    for (const n of [1, 2]) {
      expect((await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(n)))).status).toBe(201);
    }
    expect((await call(app, 'POST', '/store-drivers/graph/rollouts', person, { sha256: shas[1] })).status).toBe(200);
    const approved = await call(app, 'POST', `/store-drivers/graph/releases/${shas[0]}/approvals`, person, reviewed(0));
    expect(approved.status).toBe(201);
    expect(await approved.json()).toMatchObject({ currentSchema: 1 });
    expect((await call(app, 'POST', `/store-drivers/graph/releases/${shas[1]}/approvals`, person, reviewed(1))).status).toBe(201);
    const current = await call(app, 'POST', `/store-drivers/graph/releases/${shas[1]}/revoke`, person, { reason: 'Stop' });
    expect(current.status).toBe(409);
    expect(await current.text()).toMatch(/is current/);
    scripts.set('substrat-store-graph--canary', shas[0]);
    const back = await call(app, 'POST', `/store-drivers/graph/releases/${shas[0]}/revoke`, person, { reason: 'Stop' });
    expect(back.status, await back.clone().text()).toBe(200);
    expect(scripts.get('substrat-store-graph--canary')).toBe(shas[1]);
    const emergency = await call(app, 'POST', `/store-drivers/graph/releases/${shas[1]}/revoke`, person, { reason: 'Incident', emergency: true });
    expect(emergency.status, await emergency.clone().text()).toBe(200);
    expect(await emergency.json()).toMatchObject({ approval: { revokedEmergency: true } });
  });

  it('refuses a canary move when the current release has no live approval', async () => {
    const app = appWith(asPerson);
    for (const n of [1, 2]) {
      expect((await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(n)))).status).toBe(201);
      expect((await call(app, 'POST', `/store-drivers/graph/releases/${shas[n - 1]}/approvals`, person, reviewed(n - 1))).status).toBe(201);
    }
    expect((await call(app, 'POST', '/store-drivers/graph/rollouts', person, { sha256: shas[1] })).status).toBe(200);
    scripts.set('substrat-store-graph--canary', shas[0]);
    expect((await call(app, 'POST', `/store-drivers/graph/releases/${shas[1]}/revoke`, person, { reason: 'Withdraw', emergency: true })).status).toBe(200);
    const refused = await call(app, 'POST', `/store-drivers/graph/releases/${shas[0]}/revoke`, person, { reason: 'Withdraw' });
    expect(refused.status).toBe(409);
    expect(scripts.get('substrat-store-graph--canary')).toBe(shas[0]);
    expect(await host.admin.liveStoreDriverApproval(person, 'graph', shas[0]!)).toBeDefined();
  });

  it('pages the revoke walk and restarts when the person, reason or rollout sequence changes', async () => {
    const driver = 'graph';
    const sha256 = shas[0]!;
    await host.admin.recordStoreDriverRelease(person, { driver, sha256, sourceCommit: COMMIT });
    const approval = await host.admin.approveStoreDriverRelease(person, { driver, sha256, ...reviewed(0) });
    await host.admin.registerVertical(person, { slug: 'vb', name: 'vb', source: 'cli' });
    const id = ulid();
    await host.admin.publishVersion(person, {
      id, verticalSlug: 'vb', version: '1.0.0', manifestDigest: `m-${id}`, permissionDigest: 'p', migrationDigest: 'g',
      deploymentRef: null, manifestJson: JSON.stringify({ scopeStores: [{ binding: 'GRAPH', driver }] }),
    });
    const reads: string[] = [];
    const walk = (actor: PlatformActorId, reason: string) => runStoreDriverRevoke({
      admin: host.admin, actor, driver, sha256, reason, emergency: false, perRequestWalks: 1,
      readScriptRelease: async (name) => { reads.push(name); return { exists: false }; },
      ensureCanary: async () => undefined,
    });
    expect(await walk(person, 'first')).toMatchObject({ complete: false, remaining: 1 });
    expect(await host.admin.storeDriverRevokeWalk(person, approval.approvalId)).toMatchObject({ cursor: 'va', reason: 'first', rolloutSeq: 0 });
    const another = platformActorId.parse(ulid());
    expect(await walk(another, 'second')).toMatchObject({ complete: false, remaining: 1 });
    expect(await host.admin.storeDriverRevokeWalk(person, approval.approvalId)).toMatchObject({ cursor: 'va', actor: another, reason: 'second' });
    await host.admin.recordStoreDriverRelease(person, { driver, sha256: shas[1]!, sourceCommit: COMMIT });
    const holder = ulid();
    expect(await host.admin.holdStoreDriver(person, { driver, holder, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
    const row = await host.admin.beginStoreDriverRollout(person, { driver, sha256: shas[1]!, action: 'rollout', holder });
    await host.admin.finishStoreDriverRollout(person, { driver, seq: row.seq, holder, state: 'failed', detail: null });
    await host.admin.releaseStoreDriverHold(person, { driver, holder });
    expect(await walk(another, 'second')).toMatchObject({ complete: false, remaining: 1 });
    expect(await host.admin.storeDriverRevokeWalk(person, approval.approvalId)).toMatchObject({ cursor: 'va', rolloutSeq: row.seq });
    expect(await walk(another, 'second')).toMatchObject({ complete: true, remaining: 0, approval: { revokedAt: expect.any(String) } });
    expect(await host.admin.storeDriverRevokeWalk(person, approval.approvalId)).toBeUndefined();
    expect(reads).toEqual([
      'substrat-store-graph-va', 'substrat-store-graph-va', 'substrat-store-graph-va',
      'substrat-store-graph-vb', 'substrat-store-graph--canary',
    ]);
  });

  it('writes no revoke or cursor progress after the exclusive hold is lost', async () => {
    const driver = 'graph';
    const sha256 = shas[0]!;
    await host.admin.recordStoreDriverRelease(person, { driver, sha256, sourceCommit: COMMIT });
    const approval = await host.admin.approveStoreDriverRelease(person, { driver, sha256, ...reviewed(0) });
    const readScriptRelease = vi.fn(async () => ({ exists: false }));
    const admin = {
      ...host.admin,
      holdStoreDriver: async (...args: Parameters<typeof host.admin.holdStoreDriver>) =>
        args[1].renew ? false : host.admin.holdStoreDriver(...args),
    };
    const stopped = await refusal(runStoreDriverRevoke({
      admin, actor: person, driver, sha256, reason: 'Withdraw', emergency: false,
      readScriptRelease, ensureCanary: async () => undefined,
    }));
    expect(stopped).toMatchObject({ status: 409, message: expect.stringMatching(/hold.*lapsed/) });
    expect(readScriptRelease).not.toHaveBeenCalled();
    expect(await host.admin.liveStoreDriverApproval(person, driver, sha256)).toEqual(approval);
    expect(await host.admin.storeDriverRevokeWalk(person, approval.approvalId)).toBeUndefined();
  });

  it(`pages a rollout past ${ROLLOUT_WALKS_PER_REQUEST} verticals, and a refused caller between posts moves nothing (#2312)`, async () => {
    const fleetSize = ROLLOUT_WALKS_PER_REQUEST + 1;
    for (let i = 1; i < fleetSize; i++) {
      const slug = `vb${String(i).padStart(3, '0')}`;
      await host.admin.registerVertical(person, { slug, name: slug, source: 'cli' });
      const id = ulid();
      await host.admin.publishVersion(person, {
        id, verticalSlug: slug, version: '1.0.0', manifestDigest: `m-${id}`, permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null,
        manifestJson: JSON.stringify({ scopeStores: [{ binding: 'GRAPH', driver: 'graph' }] }),
      });
    }
    // A fleet that uploads only a script not on the release yet, as the real ensurer does.
    const at = new Map<string, string>();
    const walks: string[] = [];
    const app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      storeDrivers: [registration],
      humanStaffActor: asPerson,
      ensureScopeStores: async ({ vertical, to }) => {
        walks.push(vertical);
        if (at.get(vertical) === to) return { uploaded: 0 };
        at.set(vertical, to!);
        return { uploaded: 1 };
      },
      storeReleases: {
        bytes: storedBytes(bytes),
        ensureCanary: async () => ({ scriptName: 'substrat-store-graph--canary' }),
        callCanary: canaryStore().call,
      },
    });
    expect((await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(1)))).status).toBe(201);
    const post = async (actor: string) => {
      const res = await call(app, 'POST', '/store-drivers/graph/rollouts', actor, { sha256: shas[0] });
      return { status: res.status, body: (await res.json()) as { complete: boolean; remaining: number; moved: string[] } };
    };
    // Every script moves, 100 uploads a post.
    const remaining: number[] = [];
    for (let i = 0; i < 4; i++) {
      const { status, body } = await post(person);
      expect(status).toBe(body.complete ? 200 : 202);
      remaining.push(body.remaining);
      // A service token between posts is refused, and changes nothing the next post continues from.
      expect((await post(service)).status).toBe(403);
    }
    expect(remaining).toEqual([201, 101, 1, 0]);
    expect(at.size).toBe(fleetSize);
    expect(walks).toHaveLength(fleetSize);
    expect(new Set(walks).size).toBe(fleetSize);
    // Posted again with every script already there, a post walks at most the cap and pauses.
    walks.length = 0;
    expect(await post(person)).toMatchObject({ status: 202, body: { complete: false, remaining: 1, moved: [] } });
    expect(walks).toHaveLength(ROLLOUT_WALKS_PER_REQUEST);
    expect(await post(person)).toMatchObject({ status: 200, body: { complete: true, remaining: 0 } });
    expect(new Set(walks).size).toBe(fleetSize);
  });

  it('stores a bundle by its sha256, refuses one too big, malformed or for an unregistered driver', async () => {
    const app = appWith(asPerson);
    const res = await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(1)));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ release: { sha256: shas[0], sourceCommit: COMMIT, uploadedBy: person }, pinned: true });
    expect([...bytes.keys()]).toEqual([`graph/${shas[0]}`]);
    // The same bundle again is the same release.
    expect((await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(1)))).status).toBe(201);
    expect(bytes.size).toBe(1);
    // A bundle no pin names is stored too (bytes may go first), and says it is not pinned.
    const unpinned = await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(9)));
    expect(await unpinned.json()).toMatchObject({ pinned: false });

    expect((await call(app, 'PUT', '/store-drivers/nokind/releases', person, wire(bundle(1)))).status).toBe(403);
    const big = await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(1)), { 'content-length': String(3 * STORE_RELEASE_MAX_BYTES) });
    expect(big.status).toBe(413);
    const vendored = wire(bundle(1));
    vendored.modules.push({ name: 'six.py', contentBase64: btoa('x') });
    expect((await call(app, 'PUT', '/store-drivers/graph/releases', person, vendored)).status).toBe(422);
    expect((await call(app, 'PUT', '/store-drivers/graph/releases', person, { ...wire(bundle(1)), releaseId: 'x' })).status).toBe(422);
  });

  it('rolls out only a stored, pinned release, from the commit its pin names', async () => {
    const app = appWith(asPerson);
    expect((await call(app, 'POST', '/store-drivers/graph/rollouts', person, { sha256: shas[0] })).status).toBe(404);
    await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(9)));
    const notPinned = await call(app, 'POST', '/store-drivers/graph/rollouts', person, { sha256: await storeDriverReleaseDigest(bundle(9)) });
    expect(notPinned.status).toBe(422);
    expect(await notPinned.text()).toMatch(/not pinned/);
    // The same bytes from another commit are not the pinned release.
    await call(app, 'PUT', '/store-drivers/graph/releases', person, { ...wire(bundle(1)), sourceCommit: 'd'.repeat(40) });
    const otherCommit = await call(app, 'POST', '/store-drivers/graph/rollouts', person, { sha256: shas[0] });
    expect(otherCommit.status).toBe(422);
    expect(moves).toEqual([]);
  });

  it('rolls back to the immediately previous good release, and never below the stored schema', async () => {
    const app = appWith(asPerson);
    for (const n of [1, 2, 3]) {
      await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(n)));
      expect((await call(app, 'POST', '/store-drivers/graph/rollouts', person, { sha256: shas[n - 1] })).status).toBe(200);
    }
    expect(moves).toEqual(['va:1', 'va:2', 'va:3']);
    const back = await call(app, 'POST', '/store-drivers/graph/rollback', person);
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({ rollout: { action: 'rollback', sha256: shas[1], previousGoodSha256: shas[0] } });
    expect(moves.at(-1)).toBe('va:2');
    // 2 → 1 would lower the schema (1 to 0): refused, and nothing moves.
    const below = await call(app, 'POST', '/store-drivers/graph/rollback', person);
    expect(below.status).toBe(409);
    expect(await below.text()).toMatch(/schema 0, below the current release's 1/);
    // So is a rollout to it.
    expect((await call(app, 'POST', '/store-drivers/graph/rollouts', person, { sha256: shas[0] })).status).toBe(409);
    expect(moves.at(-1)).toBe('va:2');
    const view = await (await call(app, 'GET', '/store-drivers/graph', person)).json();
    expect(view.current).toMatchObject({ sha256: shas[1], previousGoodSha256: shas[0] });
    expect(view.rollouts.map((r: { action: string; state: string }) => `${r.action}:${r.state}`)).toEqual([
      'rollout:good',
      'rollout:good',
      'rollout:good',
      'rollback:good',
    ]);
  });

  it('rolls back after a diverged rollout onto the current release, never past it', async () => {
    const app = appWith(asPerson);
    // A second vertical, so a rollout can reach one and fail at the other.
    await host.admin.registerVertical(person, { slug: 'vb', name: 'vb', source: 'cli' });
    const id = ulid();
    await host.admin.publishVersion(person, {
      id, verticalSlug: 'vb', version: '1.0.0', manifestDigest: `m-${id}`, permissionDigest: 'p', migrationDigest: 'g',
      deploymentRef: null, manifestJson: JSON.stringify({ scopeStores: [{ binding: 'GRAPH', driver: 'graph' }] }),
    });
    for (const n of [1, 2, 3]) await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(n)));
    expect((await call(app, 'POST', '/store-drivers/graph/rollouts', person, { sha256: shas[1] })).status).toBe(200);
    // 2 and 3 are both schema 1, so this is not the schema rule: vb's upload of 3 fails, and so
    // does va's return to 2. The rollout ends diverged, va on 3 and vb on 2.
    failMoves.add('vb:3');
    failMoves.add('va:2');
    expect((await call(app, 'POST', '/store-drivers/graph/rollouts', person, { sha256: shas[2] })).status).toBe(502);
    const view = async () => (await call(app, 'GET', '/store-drivers/graph', person)).json();
    expect((await view()).rollouts.at(-1).state).toBe('diverged');
    // Undoing it goes back onto 2, the release the fleet was healthy on, not to 2's previous one.
    expect((await view()).rollbackTarget).toBe(shas[1]);
    failMoves.clear();
    moves.length = 0;
    const back = await call(app, 'POST', '/store-drivers/graph/rollback', person);
    expect(back.status, await back.clone().text()).toBe(200);
    expect(await back.json()).toMatchObject({ rollout: { action: 'rollback', sha256: shas[1], state: 'good' } });
    expect(moves).toEqual(['va:2', 'vb:2']);
    // The diverged attempt changed nothing about where a rollback from 2 goes: 2 was the first.
    expect((await view())).toMatchObject({ current: { sha256: shas[1], previousGoodSha256: null }, rollbackTarget: null });
  });

  it('takes a write as JSON only, and never from another origin', async () => {
    const app = appWith(asPerson);
    const write = (headers: Record<string, string>) =>
      app.request('/store-drivers/graph/rollback', { method: 'POST', headers: { [DEV_ACTOR_HEADER]: person, ...headers } });
    // A form or a beacon cannot set application/json without a preflight.
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      expect((await write({ 'content-type': type })).status, type).toBe(415);
    }
    expect((await write({})).status).toBe(415);
    const json = { 'content-type': 'application/json' };
    expect((await write({ ...json, origin: 'https://evil.example' })).status).toBe(403);
    expect((await write({ ...json, 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await write({ ...json, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    // The twins: the CLI sends neither header; the console is the same origin. Both reach the
    // route, which answers that there is nothing to roll back to.
    expect((await write(json)).status).toBe(409);
    expect((await write({ ...json, origin: 'http://localhost', 'sec-fetch-site': 'same-origin' })).status).toBe(409);
    // The upload is held to the same rule.
    const put = await app.request('/store-drivers/graph/releases', { method: 'PUT', headers: { [DEV_ACTOR_HEADER]: person, 'content-type': 'text/plain' }, body: JSON.stringify(wire(bundle(1))) });
    expect(put.status).toBe(415);
    expect(bytes.size).toBe(0);
  });

  it('refuses a body that streams past the cap, and a bundle whose modules decode past 10 MiB', async () => {
    const app = appWith(asPerson);
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 20) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const streamed = await app.request(
      new Request('http://localhost/store-drivers/graph/releases', {
        method: 'PUT',
        headers: { [DEV_ACTOR_HEADER]: person, 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    // Under the request cap as base64, over the module cap once decoded.
    const big = { ...wire(bundle(1)), modules: [{ name: 'driver_graph/store.py', contentBase64: btoa(' '.repeat(STORE_RELEASE_MAX_BYTES + 3)) }] };
    const decoded = await call(app, 'PUT', '/store-drivers/graph/releases', person, big);
    expect(decoded.status).toBe(413);
    expect(await decoded.text()).toMatch(/at most 10485760 module bytes/);
    expect(bytes.size).toBe(0);
  });

  it('holds a paused rollback whose target lost its pin until a control plane with the pin is deployed', async () => {
    const app = appWith(asPerson);
    for (const n of [1, 2, 3]) await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(n)));
    for (const n of [2, 3]) expect((await call(app, 'POST', '/store-drivers/graph/rollouts', person, { sha256: shas[n - 1] })).status).toBe(200);
    // A rollback to 2 that paused part way (written directly: one batch here is 100 verticals).
    const holder = ulid();
    expect(await host.admin.holdStoreDriver(person, { driver: 'graph', holder, mode: 'exclusive', ttlMs: 60_000 })).toBe(true);
    const row = await host.admin.beginStoreDriverRollout(person, { driver: 'graph', sha256: shas[1]!, action: 'rollback', holder });
    await host.admin.finishStoreDriverRollout(person, { driver: 'graph', seq: row.seq, holder, state: 'paused', detail: null });
    await host.admin.releaseStoreDriverHold(person, { driver: 'graph', holder });
    // A control plane whose registration no longer pins 2 (a pin is never removed, but say one was).
    const pinned = registration;
    registration = { ...pinned, releases: pinned.releases.filter((p) => p.sha256 !== shas[1]) };
    const unpinned = appWith(asPerson);
    const back = await call(unpinned, 'POST', '/store-drivers/graph/rollback', person);
    expect(back.status).toBe(422);
    expect(await back.text()).toMatch(/not pinned/);
    const forward = await call(unpinned, 'POST', '/store-drivers/graph/rollouts', person, { sha256: shas[2] });
    expect(forward.status).toBe(409);
    expect(await forward.text()).toMatch(/is part way through; post the rollback again/);
    // The way out: deploy a control plane that pins it again. Then the rollback finishes.
    registration = pinned;
    const repinned = await call(appWith(asPerson), 'POST', '/store-drivers/graph/rollback', person);
    expect(repinned.status, await repinned.clone().text()).toBe(200);
    expect(await repinned.json()).toMatchObject({ rollout: { action: 'rollback', sha256: shas[1], state: 'good' } });
  });

  it('answers 501 when this control plane keeps no releases', async () => {
    const app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth(), storeDrivers: [registration], humanStaffActor: asPerson });
    expect((await call(app, 'PUT', '/store-drivers/graph/releases', person, wire(bundle(1)))).status).toBe(501);
  });
});

describe('the real ensurer holds every move to the schema a script runs (#2300)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const person = platformActorId.parse(ulid());
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
  /** Cloudflare as the ensurer reaches it: each script's bindings, and PUTs that may fail. */
  const scripts = new Map<string, { name: string; text?: string }[]>();
  const failPut = new Set<string>();
  const release = (script: string) => scripts.get(script)?.find((b) => b.name === STORE_RELEASE_VAR)?.text;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-store-schema-'));
    host = new SqliteScopeHost({ dir });
    scripts.clear();
    failPut.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: FormData }) => {
        const script = decodeURIComponent(url.split('/scripts/')[1]!.split('/')[0]!);
        if (url.endsWith('/settings')) {
          const bindings = scripts.get(script);
          return bindings ? Response.json({ result: { bindings } }) : new Response('{}', { status: 404 });
        }
        if (failPut.has(script)) return new Response('{}', { status: 500 });
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

  it('refuses to undo a diverged schema raise by re-posting the lower release', async () => {
    const [s1, s2] = [await storeDriverReleaseDigest(bundle(1)), await storeDriverReleaseDigest(bundle(2))];
    const registration: StoreDriverRegistration = {
      driver: 'graph',
      releases: [
        { sha256: s1, sourceCommit: COMMIT, schema: 0 },
        { sha256: s2, sourceCommit: COMMIT, schema: 1 },
      ],
      className: 'Store',
      operations: [],
      platformOperations: [...RESERVED_STORE_OPERATIONS],
    };
    for (const slug of ['va', 'vb']) {
      await host.admin.registerVertical(person, { slug, name: slug, source: 'cli' });
      const id = ulid();
      await host.admin.publishVersion(person, {
        id, verticalSlug: slug, version: '1.0.0', manifestDigest: `m-${id}`, permissionDigest: 'p', migrationDigest: 'g',
        deploymentRef: null, manifestJson: JSON.stringify({ scopeStores: [{ binding: 'GRAPH', driver: 'graph' }] }),
      });
    }
    const keys = { caller: (await generateScopeStoreKeyPair()).publicKey, platform: (await generateScopeStoreKeyPair()).publicKey };
    const ensurerOptions = { accountId: 'a', namespace: 'n', apiToken: 't', callerPublicKeys: [keys.caller], platformPublicKeys: [keys.platform], drivers: [registration] };
    const bytes = new Map<string, Uint8Array>();
    const app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      storeDrivers: [registration],
      humanStaffActor: async () => person,
      ensureScopeStores: ({ loadRelease, ...input }) => createScopeStoreEnsurer({ ...ensurerOptions, loadRelease })(input),
      storeReleases: {
        bytes: storedBytes(bytes),
        ensureCanary: ({ loadRelease, ...input }) => createStoreCanaryEnsurer({ ...ensurerOptions, loadRelease })(input),
        callCanary: canaryStore().call,
      },
    });
    const call = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { [DEV_ACTOR_HEADER]: person, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    for (const n of [1, 2]) expect((await call('PUT', '/store-drivers/graph/releases', wire(bundle(n)))).status).toBe(201);
    expect((await call('POST', '/store-drivers/graph/rollouts', { sha256: s1 })).status).toBe(200);
    // 1 → 2 raises the schema; vb's upload fails, va has moved and cannot go back: diverged.
    failPut.add('substrat-store-graph-vb');
    expect((await call('POST', '/store-drivers/graph/rollouts', { sha256: s2 })).status).toBe(502);
    expect(release('substrat-store-graph-va')).toBe(s2);
    failPut.clear();
    // A push of either vertical meanwhile rebuilds its script at the release it runs: va stays on
    // 2, vb on 1. The schema rule refuses moves, and a push makes none.
    const push = createScopeStoreEnsurer({ ...ensurerOptions, loadRelease: storedReleaseLoader({ admin: host.admin, actor: person, bytes: storedBytes(bytes) }) });
    for (const vertical of ['va', 'vb']) await push({ vertical, stores: [{ binding: 'GRAPH', driver: 'graph' }] });
    expect([release('substrat-store-graph-va'), release('substrat-store-graph-vb')]).toEqual([s2, s1]);
    // Re-posting the current release would move va from schema 1 back to 0: the ensurer refuses.
    const back = await call('POST', '/store-drivers/graph/rollouts', { sha256: s1 });
    expect(back.status).toBe(409);
    expect(await back.text()).toMatch(/runs schema 1; release .* has schema 0.*converge it forward: post that rollout again/);
    expect(release('substrat-store-graph-va')).toBe(s2);
    // A rollback, which now converges on the current release, meets the same rule.
    expect((await call('POST', '/store-drivers/graph/rollback')).status).toBe(409);
    expect(release('substrat-store-graph-va')).toBe(s2);
    // The way forward is forward: rolling out 2 again converges both.
    expect((await call('POST', '/store-drivers/graph/rollouts', { sha256: s2 })).status).toBe(200);
    expect([release('substrat-store-graph-va'), release('substrat-store-graph-vb')]).toEqual([s2, s2]);
  });
});

describe('a Python release may carry python_modules (#2390)', () => {
  const commit = 'b'.repeat(40);
  const b64 = (text: string) => btoa(text);
  const body = (modules: { name: string; contentBase64: string }[], entry = 'driver_graph/store.py') => ({
    sourceCommit: commit,
    entry,
    modules,
  });
  const py = (name: string) => ({ name, contentBase64: b64('class Store: pass\n') });

  it('accepts a vendored .py, a data file and a nested package', () => {
    const decoded = decodeStoreDriverRelease(
      body([
        py('driver_graph/store.py'),
        py('python_modules/six.py'),
        { name: 'python_modules/vendor_probe/payload.txt', contentBase64: b64('payload-ok') },
        py('python_modules/vendor_probe/nested/mod.py'),
      ]),
    );
    expect(decoded.modules.map((m) => m.name)).toEqual([
      'driver_graph/store.py',
      'python_modules/six.py',
      'python_modules/vendor_probe/payload.txt',
      'python_modules/vendor_probe/nested/mod.py',
    ]);
  });

  it.each([
    ['workers', 'python_modules/workers/__init__.py'],
    ['js', 'python_modules/js/ffi.py'],
    ['pyodide', 'python_modules/pyodide/ffi.py'],
    ['a driver_ prefix', 'python_modules/driver_other/x.py'],
    ['a substrat_ prefix', 'python_modules/substrat_store/x.py'],
    ['a climb', 'python_modules/../x.py'],
    ['a backslash', 'python_modules\\six.py'],
    ['an absolute path', '/python_modules/six.py'],
    ['a path file', 'python_modules/pkg/extra.pth'],
    ['pyvenv.cfg', 'python_modules/pyvenv.cfg'],
    ['a sync marker', 'python_modules/pkg/marker.synced'],
    // The CLI skips these two where pywrangler writes them; the upload refuses them all the same.
    ["the installer's sync marker", 'python_modules/.synced'],
    ['the runtime SDK', 'python_modules/_workers_sdk_patch_loader.py'],
  ])('refuses %s', (_label, name) => {
    expect(() => decodeStoreDriverRelease(body([py('driver_graph/store.py'), py(name)]))).toThrow(ControlPlaneError);
    try {
      decodeStoreDriverRelease(body([py('driver_graph/store.py'), py(name)]));
    } catch (e) {
      expect(e).toMatchObject({ status: 422, message: expect.stringMatching(/may not ship/) });
    }
  });

  it('refuses a duplicate and a release over the module cap; the byte cap stays 10 MiB', () => {
    expect(() => decodeStoreDriverRelease(body([py('driver_graph/store.py'), py('driver_graph/store.py')]))).toThrow(/twice/);
    const modules = [py('driver_graph/store.py')];
    for (let i = 0; i < STORE_RELEASE_MAX_MODULES; i++) modules.push(py(`python_modules/m${i}.py`));
    try {
      decodeStoreDriverRelease(body(modules));
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ status: 422, message: expect.stringMatching(/not a store driver release/) });
    }
    expect(STORE_RELEASE_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});
