/**
 * Kill mid-write: no acknowledged write is lost, and none is applied twice (#1638 Q2).
 *
 * Two shards, three routers, one scope whose home is `todo-0`. Router-1 is patient (a long
 * per-attempt timeout), the others give up on a shard after 1.5 s. Every step is pinned by a
 * fault the shard fires on itself at an exact point, so no sleep decides the order:
 *
 *   1. writes through every router, so all three cache `todo-0`;
 *   2. `todo-0` FREEZES (SIGSTOP) after admitting w4 and before applying it — a pod whose
 *      node stopped answering, not one that died. Patient router-1 keeps waiting on it;
 *   3. router-0 times out on `todo-0` and fails over: `todo-1` takes the scope once the frozen
 *      holder's lease has run out, and w5, w6 land there;
 *   4. `todo-0` wakes and tries to commit w4 to its own files. `todo-1` stamped a newer epoch
 *      into them before copying, so the commit aborts at the fence trigger (the storage-side
 *      fence) and w4 never lands there. Router-1, still waiting, gets a refusal and retries;
 *   5. router-2 never saw any of this and sends w7 to `todo-0` — the pre-invocation check
 *      (a renewal the control plane refuses) is what turns it away;
 *   6. `todo-1` is SIGKILLed after committing w8 and before answering it. Router-0 retries it
 *      under its idempotency key wherever the scope is served next, while the StatefulSet's
 *      part brings `todo-1` back under the same name and volume;
 *   7. every acknowledged write must be in the scope exactly once, read through each router.
 *
 * A SIGKILL alone cannot fail this on one machine — a dead process writes nothing, and the
 * retry is recognised by its key. What fails is step 2's survivor: a holder that is not dead.
 * The second test runs the same steps with the lease switched off, and must lose writes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ulid } from '@substrat-run/kernel';
import { home } from '../src/placement.js';
import { Cluster } from './cluster.js';

let cluster: Cluster | undefined;
afterEach(async () => {
  await cluster?.stop();
  cluster = undefined;
});

function scopeHomedOn(node: string, members: readonly string[]): string {
  for (;;) {
    const id = ulid();
    if (home(id, members) === node) return id;
  }
}

interface Run {
  acked: string[];
  /** Which shard acknowledged each write, at which epoch. */
  by: Record<string, { node: unknown; epoch: unknown }>;
  reads: string[][];
  /** What the woken holder's OWN files hold after it finished w4 — served by nobody, read off its volume. */
  zombieFiles: string[] | null;
  /** How long the frozen-holder write and the killed-holder write took to be acknowledged. */
  failoverMs: { frozen: number; killed: number };
}

async function freezeFailoverKill(c: Cluster): Promise<Run> {
  const scope = scopeHomedOn('todo-0', c.members);
  await c.provision(scope);
  const acked: string[] = [];
  const by: Run['by'] = {};
  const write = async (router: string, text: string) => {
    const r = await c.write(router, scope, text);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    acked.push(text);
    by[text] = { node: r.json.node, epoch: r.json.epoch };
    return r.json;
  };

  // 1. Every router learns `todo-0`.
  for (const [router, text] of [['router-0', 'w0'], ['router-1', 'w1'], ['router-2', 'w2'], ['router-0', 'w3']]) {
    expect((await write(router!, text!)).node).toBe('todo-0');
  }

  // 2. `todo-0` freezes mid-write; patient router-1 waits on it.
  c.arm('todo-0', { text: 'w4', point: 'pre-write', signal: 'SIGSTOP' });
  const w4 = write('router-1', 'w4');
  await c.reached('todo-0', 'w4');

  // 3. Router-0 fails over to `todo-1`.
  const frozenAt = Date.now();
  await write('router-0', 'w5');
  const frozen = Date.now() - frozenAt;
  await write('router-0', 'w6');

  // 4. `todo-0` wakes and finishes w4 — on a copy nobody serves any more.
  c.signal('todo-0', 'SIGCONT');
  await w4;
  const zombieFiles = c.itemsOnVolume('todo-0', scope);

  // 5. Router-2 still believes `todo-0` holds the scope.
  await write('router-2', 'w7');

  // 6. `todo-1` dies after committing w8 and before answering it.
  c.arm('todo-1', { text: 'w8', point: 'post-commit', signal: 'SIGKILL' });
  const killedAt = Date.now();
  const w8 = write('router-0', 'w8');
  await c.reached('todo-1', 'w8');
  await c.restart('todo-1');
  await w8;
  const killed = Date.now() - killedAt;

  // 7. Read back through every router.
  const reads: string[][] = [];
  for (const router of ['router-0', 'router-1', 'router-2']) reads.push((await c.read(router, scope)).texts);
  return { acked, by, reads, zombieFiles, failoverMs: { frozen, killed } };
}

function tally(texts: string[]): Record<string, number> {
  const n: Record<string, number> = {};
  for (const t of texts) n[t] = (n[t] ?? 0) + 1;
  return n;
}

function damage(run: Run): Array<{ lost: string[]; doubled: string[] }> {
  return run.reads.map((texts) => {
    const n = tally(texts);
    return {
      lost: run.acked.filter((t) => (n[t] ?? 0) === 0),
      doubled: run.acked.filter((t) => (n[t] ?? 0) > 1),
    };
  });
}

/** Router-1 is the patient one: it is still waiting when the frozen holder wakes. */
const ROUTERS = [1500, 20_000, 1500];
const CLEAN = { lost: [], doubled: [] };

describe('kill mid-write', () => {
  it('loses no acknowledged write and applies none twice', async () => {
    cluster = await new Cluster({ shards: 2, routerTimeoutsMs: ROUTERS }).start();
    const run = await freezeFailoverKill(cluster);
    expect(damage(run)).toEqual([CLEAN, CLEAN, CLEAN]);
    expect(run.reads[1]).toEqual(run.reads[0]);
    expect(run.reads[2]).toEqual(run.reads[0]);
    expect(run.reads[0]).toHaveLength(run.acked.length);
    // `todo-1` was granted the scope only after the frozen holder's lease ran out (epoch 2).
    expect(run.by.w5).toEqual({ node: 'todo-1', epoch: 2 });
    // The woken holder's w4 was refused AT COMMIT by its own files: `todo-1` stamped epoch 2
    // into them before copying, so the zombie's transaction aborted at the fence trigger and
    // w4 is not in them at all. Router-1 retried it on `todo-1`.
    expect(run.zombieFiles).toEqual(['w0', 'w1', 'w2', 'w3']);
    expect(run.by.w4).toEqual({ node: 'todo-1', epoch: 2 });
    // Router-2 was turned away from the woken holder rather than served by it.
    expect(run.by.w7).toEqual({ node: 'todo-1', epoch: 2 });
    // The killed holder's write was answered under a third epoch, by whoever took it next.
    expect(run.by.w8?.epoch).toBe(3);
    console.log(`failover after a frozen holder: ${run.failoverMs.frozen} ms; after a killed one: ${run.failoverMs.killed} ms`);
  });

  // The control: the same cluster with the lease switched off (routing plus a placement
  // table, `LEASES=off`). It must LOSE writes; if it ever stops doing so, this test no
  // longer shows what the lease is for, and the one above proves nothing.
  it('without the lease, the woken holder keeps acknowledging on a stale copy (control)', async () => {
    cluster = await new Cluster({ shards: 2, routerTimeoutsMs: ROUTERS, leases: 'off' }).start();
    const run = await freezeFailoverKill(cluster);
    // The woken holder acknowledged both: w4 for patient router-1, w7 for stale router-2.
    expect(run.by.w4?.node).toBe('todo-0');
    expect(run.by.w7?.node).toBe('todo-0');
    // With no fence, the woken holder's commit landed in its own files.
    expect(run.zombieFiles).toContain('w4');
    // w6 went to `todo-1` alone, and the served copy is the woken holder's. (w5 may survive:
    // router-0's abandoned first attempt sat queued on the frozen shard, and whether it runs
    // once the shard wakes is up to the socket, so the control does not depend on it.)
    for (const d of damage(run)) {
      expect(d.lost).toContain('w6');
      expect(d.doubled).toEqual([]);
    }
  });

  // A holder frozen INSIDE its write transaction (round 2, finding 3): it holds the scope
  // file's write lock, so the takeover's stamp cannot run until it wakes. Safe — nothing lost
  // or doubled — but the scope is unavailable for as long as the freeze, not one TTL.
  it('a holder frozen inside its transaction holds the scope until it wakes, and loses nothing', async () => {
    const c = (cluster = await new Cluster({ shards: 2, routerTimeoutsMs: [1500, 20_000] }).start());
    const scope = scopeHomedOn('todo-0', c.members);
    await c.provision(scope);
    const by: Record<string, unknown> = {};
    const write = async (router: string, text: string) => {
      const r = await c.write(router, scope, text);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      by[text] = r.json.node;
    };
    await write('router-0', 'w0');
    await write('router-1', 'w1');

    c.arm('todo-0', { text: 'w2', point: 'in-tx', signal: 'SIGSTOP' });
    const w2 = write('router-1', 'w2');
    await c.reached('todo-0', 'w2');
    const frozenAt = Date.now();
    const w3 = write('router-0', 'w3');
    // Frozen for four TTLs: the lease runs out, `todo-1` is granted the scope, and its
    // stamp waits on the frozen transaction's lock, answering 421 until it can take it.
    await new Promise((r) => setTimeout(r, FREEZE_MS));
    c.signal('todo-0', 'SIGCONT');
    await Promise.all([w2, w3]);
    const unavailableMs = Date.now() - frozenAt;

    expect(unavailableMs).toBeGreaterThanOrEqual(FREEZE_MS);
    // The frozen transaction committed when it woke, before the stamp could run, so it is in
    // the zombie's files and in the copy; its acknowledgement was withheld, and the retry
    // under its key was a replay on `todo-1`.
    expect(c.itemsOnVolume('todo-0', scope)).toContain('w2');
    expect(by).toEqual({ w0: 'todo-0', w1: 'todo-0', w2: 'todo-1', w3: 'todo-1' });
    for (const router of ['router-0', 'router-1']) {
      expect((await c.read(router, scope)).texts).toEqual(['w0', 'w1', 'w2', 'w3']);
    }
    console.log(`frozen inside the transaction for ${FREEZE_MS} ms: unavailable ${unavailableMs} ms`);
  });
});

const FREEZE_MS = 8_000;
