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
  STORE_RELEASE_MAX_BYTES,
  storeKindReleaseDigest,
  type PlatformActorId,
  type ReservedStoreOperation,
  type StoreKindRegistration,
} from '@substrat-run/contracts';
import {
  canaryStoreRelease,
  createControlPlaneApi,
  createScopeStoreEnsurer,
  createStoreCanaryEnsurer,
  STORE_RELEASE_VAR,
  DEV_ACTOR_HEADER,
  ROLLOUT_FLEET_MAX,
  ROLLOUT_HOLD_TTL_MS,
  runStoreKindRollout,
  UNSAFE_devPlatformActorAuth,
  type CanaryCall,
} from '../src/index.js';

/**
 * A store kind's release flow (D-63, #2300): the canary on the platform's own object, the rollout
 * across every vertical that declared the kind, where a failure returns to, and the routes that
 * admit a person and refuse the service token. The scripts are a fake fleet that records which
 * release each one runs; the directory is the real pure host.
 */

/**
 * A refusal as a plain `{ status, message }`. Matched against an Error, `toMatchObject` skips the
 * non-enumerable `message`, so a message pattern there would assert nothing. A promise that
 * resolves fails here.
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
  const fail = new Set<string>();
  /** Uploads that land, then answer an error. */
  const landed = new Set<string>();
  /** Runs before an upload, by key: a test lets time pass or another holder in there. */
  const before = new Map<string, () => Promise<void>>();
  return {
    runs,
    events,
    fail,
    landed,
    before,
    /** Uploads unless the script already runs `to`, as the real ensurer does, and says which. */
    ensure: async ({ vertical, to }: { vertical: string; to: string }) => {
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

describe('a rollout canaries, then moves every vertical that declared the kind, and returns on failure', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const registration: StoreKindRegistration = {
    kind: 'graph',
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
    for (const s of ['1', '2', '3']) await host.admin.recordStoreKindRelease(staff, { kind: 'graph', sha256: sha(s), sourceCommit: COMMIT });
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
      manifestJson: JSON.stringify({ scopeStores: [{ binding: 'GRAPH', kind: 'graph' }] }),
    });
  };
  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (f: ReturnType<typeof fleet>, sha256: string, extra: { canaryFails?: boolean; perRequest?: number } = {}) =>
    runStoreKindRollout({
      admin: host.admin,
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
    });
  let clock: ManualClock;
  const current = async () => (await host.admin.storeKindState(staff, 'graph')).current?.sha256;
  const lastState = async () => (await host.admin.storeKindState(staff, 'graph')).rollouts.at(-1)?.state;

  it('canaries first, then moves each vertical, and makes the release current', async () => {
    const f = fleet();
    const result = await run(f, sha('1'));
    expect(f.events).toEqual(['canary:1', 'va:1', 'vb:1', 'vc:1']);
    expect(result).toMatchObject({ complete: true, moved: ['va', 'vb', 'vc'], rollout: { state: 'good' } });
    expect(await current()).toBe(sha('1'));
    // The hold is released: a push may hold the kind again.
    expect(await host.admin.holdStoreKind(staff, { kind: 'graph', holder: ulid(), mode: 'shared', ttlMs: 1000 })).toBe(true);
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
      runStoreKindRollout({
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

  it('stops at once, returning nothing, when its hold lapsed and another holder took the kind', async () => {
    const f = fleet();
    await run(f, sha('1'));
    f.events.length = 0;
    const other = ulid();
    // During vb's upload the lease runs out and another rollout takes the kind.
    f.before.set('vb:2', async () => {
      clock.advance(ROLLOUT_HOLD_TTL_MS + 1);
      expect(await host.admin.holdStoreKind(staff, { kind: 'graph', holder: other, mode: 'exclusive', ttlMs: ROLLOUT_HOLD_TTL_MS })).toBe(true);
    });
    expect(await refusal(run(f, sha('2')))).toMatchObject({ status: 409, message: expect.stringMatching(/lapsed or its rollout was ended by another.*Nothing was returned/) });
    // vc was never moved, and va and vb were not moved back under the other holder.
    expect(f.events).toEqual(['canary:2', 'va:2', 'vb:2']);
    // The stopped rollout reads as diverged, though nothing could write that.
    expect(await lastState()).toBe('diverged');
    await host.admin.releaseStoreKindHold(staff, { kind: 'graph', holder: other });
  });

  it('does not take the kind back after its lease lapsed, even once the other holder is gone', async () => {
    const f = fleet();
    await run(f, sha('1'));
    f.events.length = 0;
    const other = ulid();
    // The lease runs out; another holder takes the kind, finishes, and lets it go again.
    f.before.set('vb:2', async () => {
      clock.advance(ROLLOUT_HOLD_TTL_MS + 1);
      expect(await host.admin.holdStoreKind(staff, { kind: 'graph', holder: other, mode: 'exclusive', ttlMs: ROLLOUT_HOLD_TTL_MS })).toBe(true);
      const row = await host.admin.beginStoreKindRollout(staff, { kind: 'graph', sha256: sha('1'), action: 'rollout', holder: other });
      await host.admin.finishStoreKindRollout(staff, { kind: 'graph', seq: row.seq, holder: other, state: 'good', detail: null });
      await host.admin.releaseStoreKindHold(staff, { kind: 'graph', holder: other });
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
      await host.admin.holdStoreKind(staff, { kind: 'graph', holder: other, mode: 'exclusive', ttlMs: ROLLOUT_HOLD_TTL_MS });
    });
    expect(await refusal(run(f, sha('2')))).toMatchObject({ message: expect.stringMatching(/hold was lost while returning; vb, vc may run/) });
    // va went back; vb was not touched once the hold was gone.
    expect(f.events).toEqual(['canary:2', 'va:2', 'vb:2', 'vc:2', 'va:1']);
    await host.admin.releaseStoreKindHold(staff, { kind: 'graph', holder: other });
  });

  it('refuses while another holder holds the kind, and begins nothing', async () => {
    const f = fleet();
    const push = ulid();
    expect(await host.admin.holdStoreKind(staff, { kind: 'graph', holder: push, mode: 'shared', ttlMs: 60_000 })).toBe(true);
    expect(await refusal(run(f, sha('1')))).toMatchObject({ status: 409, message: expect.stringMatching(/being rolled out or a vertical declaring it is being pushed/) });
    expect(f.events).toEqual([]);
    expect((await host.admin.storeKindState(staff, 'graph')).rollouts).toEqual([]);
  });

  it('moves a fleet bigger than one request over several posts, each continuing where the last stopped', async () => {
    for (const slug of ['vd', 've']) await declare(slug);
    const f = fleet();
    const first = await run(f, sha('1'), { perRequest: 2 });
    expect(first).toMatchObject({ complete: false, moved: ['va', 'vb'], rollout: { state: 'diverged' } });
    expect(await current()).toBeUndefined();
    const second = await run(f, sha('1'), { perRequest: 2 });
    expect(second).toMatchObject({ complete: false, moved: ['vc', 'vd'] });
    const third = await run(f, sha('1'), { perRequest: 2 });
    expect(third).toMatchObject({ complete: true, moved: ['ve'], rollout: { state: 'good' } });
    expect(await current()).toBe(sha('1'));
    // Each script was uploaded once, after one canary per post.
    expect(f.events).toEqual(['canary:1', 'va:1', 'vb:1', 'canary:1', 'vc:1', 'vd:1', 'canary:1', 've:1']);
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

  it('refuses a fleet bigger than one request can walk', async () => {
    const big = { ...host.admin, storeKindDeclarations: async () => ({ verticals: Array.from({ length: ROLLOUT_FLEET_MAX + 1 }, (_, i) => ({ vertical: `v${i}`, stores: [] })), unreadable: [] }) };
    const f = fleet();
    expect(await refusal(runStoreKindRollout({ admin: big, actor: staff, registration, sha256: sha('1'), action: 'rollout', ensure: f.ensure, ensureCanary: async () => ({ scriptName: 'c' }), callCanary: canaryStore().call })))
      .toMatchObject({ status: 409, message: expect.stringMatching(/at most 300 per request/) });
    expect(f.events).toEqual([]);
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
    entry: 'kind_graph/store.py',
    modules: [{ name: 'kind_graph/store.py', content: text(`class Store:\n    v = ${n}\n`) }],
  });
  const wire = (b: ReturnType<typeof bundle>) => ({
    sourceCommit: b.sourceCommit,
    entry: b.entry,
    modules: b.modules.map((m) => ({ name: m.name, contentBase64: btoa(String.fromCharCode(...m.content)) })),
  });
  let shas: string[];
  let registration: StoreKindRegistration;
  const bytes = new Map<string, Uint8Array>();
  const moves: string[] = [];
  /** Moves that fail, as `<vertical>:<release n>`. */
  const failMoves = new Set<string>();

  const appWith = (humanStaffActor?: (r: Request) => Promise<PlatformActorId | null>) =>
    createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      storeKinds: [registration],
      ...(humanStaffActor ? { humanStaffActor } : {}),
      // The fleet: each move loads the release through the API's own loader, so the stored bytes
      // are what is checked against the sha256 asked for.
      ensureScopeStores: async ({ vertical, to, loadRelease }) => {
        const release = await loadRelease({ kind: 'graph', vertical, ...(to ? { sha256: to } : {}) });
        if (!release || (await storeKindReleaseDigest(release)) !== release.sha256) throw new Error('bytes are not the release');
        const move = `${vertical}:${shas.indexOf(release.sha256!) + 1}`;
        if (failMoves.has(move)) throw new Error(`upload of ${vertical} failed`);
        moves.push(move);
      },
      storeReleases: {
        bytes: { get: async (k) => bytes.get(k), put: async (k, b) => void bytes.set(k, b) },
        ensureCanary: async () => ({ scriptName: 'substrat-store-graph--canary' }),
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
    failMoves.clear();
    shas = [await storeKindReleaseDigest(bundle(1)), await storeKindReleaseDigest(bundle(2)), await storeKindReleaseDigest(bundle(3))];
    registration = {
      kind: 'graph',
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
      manifestJson: JSON.stringify({ scopeStores: [{ binding: 'GRAPH', kind: 'graph' }] }),
    });
  });
  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses every write by the service token, or with no human sign-in configured, and stores nothing', async () => {
    for (const app of [appWith(asPerson), appWith()]) {
      for (const [method, path, body] of [
        ['PUT', '/store-kinds/graph/releases', wire(bundle(1))],
        ['POST', '/store-kinds/graph/rollouts', { sha256: shas[0] }],
        ['POST', '/store-kinds/graph/rollback', undefined],
      ] as const) {
        const res = await call(app, method, path, service, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(await res.text()).toMatch(/published by a person/);
      }
    }
    // Nor does a person's sign-in that names someone else.
    const other = appWith(async () => person);
    expect((await call(other, 'PUT', '/store-kinds/graph/releases', service, wire(bundle(1)))).status).toBe(403);
    expect(bytes.size).toBe(0);
    expect(await host.admin.getStoreKindRelease(person, 'graph', shas[0]!)).toBeUndefined();
    // Reading the state is any staff's.
    expect((await call(appWith(asPerson), 'GET', '/store-kinds/graph', service)).status).toBe(200);
  });

  it('stores a bundle by its sha256, refuses one too big, malformed or for an unregistered kind', async () => {
    const app = appWith(asPerson);
    const res = await call(app, 'PUT', '/store-kinds/graph/releases', person, wire(bundle(1)));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ release: { sha256: shas[0], sourceCommit: COMMIT, uploadedBy: person }, pinned: true });
    expect([...bytes.keys()]).toEqual([`graph/${shas[0]}`]);
    // The same bundle again is the same release.
    expect((await call(app, 'PUT', '/store-kinds/graph/releases', person, wire(bundle(1)))).status).toBe(201);
    expect(bytes.size).toBe(1);
    // A bundle no pin names is stored too (bytes may go first), and says it is not pinned.
    const unpinned = await call(app, 'PUT', '/store-kinds/graph/releases', person, wire(bundle(9)));
    expect(await unpinned.json()).toMatchObject({ pinned: false });

    expect((await call(app, 'PUT', '/store-kinds/nokind/releases', person, wire(bundle(1)))).status).toBe(403);
    const big = await call(app, 'PUT', '/store-kinds/graph/releases', person, wire(bundle(1)), { 'content-length': String(3 * STORE_RELEASE_MAX_BYTES) });
    expect(big.status).toBe(413);
    const vendored = wire(bundle(1));
    vendored.modules.push({ name: 'six.py', contentBase64: btoa('x') });
    expect((await call(app, 'PUT', '/store-kinds/graph/releases', person, vendored)).status).toBe(422);
    expect((await call(app, 'PUT', '/store-kinds/graph/releases', person, { ...wire(bundle(1)), releaseId: 'x' })).status).toBe(422);
  });

  it('rolls out only a stored, pinned release, from the commit its pin names', async () => {
    const app = appWith(asPerson);
    expect((await call(app, 'POST', '/store-kinds/graph/rollouts', person, { sha256: shas[0] })).status).toBe(404);
    await call(app, 'PUT', '/store-kinds/graph/releases', person, wire(bundle(9)));
    const notPinned = await call(app, 'POST', '/store-kinds/graph/rollouts', person, { sha256: await storeKindReleaseDigest(bundle(9)) });
    expect(notPinned.status).toBe(422);
    expect(await notPinned.text()).toMatch(/not pinned/);
    // The same bytes from another commit are not the pinned release.
    await call(app, 'PUT', '/store-kinds/graph/releases', person, { ...wire(bundle(1)), sourceCommit: 'd'.repeat(40) });
    const otherCommit = await call(app, 'POST', '/store-kinds/graph/rollouts', person, { sha256: shas[0] });
    expect(otherCommit.status).toBe(422);
    expect(moves).toEqual([]);
  });

  it('rolls back to the immediately previous good release, and never below the stored schema', async () => {
    const app = appWith(asPerson);
    for (const n of [1, 2, 3]) {
      await call(app, 'PUT', '/store-kinds/graph/releases', person, wire(bundle(n)));
      expect((await call(app, 'POST', '/store-kinds/graph/rollouts', person, { sha256: shas[n - 1] })).status).toBe(200);
    }
    expect(moves).toEqual(['va:1', 'va:2', 'va:3']);
    const back = await call(app, 'POST', '/store-kinds/graph/rollback', person);
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({ rollout: { action: 'rollback', sha256: shas[1], previousGoodSha256: shas[0] } });
    expect(moves.at(-1)).toBe('va:2');
    // 2 → 1 would lower the schema (1 to 0): refused, and nothing moves.
    const below = await call(app, 'POST', '/store-kinds/graph/rollback', person);
    expect(below.status).toBe(409);
    expect(await below.text()).toMatch(/schema 0, below the current release's 1/);
    // So is a rollout to it.
    expect((await call(app, 'POST', '/store-kinds/graph/rollouts', person, { sha256: shas[0] })).status).toBe(409);
    expect(moves.at(-1)).toBe('va:2');
    const view = await (await call(app, 'GET', '/store-kinds/graph', service)).json();
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
      deploymentRef: null, manifestJson: JSON.stringify({ scopeStores: [{ binding: 'GRAPH', kind: 'graph' }] }),
    });
    for (const n of [1, 2, 3]) await call(app, 'PUT', '/store-kinds/graph/releases', person, wire(bundle(n)));
    expect((await call(app, 'POST', '/store-kinds/graph/rollouts', person, { sha256: shas[1] })).status).toBe(200);
    // 2 and 3 are both schema 1, so this is not the schema rule: vb's upload of 3 fails, and so
    // does va's return to 2. The rollout ends diverged, va on 3 and vb on 2.
    failMoves.add('vb:3');
    failMoves.add('va:2');
    expect((await call(app, 'POST', '/store-kinds/graph/rollouts', person, { sha256: shas[2] })).status).toBe(502);
    const view = async () => (await call(app, 'GET', '/store-kinds/graph', service)).json();
    expect((await view()).rollouts.at(-1).state).toBe('diverged');
    // Undoing it goes back onto 2, the release the fleet was healthy on, not to 2's previous one.
    expect((await view()).rollbackTarget).toBe(shas[1]);
    failMoves.clear();
    moves.length = 0;
    const back = await call(app, 'POST', '/store-kinds/graph/rollback', person);
    expect(back.status, await back.clone().text()).toBe(200);
    expect(await back.json()).toMatchObject({ rollout: { action: 'rollback', sha256: shas[1], state: 'good' } });
    expect(moves).toEqual(['va:2', 'vb:2']);
    // The diverged attempt changed nothing about where a rollback from 2 goes: 2 was the first.
    expect((await view())).toMatchObject({ current: { sha256: shas[1], previousGoodSha256: null }, rollbackTarget: null });
  });

  it('takes a write as JSON only, and never from another origin', async () => {
    const app = appWith(asPerson);
    const write = (headers: Record<string, string>) =>
      app.request('/store-kinds/graph/rollback', { method: 'POST', headers: { [DEV_ACTOR_HEADER]: person, ...headers } });
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
    const put = await app.request('/store-kinds/graph/releases', { method: 'PUT', headers: { [DEV_ACTOR_HEADER]: person, 'content-type': 'text/plain' }, body: JSON.stringify(wire(bundle(1))) });
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
      new Request('http://localhost/store-kinds/graph/releases', {
        method: 'PUT',
        headers: { [DEV_ACTOR_HEADER]: person, 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    // Under the request cap as base64, over the module cap once decoded.
    const big = { ...wire(bundle(1)), modules: [{ name: 'kind_graph/store.py', contentBase64: btoa(' '.repeat(STORE_RELEASE_MAX_BYTES + 3)) }] };
    const decoded = await call(app, 'PUT', '/store-kinds/graph/releases', person, big);
    expect(decoded.status).toBe(413);
    expect(await decoded.text()).toMatch(/at most 10485760 module bytes/);
    expect(bytes.size).toBe(0);
  });

  it('answers 501 when this control plane keeps no releases', async () => {
    const app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth(), storeKinds: [registration], humanStaffActor: asPerson });
    expect((await call(app, 'PUT', '/store-kinds/graph/releases', person, wire(bundle(1)))).status).toBe(501);
  });
});

describe('the real ensurer holds every move to the schema a script runs (#2300)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const person = platformActorId.parse(ulid());
  const text = (s: string) => new TextEncoder().encode(s);
  const bundle = (n: number) => ({
    sourceCommit: COMMIT,
    entry: 'kind_graph/store.py',
    modules: [{ name: 'kind_graph/store.py', content: text(`class Store:\n    v = ${n}\n`) }],
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
    const [s1, s2] = [await storeKindReleaseDigest(bundle(1)), await storeKindReleaseDigest(bundle(2))];
    const registration: StoreKindRegistration = {
      kind: 'graph',
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
        deploymentRef: null, manifestJson: JSON.stringify({ scopeStores: [{ binding: 'GRAPH', kind: 'graph' }] }),
      });
    }
    const keys = { caller: (await generateScopeStoreKeyPair()).publicKey, platform: (await generateScopeStoreKeyPair()).publicKey };
    const ensurerOptions = { accountId: 'a', namespace: 'n', apiToken: 't', callerPublicKeys: [keys.caller], platformPublicKeys: [keys.platform], kinds: [registration] };
    const bytes = new Map<string, Uint8Array>();
    const app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      storeKinds: [registration],
      humanStaffActor: async () => person,
      ensureScopeStores: ({ loadRelease, ...input }) => createScopeStoreEnsurer({ ...ensurerOptions, loadRelease })(input),
      storeReleases: {
        bytes: { get: async (k) => bytes.get(k), put: async (k, b) => void bytes.set(k, b) },
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
    for (const n of [1, 2]) expect((await call('PUT', '/store-kinds/graph/releases', wire(bundle(n)))).status).toBe(201);
    expect((await call('POST', '/store-kinds/graph/rollouts', { sha256: s1 })).status).toBe(200);
    // 1 → 2 raises the schema; vb's upload fails, va has moved and cannot go back: diverged.
    failPut.add('substrat-store-graph-vb');
    expect((await call('POST', '/store-kinds/graph/rollouts', { sha256: s2 })).status).toBe(502);
    expect(release('substrat-store-graph-va')).toBe(s2);
    failPut.clear();
    // Re-posting the current release would move va from schema 1 back to 0: the ensurer refuses.
    const back = await call('POST', '/store-kinds/graph/rollouts', { sha256: s1 });
    expect(back.status).toBe(409);
    expect(await back.text()).toMatch(/runs schema 1; release .* has schema 0/);
    expect(release('substrat-store-graph-va')).toBe(s2);
    // A rollback, which now converges on the current release, meets the same rule.
    expect((await call('POST', '/store-kinds/graph/rollback')).status).toBe(409);
    expect(release('substrat-store-graph-va')).toBe(s2);
    // The way forward is forward: rolling out 2 again converges both.
    expect((await call('POST', '/store-kinds/graph/rollouts', { sha256: s2 })).status).toBe(200);
    expect([release('substrat-store-graph-va'), release('substrat-store-graph-vb')]).toEqual([s2, s2]);
  });
});
