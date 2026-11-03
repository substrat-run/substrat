import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scopeStoreObjectName, scopeStoreScriptName } from '@substrat-run/contracts';
import { generateScopeStoreKeyPair, issueScopeStoreEnvelope } from '@substrat-run/contracts/scope-store-envelope';
import { platformScopeStoresFor } from '@substrat-run/control-plane-api';
import { handleStoreCall } from '../../router/src/store-calls.js';
import { callThroughFence, storeObjectFence } from '../../../packages/control-plane-api/store-entry/fence.js';
import { STORE_FENCE_KEY } from '../../../packages/control-plane-api/store-entry/names.js';
import { verifiedStoreCall } from '../../../packages/control-plane-api/store-entry/verify.js';

/**
 * The door fence (D-70), between the real signers and the real verifier and fence, with only the
 * object's storage and the driver faked. A caller call goes through `handleStoreCall`, a deletion
 * through `platformScopeStoresFor`, and both arrive at `verifiedStoreCall` and `callThroughFence`,
 * as they do in the entry. The workerd half, on real storage, is `store-entry.workerd.test.ts`.
 *
 * The driver awaits between reading and writing, and between wiping and answering, as a driver that
 * makes a subrequest does, since a Durable Object's input gate opens then. So a call can sit in the
 * driver, on the wire, or in storage while anything else runs. A crash loses the instance and what
 * it held in memory, and keeps what storage had.
 */

const TENANT = '01JTESTATTACHTENANT000000A';
const SCOPE = '01J00000000000000000000S01';
const SCRIPT = scopeStoreScriptName('docs', 'counter');
const NAME = scopeStoreObjectName(TENANT, 'docs', SCOPE, 'GRAPH');
const callerIdentity = { vertical: 'docs', tenantId: TENANT, scopeId: SCOPE, stores: [{ binding: 'GRAPH', driver: 'counter' }] };
const callOf = (operation: string) => ({ scopeId: SCOPE, binding: 'GRAPH', operation });
const target = { vertical: 'docs', driver: 'counter', tenantId: TENANT, scopeId: SCOPE, binding: 'GRAPH' };

/** Holds whoever awaits `pause` until the test or the schedule lets them go. */
class Gates {
  readonly held: { label: string; go: () => void }[] = [];
  pause(label: string): Promise<void> {
    return new Promise((resolve) => this.held.push({ label, go: resolve }));
  }
  /** Let the first gate of that label go, once it is held. */
  async release(label: string): Promise<void> {
    await waitFor(() => this.held.some((g) => g.label === label));
    this.held.splice(this.held.findIndex((g) => g.label === label), 1)[0]!.go();
  }
}

/** One store object: storage that survives a crash, an instance that does not. */
class FakeObject {
  readonly storage = new Map<string, unknown>();
  /** Bumped by a crash: whatever an older instance still tries fails, as a dead isolate's calls do. */
  instance = 0;
  /** Whether the driver awaits between its steps. Off for the direct tests that do not care. */
  gates: Gates | undefined;
  /** Rows a caller or a commit wrote, read by the assertions. */
  rows: string[] = [];
  wipes = 0;
  fenceDelivered = false;
  fence = this.#newFence(30_000);
  drainMs = 30_000;

  #newFence(drainMs: number) {
    const born = this.instance;
    const alive = () => {
      if (this.instance !== born) throw new Error('the instance is gone');
    };
    return storeObjectFence(
      {
        get: async (key) => {
          await this.gates?.pause('storage');
          alive();
          return this.storage.get(key);
        },
        put: async (key, value) => {
          await this.gates?.pause('storage');
          alive();
          this.storage.set(key, value);
        },
      },
      drainMs,
    );
  }

  crash(): void {
    this.instance += 1;
    this.fence = this.#newFence(this.drainMs);
  }

  useDrainMs(ms: number): void {
    this.drainMs = ms;
    this.fence = this.#newFence(ms);
  }

  get marked(): boolean {
    return this.storage.has(STORE_FENCE_KEY);
  }

  /** The driver. A call that outlives its instance fails where it would next touch anything. */
  async #driver(body: ArrayBuffer, born: number): Promise<Response> {
    const { operation } = JSON.parse(new TextDecoder().decode(body)) as { operation: string };
    const alive = () => {
      if (this.instance !== born) throw new Error('the instance is gone');
    };
    if (operation === 'substrat.wipe') {
      this.wipes += 1;
      await this.gates?.pause('driver');
      alive();
      // As the graph driver does: everything, the tombstone with it.
      this.rows = [];
      this.storage.clear();
      await this.gates?.pause('driver');
      alive();
      return Response.json({ result: {} });
    }
    if (operation === 'substrat.size') return Response.json({ result: { bytes: this.rows.length } });
    await this.gates?.pause('driver');
    alive();
    if (operation === 'substrat.commit-stage') {
      this.rows.push('commit');
      return Response.json({ result: { tables: 1 } });
    }
    if (operation === 'substrat.stage-page') return Response.json({ result: { staged: true } });
    this.rows.push(operation);
    return Response.json({ result: this.rows.length });
  }

  /** `SubstratStoreObject.fetch`, past its object-id check. */
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    const born = this.instance;
    const fence = this.fence;
    const call = await verifiedStoreCall(request, env);
    if (!call.ok) return new Response(call.message, { status: call.status });
    if (call.envelope.op === 'substrat.fence') this.fenceDelivered = true;
    const answer = await callThroughFence(fence, call, (body) => this.#driver(body, born));
    return answer instanceof Response
      ? answer
      : new Response(answer.message, { status: answer.status, ...(answer.contentType ? { headers: { 'content-type': answer.contentType } } : {}) });
  }
}

const caller = await generateScopeStoreKeyPair();
const platform = await generateScopeStoreKeyPair();
const entryEnv = {
  SUBSTRAT_STORE_SCRIPT: SCRIPT,
  SUBSTRAT_STORE_CALLER_KEYS: caller.publicKey,
  SUBSTRAT_STORE_PLATFORM_KEYS: platform.publicKey,
};

/** The real signers in front of one fake object. A `wire` gate holds a call after it was signed. */
function world(object: FakeObject, gates?: Gates) {
  const deliver = async (request: Request) => {
    await gates?.pause('wire');
    return object.fetch(request, entryEnv);
  };
  const dispatch = { get: (script: string) => ({ fetch: (request: Request) => (script === SCRIPT ? deliver(request) : Promise.reject(new Error('wrong script'))) }) };
  const callerCall = (operation: string) => handleStoreCall({ STORE_CALLER_KEY: caller.privateKey, DISPATCH: dispatch }, callerIdentity, callOf(operation));
  const stores = platformScopeStoresFor({
    platformKey: platform.privateKey,
    fetch: (_script, request) => object.fetch(request, entryEnv),
    retryDelaysMs: [0, 0, 0],
  });
  const fence = () => stores.fenceStores({ tenantId: TENANT, scopeId: SCOPE, vertical: 'docs', stores: [{ binding: 'GRAPH', driver: 'counter' }] });
  const platformCall = (op: string, input: unknown) => stores.callStore(target)(op as 'substrat.commit-stage', input);
  return { callerCall, fence, platformCall };
}

// A call that dies with its instance is what the router logs here, once per call: expected.
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return () => vi.restoreAllMocks();
});

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('a random interleaving of caller calls, a fence and a crash (D-70)', () => {
  /**
   * Run a schedule: at each step either start the next action or let a random held gate go. An action
   * is a caller write, a commit, the fence, or a crash. What holds for any schedule:
   * - once the fence has answered, the object holds no row and carries the mark, so nothing a caller
   *   sent, however it was timed, landed after the wipe;
   * - a call is refused only once the fence has reached the object, so a live scope refuses nobody;
   * - every call that went unrefused and unfailed was answered by the driver.
   */
  async function run(seed: number, withFence: boolean): Promise<void> {
    const random = mulberry32(seed);
    const gates = new Gates();
    const object = new FakeObject();
    object.gates = gates;
    const { callerCall, fence, platformCall } = world(object, gates);
    const actions: (() => Promise<unknown>)[] = [];
    const answers: { status: number; refused: boolean; afterFence: boolean }[] = [];
    let fenced = false;
    const write = () => async () => {
      const outcome = await callerCall('increment');
      const status = outcome.status;
      answers.push({ status, refused: status === 410, afterFence: object.fenceDelivered });
    };
    for (let i = 0; i < 6; i++) actions.push(write());
    actions.push(() => platformCall('substrat.commit-stage', { stageId: 'stage' }).catch(() => undefined));
    if (withFence) actions.push(async () => {
      await fence();
      fenced = true;
    });
    if (random() < 0.5) actions.push(async () => object.crash());
    // A shuffle, so the crash and the fence fall anywhere among the writes.
    for (let i = actions.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [actions[i], actions[j]] = [actions[j]!, actions[i]!];
    }
    const running: Promise<unknown>[] = [];
    let open = 0;
    const start = (action: () => Promise<unknown>) => {
      open += 1;
      running.push(action().finally(() => { open -= 1; }));
    };
    while (actions.length > 0 || open > 0 || gates.held.length > 0) {
      if (actions.length > 0 && (gates.held.length === 0 || random() < 0.25)) start(actions.shift()!);
      else if (gates.held.length > 0) gates.held.splice(Math.floor(random() * gates.held.length), 1)[0]!.go();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(running);

    for (const answer of answers) {
      if (answer.refused) expect(answer.afterFence, `seed ${seed}: refused before any fence`).toBe(true);
    }
    if (!withFence) {
      expect(answers.filter((a) => a.refused), `seed ${seed}`).toEqual([]);
      expect(object.marked).toBe(false);
      return;
    }
    expect(fenced, `seed ${seed}: the fence did not answer`).toBe(true);
    expect(object.rows, `seed ${seed}: a write landed after the wipe`).toEqual([]);
    expect(object.marked, `seed ${seed}: the mark is gone`).toBe(true);
    // And a late straggler, whatever was signed when: refused.
    object.gates = undefined;
    const late = await world(object).callerCall('increment');
    expect(late.status, `seed ${seed}`).toBe(410);
    expect(object.rows).toEqual([]);
  }

  // Each run signs and verifies about twenty calls, so 40 of them stay under a second or two of crypto.
  it('no caller write lands after the wipe, and a live scope refuses nobody', { timeout: 15_000 }, async () => {
    for (let seed = 1; seed <= 40; seed++) await run(seed, true);
    for (let seed = 1; seed <= 10; seed++) await run(seed, false);
  });
});

describe('the door fence, call by call (D-70)', () => {
  it('a call signed before the fence and delivered after the wipe is refused, and the driver never sees it', async () => {
    const gates = new Gates();
    const object = new FakeObject();
    const { callerCall, fence } = world(object, gates);
    const late = callerCall('increment');
    await waitFor(() => gates.held.some((g) => g.label === 'wire'));
    await fence();
    expect(object.wipes).toBe(1);
    await gates.release('wire');
    expect(await late).toMatchObject({ ok: true, status: 410, body: { error: { code: 'store_fenced', status: 410 } } });
    expect(object.rows).toEqual([]);
    expect(object.wipes).toBe(1);
  });

  it('a call inside the driver when the fence arrives is waited out, so its write goes with the wipe', async () => {
    const gates = new Gates();
    const object = new FakeObject();
    object.gates = gates;
    const { callerCall, fence } = world(object);
    const inside = callerCall('increment');
    await releaseUntil(gates, 'storage', () => gates.held.some((g) => g.label === 'driver'));
    const fencing = fence();
    await releaseUntil(gates, 'storage', () => object.marked);
    await settle();
    expect(object.wipes).toBe(0);
    await gates.release('driver'); // The call writes, and only then may the wipe run.
    await drain(gates, Promise.all([inside, fencing]));
    expect(await inside).toMatchObject({ ok: true, status: 200 });
    expect(object.rows).toEqual([]);
    expect(object.wipes).toBe(1);
    expect(object.marked).toBe(true);
  });

  it('a call that outlasts the wait fails the fence with 503, the mark stays, and the retry finishes it', async () => {
    const gates = new Gates();
    const object = new FakeObject();
    object.gates = gates;
    object.useDrainMs(5);
    const { callerCall, fence } = world(object);
    const inside = callerCall('increment');
    await releaseUntil(gates, 'storage', () => gates.held.some((g) => g.label === 'driver'));
    let answer: unknown;
    const fencing = fence().then(() => { answer = 'fenced'; }, (e: { status?: number }) => { answer = e.status; });
    // Each of its tries writes the mark and waits, and none of them gets to wipe.
    await releaseUntil(gates, 'storage', () => answer !== undefined);
    await fencing;
    expect(answer).toBe(503);
    expect(object.wipes).toBe(0);
    expect(object.marked).toBe(true);
    await drain(gates, inside);
    object.gates = undefined;
    await fence();
    expect(object.wipes).toBe(1);
    expect(object.rows).toEqual([]);
  });

  it('a crash between the wipe and the second mark is what the retry is for: it wipes what landed in the gap', async () => {
    const gates = new Gates();
    const object = new FakeObject();
    object.gates = gates;
    const { fence, callerCall } = world(object);
    const fencing = fence();
    await releaseUntil(gates, 'storage', () => object.marked);
    await gates.release('driver');
    await waitFor(() => !object.marked && gates.held.some((g) => g.label === 'driver'));
    object.crash();
    object.gates = undefined;
    // The new instance finds no mark, so a stale call gets through. The fence has not answered.
    expect((await callerCall('increment')).status).toBe(200);
    expect(object.rows).toEqual(['increment']);
    await drain(gates, fencing);
    expect(object.rows).toEqual([]);
    expect(object.marked).toBe(true);
    expect((await callerCall('increment')).status).toBe(410);
  });

  it('a fenced object lets the platform read, erase and wipe and refuses what writes; the mark outlives an eviction', async () => {
    const object = new FakeObject();
    const { fence, platformCall, callerCall } = world(object);
    await fence();
    object.crash();
    expect(await platformCall('substrat.size', undefined)).toEqual({ bytes: 0 });
    await expect(platformCall('substrat.stage-page', { stageId: 'late', seq: 0, tables: [] })).rejects.toMatchObject({ status: 410 });
    await expect(platformCall('substrat.commit-stage', { stageId: 'late' })).rejects.toMatchObject({ status: 410 });
    // A plain wipe, as a control plane from before the fence sends, leaves it fenced.
    await platformCall('substrat.wipe', undefined);
    expect(object.marked).toBe(true);
    expect((await callerCall('increment')).status).toBe(410);
    expect(object.rows).toEqual([]);
  });

  it('an alarm does not reach the driver once the object is fenced', async () => {
    const object = new FakeObject();
    expect(await object.fence.admitAlarm()).toBe(true);
    await object.fence.leave();
    await world(object).fence();
    expect(await object.fence.admitAlarm()).toBe(false);
  });

  it('a plain wipe fences nothing: a restore after it writes, and a caller call goes on', async () => {
    const object = new FakeObject();
    const { platformCall, callerCall } = world(object);
    expect((await callerCall('increment')).status).toBe(200);
    await platformCall('substrat.wipe', undefined);
    expect(object.marked).toBe(false);
    expect(await platformCall('substrat.stage-page', { stageId: 'restore', seq: 0, tables: [] })).toEqual({ staged: true });
    expect(await platformCall('substrat.commit-stage', { stageId: 'restore' })).toEqual({ tables: 1 });
    expect(object.rows).toEqual(['commit']);
    expect((await callerCall('increment')).status).toBe(200);
  });

  it('a restore that commits before the fence is wiped by it, and one that commits after is refused', async () => {
    const object = new FakeObject();
    const { fence, platformCall } = world(object);
    await platformCall('substrat.commit-stage', { stageId: 'early' });
    await fence();
    expect(object.rows).toEqual([]);
    await expect(platformCall('substrat.commit-stage', { stageId: 'late' })).rejects.toMatchObject({ status: 410 });
    expect(object.rows).toEqual([]);
  });

  it('the driver gets the fence as the wipe it answers, and the name never reaches it', async () => {
    const object = new FakeObject();
    const seen: string[] = [];
    const inner = object.fetch.bind(object);
    object.fetch = async (request, env) => {
      seen.push((await request.clone().json() as { operation: string }).operation);
      return inner(request, env);
    };
    await world(object).fence();
    expect(seen).toEqual(['substrat.fence']);
    expect(object.wipes).toBe(1);
  });

  it('a caller signature does not open the fence', async () => {
    const object = new FakeObject();
    object.rows.push('kept');
    const body = JSON.stringify({ operation: 'substrat.fence', objectName: NAME });
    await expect(issueScopeStoreEnvelope({ privateKey: caller.privateKey, aud: 'caller', script: SCRIPT, name: NAME, op: 'substrat.fence', body })).rejects.toThrow();
    expect(await handleStoreCall({ STORE_CALLER_KEY: caller.privateKey, DISPATCH: { get: () => ({ fetch: async () => { throw new Error('not dispatched'); } }) } }, callerIdentity, callOf('substrat.fence')))
      .toMatchObject({ ok: false, status: 403 });
    expect(object.rows).toEqual(['kept']);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(condition()).toBe(true);
}

/** Let gates of that label go, as they come, until `until` holds. */
async function releaseUntil(gates: Gates, label: string, until: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!until() && Date.now() < deadline) {
    const at = gates.held.findIndex((g) => g.label === label);
    if (at >= 0) gates.held.splice(at, 1)[0]!.go();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(until()).toBe(true);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Let every gate go until `until` is done. */
async function drain(gates: Gates, until: Promise<unknown>): Promise<void> {
  let done = false;
  void until.finally(() => { done = true; });
  while (!done) {
    for (const held of gates.held.splice(0)) held.go();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await until;
}
