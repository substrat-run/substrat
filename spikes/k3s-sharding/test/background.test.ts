/**
 * Background work runs exactly once per scope, on the shard that holds it, across a
 * handover (#1638 Q6).
 *
 * The work is a slot every 250 ms: `bg:<k>`, written under the idempotency key `bg:<k>`.
 * The run:
 *
 *   1. the scope is placed on `todo-0`, which runs its first slots;
 *   2. `todo-0` FREEZES mid-slot (SIGSTOP before applying bg:3);
 *   3. a request fails over to `todo-1` once the lease runs out, and `todo-1`'s loop takes
 *      the slots over — replaying the ones `todo-0` finished, running the rest;
 *   4. `todo-0` wakes: its half-done bg:3 is fenced, and its loop is refused the scope;
 *   5. `todo-1` is SIGKILLed right after committing bg:6, before its loop records it;
 *   6. the StatefulSet's part restarts `todo-1`. Once the dead process's lease has run out,
 *      a shard's loop takes the scope by itself — no request needs to arrive — and carries on.
 *
 * Every slot up to the last one seen must be present exactly once, with no gap.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { ulid } from '@substrat-run/kernel';
import { home } from '../src/placement.js';
import { Cluster } from './cluster.js';

let cluster: Cluster | undefined;
afterEach(async () => {
  await cluster?.stop();
  cluster = undefined;
});

const slotsIn = (texts: string[]) => texts.filter((t) => t.startsWith('bg:')).map((t) => Number(t.slice(3)));

async function untilSlot(c: Cluster, scope: string, k: number): Promise<string[]> {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const { texts } = await c.read('router-0', scope);
    if (slotsIn(texts).includes(k)) return texts;
    await sleep(100);
  }
  throw new Error(`slot ${k} never ran`);
}

describe('background work across a handover', () => {
  it('runs every slot exactly once, on whichever shard holds the scope', async () => {
    const c = (cluster = await new Cluster({ shards: 2, bgPeriodMs: 250 }).start());
    let scope = ulid();
    while (home(scope, c.members) !== 'todo-0') scope = ulid();

    // 1–2. Placed on todo-0; it freezes in the middle of bg:3.
    c.arm('todo-0', { text: 'bg:3', point: 'pre-write', signal: 'SIGSTOP' });
    expect((await c.write('router-0', scope, 'w0')).json.node).toBe('todo-0');
    await c.reached('todo-0', 'bg:3');

    // 3. A request moves the scope to todo-1, whose loop takes the slots over.
    expect((await c.write('router-0', scope, 'w1')).json).toMatchObject({ node: 'todo-1', epoch: 2 });
    c.arm('todo-1', { text: 'bg:6', point: 'post-commit', signal: 'SIGKILL' });

    // 4. todo-0 wakes and is fenced.
    c.signal('todo-0', 'SIGCONT');

    // 5–6. todo-1 dies right after bg:6; restarted, it takes the scope back by itself.
    await c.reached('todo-1', 'bg:6');
    await c.restart('todo-1');
    const texts = await untilSlot(c, scope, 9);

    const slots = slotsIn(texts);
    const last = Math.max(...slots);
    expect([...slots].sort((a, b) => a - b)).toEqual(Array.from({ length: last + 1 }, (_, k) => k));
    expect(texts.filter((t) => t === 'w0' || t === 'w1')).toEqual(['w0', 'w1']);
    const lease = await c.lease(scope);
    // Whoever took it after the kill — the restarted todo-1 from its own volume, or todo-0,
    // which also has a (stale) copy on its volume and copies the latest one — did so under a
    // new epoch: the restarted pod is a new incarnation and inherited nothing by its name.
    expect(lease.epoch).toBeGreaterThanOrEqual(3);
    expect(lease.data_on).toBe(lease.holder.split('/')[0]);
  });
});
