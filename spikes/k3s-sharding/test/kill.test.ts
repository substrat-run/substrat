/**
 * Kill mid-write: no acknowledged write is lost, and none is applied twice (#1638 Q2).
 *
 * Two shards, two routers, one scope whose home is `todo-0`. The run, every step pinned by a
 * fault the shard fires on itself at an exact point (no sleeps deciding the order):
 *
 *   1. writes through both routers, so both cache `todo-0`;
 *   2. `todo-0` FREEZES (SIGSTOP) between taking the write and applying it — a pod whose node
 *      stopped answering, not one that died. Router-0 times out and fails over to `todo-1`;
 *   3. more writes land on `todo-1`;
 *   4. `todo-0` wakes up. Router-1 never saw the failover and sends it the next write;
 *   5. `todo-1` is SIGKILLed after committing a write and before answering it. Router-0
 *      retries it, with its idempotency key, wherever the scope is served next, while the
 *      StatefulSet's part brings `todo-1` back under the same name and volume;
 *   6. every acknowledged write must be in the scope exactly once, read through either router.
 *
 * A SIGKILL alone cannot fail this on one machine — a dead process writes nothing, and the
 * retry is recognised by its key. What fails is step 2's survivor: a holder that is not dead.
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

async function freezeFailoverKill(c: Cluster): Promise<{ acked: string[]; reads: string[][] }> {
  const scope = scopeHomedOn('todo-0', c.members);
  const acked: string[] = [];
  const write = async (router: string, text: string) => {
    const r = await c.write(router, scope, text);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    acked.push(text);
    return r.json;
  };

  // 1. Both routers learn `todo-0`.
  expect((await write('router-0', 'w0')).node).toBe('todo-0');
  expect((await write('router-1', 'w0b')).node).toBe('todo-0');
  for (const t of ['w1', 'w2', 'w3']) await write('router-0', t);

  // 2. `todo-0` freezes mid-write; router-0 fails over.
  c.arm('todo-0', { text: 'w4', point: 'pre-write', signal: 'SIGSTOP' });
  const w4 = write('router-0', 'w4');
  await c.reached('todo-0', 'w4');
  expect((await w4).node).toBe('todo-1');

  // 3. More writes, on `todo-1`.
  for (const t of ['w5', 'w6']) expect((await write('router-0', t)).node).toBe('todo-1');

  // 4. `todo-0` wakes; router-1 still believes it holds the scope.
  c.signal('todo-0', 'SIGCONT');
  await write('router-1', 'w7');

  // 5. `todo-1` dies after committing w8 and before answering it.
  c.arm('todo-1', { text: 'w8', point: 'post-commit', signal: 'SIGKILL' });
  const w8 = write('router-0', 'w8');
  await c.reached('todo-1', 'w8');
  await c.restart('todo-1');
  await w8;

  // 6. Read back through both routers.
  const reads = [(await c.read('router-0', scope)).texts, (await c.read('router-1', scope)).texts];
  return { acked, reads };
}

function tally(texts: string[]): Record<string, number> {
  const n: Record<string, number> = {};
  for (const t of texts) n[t] = (n[t] ?? 0) + 1;
  return n;
}

describe('kill mid-write', () => {
  it('loses no acknowledged write and applies none twice', async () => {
    cluster = await new Cluster({ shards: 2, routers: 2 }).start();
    const { acked, reads } = await freezeFailoverKill(cluster);
    for (const texts of reads) {
      const n = tally(texts);
      const lost = acked.filter((t) => (n[t] ?? 0) === 0);
      const doubled = acked.filter((t) => (n[t] ?? 0) > 1);
      expect({ lost, doubled }).toEqual({ lost: [], doubled: [] });
      expect(texts).toHaveLength(acked.length);
    }
  });
});
