/**
 * The router's retry rules (#1638, review of #2202): a write with no idempotency key is never
 * replayed once it may have run, and a holder that paused for less than its lease is asked
 * again rather than given up on.
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

const homedOn = (node: string, members: readonly string[]) => {
  for (;;) {
    const id = ulid();
    if (home(id, members) === node) return id;
  }
};

describe('router retries', () => {
  it('does not replay a keyless write whose outcome it cannot know', async () => {
    const c = (cluster = await new Cluster({ shards: 2, routerTimeoutsMs: [1500, 1500] }).start());
    const scope = homedOn('todo-0', c.members);
    expect((await c.write('router-0', scope, 'w0')).json.node).toBe('todo-0');

    // `todo-0` commits k1 and freezes before answering. The router times out on it.
    c.arm('todo-0', { text: 'k1', point: 'post-commit', signal: 'SIGSTOP' });
    const k1 = c.write('router-0', scope, 'k1', null);
    await c.reached('todo-0', 'k1');
    const answer = await k1;
    expect(answer.status).toBe(503);
    expect(String(answer.json.error)).toMatch(/no Idempotency-Key/);

    // The scope moves on (a keyed write through the other router), the frozen shard wakes.
    expect((await c.write('router-1', scope, 'w2')).json.node).toBe('todo-1');
    c.signal('todo-0', 'SIGCONT');

    // k1 applied exactly once — the copy carried it — and was never replayed.
    const { texts } = await c.read('router-0', scope);
    expect(texts).toEqual(['w0', 'k1', 'w2']);
  });
});
