/**
 * The lease table and the guard, against the real control-plane process (#1638 Q2).
 *
 * The kill test shows the lease end to end, where two of its mechanisms overlap: a woken
 * holder's background renewal and its pre-invocation check both turn a stale request away,
 * so removing either one alone leaves that test green. Each is held here on its own.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { ulid } from '@substrat-run/kernel';
import { LeaseClient, LeaseGuard, NotHolder, UnknownScope } from '../src/lease-client.js';
import { Cluster } from './cluster.js';

const TTL = 400;
let cluster: Cluster;
beforeAll(async () => {
  cluster = await new Cluster({ shards: 0, routerTimeoutsMs: [], leaseTtlMs: TTL }).start();
});
afterAll(() => cluster.stop());

/** One incarnation per pod name unless a test asks for a second one. */
const client = (node: string, incarnation = 'first') => new LeaseClient(cluster.controlPlane, node, 50, incarnation);

async function provisioned(): Promise<string> {
  const scope = ulid();
  await cluster.provision(scope);
  return scope;
}

async function refusal(p: Promise<unknown>): Promise<NotHolder> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(NotHolder);
  return e as NotHolder;
}

describe('control-plane lease table', () => {
  it('grants an unheld scope, refuses it to anyone else until it expires, then bumps the epoch', async () => {
    const scope = await provisioned();
    const a = await client('todo-0').acquire(scope);
    expect(a).toMatchObject({ epoch: 1, dataOn: null });
    const refused = await refusal(client('todo-1').acquire(scope));
    expect(refused).toMatchObject({ holder: 'todo-0', epoch: 1 });
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(TTL);

    await sleep(TTL + 50);
    const b = await client('todo-1').acquire(scope);
    expect(b.epoch).toBe(2);
  });

  it('hands the next holder the node with the latest data, once the holder settled it', async () => {
    const scope = await provisioned();
    const a = await client('todo-0').acquire(scope);
    await client('todo-0').settle(scope, a);
    await sleep(TTL + 50);
    expect(await client('todo-1').acquire(scope)).toMatchObject({ epoch: 2, dataOn: 'todo-0' });
  });

  it('refuses renew and settle to a holder whose epoch moved on — the stale holder learns it is fenced', async () => {
    const scope = await provisioned();
    const a = await client('todo-0').acquire(scope);
    await sleep(TTL + 50);
    await client('todo-1').acquire(scope);
    expect(await refusal(client('todo-0').renew(scope, a))).toMatchObject({ holder: 'todo-1', epoch: 2 });
    await refusal(client('todo-0').settle(scope, a));
  });

  it('lets a holder renew after its expiry when nobody took the scope — no one else can have written', async () => {
    const scope = await provisioned();
    const a = await client('todo-0').acquire(scope);
    await sleep(TTL + 50);
    await client('todo-0').renew(scope, a);
    expect(a.epoch).toBe(1);
    await refusal(client('todo-1').acquire(scope));
  });

  it('a second incarnation under the same pod name is another holder — the force-deleted pod case', async () => {
    const scope = await provisioned();
    await client('todo-1', 'old').acquire(scope);
    const refused = await refusal(client('todo-1', 'new').acquire(scope));
    expect(refused.holder).toBe('todo-1');
    await sleep(TTL + 50);
    expect((await client('todo-1', 'new').acquire(scope)).epoch).toBe(2);
  });

  it('a release ends the lease at once (a planned move)', async () => {
    const scope = await provisioned();
    const a = await client('todo-0').acquire(scope);
    await client('todo-0').release(scope, a);
    expect((await client('todo-1').acquire(scope)).epoch).toBe(2);
  });
});

describe('provisioning', () => {
  it('refuses a scope it was never told about — "no row" is never "new scope"', async () => {
    const e = await client('todo-0').acquire(ulid()).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(UnknownScope);
  });

  it('grants a provisioned scope with no data yet: the first holder seeds it', async () => {
    const scope = await provisioned();
    expect(await client('todo-0').acquire(scope)).toMatchObject({ epoch: 1, dataOn: null });
  });
});

describe('lease guard', () => {
  it('re-checks an expired grant before admitting, and refuses once the epoch moved on', async () => {
    const scope = await provisioned();
    const guard = new LeaseGuard(client('todo-0'));
    await guard.admit(scope);
    expect(guard.stillHeld(scope)).toBe(true);
    await sleep(TTL + 50);
    expect(guard.stillHeld(scope)).toBe(false);
    await client('todo-1').acquire(scope);
    // No background renewal is running: the refusal comes from `admit` itself.
    const refused = await refusal(guard.admit(scope));
    expect(refused.holder).toBe('todo-1');
    expect(guard.grant(scope)).toBeUndefined();
  });

  it('renews an expired but untaken grant in place on admit', async () => {
    const scope = await provisioned();
    const guard = new LeaseGuard(client('todo-0'));
    await guard.admit(scope);
    await sleep(TTL + 50);
    await guard.admit(scope);
    expect(guard.stillHeld(scope)).toBe(true);
    expect(guard.grant(scope)?.epoch).toBe(1);
  });

  it('places the data before a new grant is usable', async () => {
    const scope = await provisioned();
    const placed: number[] = [];
    const guard = new LeaseGuard(client('todo-0'), {
      onAcquire: async (_s, g) => {
        expect(guard.grant(scope)).toBeUndefined();
        placed.push(g.epoch);
      },
    });
    await guard.admit(scope);
    await guard.admit(scope);
    expect(placed).toEqual([1]);
  });

  it('with fencing off (the control), never re-checks and never fences', async () => {
    const scope = await provisioned();
    const guard = new LeaseGuard(client('todo-0'), { fencing: false });
    await guard.admit(scope);
    await sleep(TTL + 50);
    await client('todo-1').acquire(scope);
    await guard.admit(scope);
    expect(guard.stillHeld(scope)).toBe(true);
  });
});
