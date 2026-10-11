/**
 * The control plane loses its lease table (#1638, review of #2202, finding 3).
 *
 * The lease table is the only record of which node holds a scope's latest copy. Losing it must
 * leave the data alone: a scope with no row is refused, not treated as new, and a shard asked
 * to seed a scope it already has data for refuses rather than overwriting it.
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

describe('control-plane state loss', () => {
  it('refuses writes and deletes nothing when the lease table is gone', async () => {
    const c = (cluster = await new Cluster({ shards: 2 }).start());
    let scope = ulid();
    while (home(scope, c.members) !== 'todo-0') scope = ulid();
    await c.provision(scope);
    for (const t of ['w0', 'w1']) expect((await c.write('router-0', scope, t)).status).toBe(200);

    await c.loseControlPlaneState();

    // The holder keeps serving until its grant runs out — safe, since no one else can be
    // granted the scope either — and its next renewal is refused. From then on: no row, 404.
    let after = await c.write('router-0', scope, 'w2');
    for (let i = 0; i < 100 && after.status === 200; i++) {
      await sleep(100);
      after = await c.write('router-0', scope, 'w2');
    }
    expect(after.status, JSON.stringify(after.json)).toBe(404);
    const kept = c.itemsOnVolume('todo-0', scope);
    expect(kept?.slice(0, 2)).toEqual(['w0', 'w1']);

    // An operator re-provisions it (a fresh row, no copy on record): the shard that has the
    // data refuses to seed over it, and the files are untouched.
    await c.provision(scope);
    const reseed = await c.write('router-0', scope, 'w3');
    expect(reseed.status, JSON.stringify(reseed.json)).toBe(409);
    expect(String(reseed.json.error)).toMatch(/refusing to seed over it/);
    expect(c.itemsOnVolume('todo-0', scope)).toEqual(kept);
  });

  it('refuses, and deletes nothing, when its own volume is the copy on record but is incomplete', async () => {
    const c = (cluster = await new Cluster({ shards: 2 }).start());
    let scope = ulid();
    while (home(scope, c.members) !== 'todo-0') scope = ulid();
    await c.provision(scope);
    expect((await c.write('router-0', scope, 'w0')).json).toMatchObject({ node: 'todo-0' });

    // todo-0 dies; its volume, which the control plane names as holding the latest copy, comes
    // back without the file the shard opens a scope by.
    c.signal('todo-0', 'SIGKILL');
    await c.exited('todo-0');
    c.removeFromVolume('todo-0', scope, 'world.json');
    const before = c.filesOnVolume('todo-0', scope);
    await c.restart('todo-0');

    const answer = await c.write('router-0', scope, 'w1');
    expect(answer.status, JSON.stringify(answer.json)).toBe(409);
    expect(String(answer.json.error)).toMatch(/incomplete/);
    expect(c.filesOnVolume('todo-0', scope)).toEqual(before);
    expect(c.itemsOnVolume('todo-0', scope)).toEqual(['w0']);
  });
});
