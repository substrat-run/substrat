/**
 * Resharding 2 → 3 (#1638 Q4): the scopes rendezvous hashing moves go to the new pod, with
 * every write they had, and the rest are not touched at all.
 *
 * The move is the lease's planned path: the old holder releases the scope (so the new home
 * need not wait out a TTL), and the new home copies it from the volume the control plane
 * names as `data_on` on its first request. The transfer is a file-level copy of the scope's
 * directory (`copyScope`), not `snapshotScope`/`importScope` — FINDINGS.md §4 says why.
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

describe('resharding', () => {
  it('scaling 2 → 3 moves only the scopes whose home became todo-2, and moves them whole', async () => {
    const c = (cluster = await new Cluster({ shards: 3, routedShards: 2 }).start());
    // Eight scopes the scale-up will move and sixteen it will not, picked by placement up front
    // so the run never depends on how a draw of ids happened to fall.
    const after = ['todo-0', 'todo-1', 'todo-2'];
    const scopes: string[] = [];
    for (let moving = 0, staying = 0; moving < 8 || staying < 16; ) {
      const s = ulid();
      if (home(s, after) === 'todo-2' ? moving++ < 8 : staying++ < 16) scopes.push(s);
    }
    const before = new Map<string, { node: string; epoch: number }>();
    for (const scope of scopes) {
      await c.provision(scope);
      for (const text of ['a', 'b', 'c']) expect((await c.write('router-0', scope, `${scope}:${text}`)).status).toBe(200);
      const r = await c.read('router-0', scope);
      before.set(scope, { node: r.node, epoch: r.epoch });
      expect(r.node).toBe(home(scope, ['todo-0', 'todo-1']));
    }

    const released = await c.scale(3);
    const expectedMoves = scopes.filter((s) => home(s, after) === 'todo-2');
    expect(expectedMoves).toHaveLength(8);
    expect([...released['todo-0']!, ...released['todo-1']!].sort()).toEqual([...expectedMoves].sort());

    for (const scope of scopes) {
      const r = await c.read('router-0', scope);
      expect(r.texts).toEqual([`${scope}:a`, `${scope}:b`, `${scope}:c`]);
      if (expectedMoves.includes(scope)) {
        expect(r).toMatchObject({ node: 'todo-2', epoch: before.get(scope)!.epoch + 1 });
      } else {
        // Untouched: same shard, same epoch — no lease changed hands.
        expect({ node: r.node, epoch: r.epoch }).toEqual(before.get(scope));
      }
    }
    // And a moved scope takes writes on its new shard.
    const moved = expectedMoves[0]!;
    expect((await c.write('router-0', moved, `${moved}:d`)).json.node).toBe('todo-2');
  });
});
