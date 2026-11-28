/**
 * K-74 on the Durable Object: the shared handoff suite over `BrokerScopeDO` and `TestDeliveryBrokerDO`
 * (test/worker.ts), the retry decision on its own clock, and what only this adapter decides: a script
 * with no broker bound hands off nothing, a failed handoff is retried from the scope's alarm, and a
 * broker holding nothing arms nothing.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { deliveryBrokerContractSuite } from '@substrat-run/contract-tests';
import { BROKER_HELD_RETENTION_MS, HANDOFF_RETRY_MS, brokerName, ulid, type BrokerMessage } from '@substrat-run/kernel';
import { DELIVERY_HANDOFF_KEY, handoffAfterFailure, handoffDue, handoffPending, mergeHandoff, sameMarks, type HandoffState } from '../src/delivery-handoff.js';
import { CloudflareScopeHost } from './test-host.js';
import { DELIVERY_BROKER_APP, deliveryBrokerTest, type TestDeliveryBrokerDO } from './worker.js';

const brokerStub = (ns: DurableObjectNamespace, t: TenantId) => ns.get(ns.idFromName(brokerName(t, DELIVERY_BROKER_APP)));

/** One delivery pass of the tenant's recording broker, driven by the suite (`TestDeliveryBrokerDO.drive`). */
const drive = (t: TenantId) =>
  runInDurableObject(brokerStub(env.TEST_DELIVERY_BROKER, t), (instance) => (instance as unknown as TestDeliveryBrokerDO).drive());

/** Bring a scope's handoff retry to now, as the clock would, and run the alarm it armed. */
const fireHandoffRetry = async (ns: DurableObjectNamespace, s: ScopeId) => {
  const stub = ns.get(ns.idFromName(s));
  await runInDurableObject(stub, async (_i, state) => {
    const h = await state.storage.get<HandoffState>(DELIVERY_HANDOFF_KEY);
    if (h?.due !== undefined) await state.storage.put(DELIVERY_HANDOFF_KEY, { ...h, due: Date.now() - 1 });
  });
  await runDurableObjectAlarm(stub);
};

deliveryBrokerContractSuite('adapter-cloudflare', async () => {
  const state = deliveryBrokerTest();
  state.received.length = 0;
  state.refusals = 0;
  state.failures = 0;
  return {
    host: new CloudflareScopeHost({ scope: env.BROKER_SCOPE, controlPlane: env.CONTROL_PLANE }),
    received: () => state.received,
    refuseHandoffs: (n) => void (state.refusals = n),
    failDeliveries: (n) => void (state.failures = n),
    retryHandoffs: (_t, s) => fireHandoffRetry(env.BROKER_SCOPE, s),
    deliverDue: (t) => drive(t),
    cleanup: async () => {},
  };
});

describe('the handoff retry decision (delivery-handoff.ts)', () => {
  const NOW = Date.parse('2026-11-27T10:00:00Z');

  it('backs off on HANDOFF_RETRY_MS, keeping the marks it knew', () => {
    let state: HandoffState | null = { marks: { event: 'A' } };
    const waits: number[] = [];
    for (let i = 0; i < HANDOFF_RETRY_MS.length + 1; i++) {
      state = handoffAfterFailure(state, undefined, NOW);
      waits.push(state.due! - NOW);
    }
    expect(waits).toEqual([...HANDOFF_RETRY_MS, HANDOFF_RETRY_MS.at(-1)]);
    expect(state!.marks).toEqual({ event: 'A' });
    expect(handoffDue(state, state!.due! - 1)).toBe(false);
    expect(handoffDue(state, state!.due!)).toBe(true);
    expect(handoffDue(null, NOW)).toBe(false);
  });

  it('stores a retry before the broker call: the first step, its ids, the count so far', () => {
    const ids = { tenantId: 'T', scopeId: 'S' };
    expect(handoffPending(null, { event: 'A' }, NOW, ids)).toEqual({ ...ids, marks: { event: 'A' }, due: NOW + HANDOFF_RETRY_MS[0]! });
    expect(handoffPending({ retries: 2, marks: { intent: 'X' } }, undefined, NOW, ids)).toEqual({
      ...ids,
      marks: { intent: 'X' },
      retries: 2,
      due: NOW + HANDOFF_RETRY_MS[0]!,
    });
    expect(sameMarks({ event: 'A' }, { event: 'A' })).toBe(true);
    expect(sameMarks({ event: 'A' }, { event: 'B' })).toBe(false);
    expect(sameMarks(undefined, {})).toBe(true);
  });

  it('never moves a mark backwards, and invents none', () => {
    expect(mergeHandoff({ marks: { event: 'B', intent: 'X' } }, { marks: { event: 'A' } }).marks).toEqual({ event: 'B', intent: 'X' });
    expect(mergeHandoff({ marks: { event: 'A' } }, { marks: { event: 'B' } }).marks).toEqual({ event: 'B' });
    expect(mergeHandoff(null, { retries: 1, due: NOW })).toEqual({ retries: 1, due: NOW });
  });
});

describe('the broker on the Durable Object (K-74)', () => {
  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());

  const scopeOn = async (ns: DurableObjectNamespace) => {
    const host = new CloudflareScopeHost({ scope: ns, controlPlane: env.CONTROL_PLANE });
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `broker-${t.slice(-6).toLowerCase()}`, name: 'Broker' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: DELIVERY_BROKER_APP });
    await host.admin.activateScope(staff, t, s);
    return { t, s, stub: await host.getScope(alice, t, s), object: ns.get(ns.idFromName(s)) };
  };

  it('a script with no broker bound hands off nothing and keeps no handoff state', async () => {
    const { stub, object } = await scopeOn(env.UNBROKERED_SCOPE);
    await stub.invoke('test/emit-event', {});
    const kept = await runInDurableObject(object, async (_i, state) => state.storage.get(DELIVERY_HANDOFF_KEY));
    expect(kept).toBeUndefined();
  });

  it('a refused handoff arms the scope alarm, and the alarm hands it off', async () => {
    const test = deliveryBrokerTest();
    const { t, s, stub, object } = await scopeOn(env.BROKER_SCOPE);
    test.refusals = 1;
    await stub.invoke('test/emit-event', {});
    const armed = await runInDurableObject(object, async (_i, state) => ({
      handoff: await state.storage.get<HandoffState>(DELIVERY_HANDOFF_KEY),
      alarm: await state.storage.getAlarm(),
    }));
    expect(armed.handoff).toMatchObject({ retries: 1 });
    expect(armed.alarm).not.toBeNull();

    await fireHandoffRetry(env.BROKER_SCOPE, s);
    await drive(t);
    expect(test.received.filter((m: BrokerMessage) => m.scopeId === s).map((m) => m.kind)).toEqual(['event']);
    const settled = await runInDurableObject(object, async (_i, state) => state.storage.get<HandoffState>(DELIVERY_HANDOFF_KEY));
    expect(settled?.due).toBeUndefined();
    expect(settled?.marks?.event).toBeDefined();
  });

  it('an alarm another user of it fired first re-arms the handoff retry at its own time', async () => {
    const { t, s, object } = await scopeOn(env.BROKER_SCOPE);
    const due = Date.now() + 60_000;
    // The state another user's alarm finds: the retry stored, no alarm left armed (it just fired).
    const armed = await runInDurableObject(object, async (instance, state) => {
      await state.storage.put(DELIVERY_HANDOFF_KEY, { tenantId: t, scopeId: s, retries: 1, due });
      await state.storage.deleteAlarm();
      await (instance as unknown as { alarm(): Promise<void> }).alarm();
      return state.storage.getAlarm();
    });
    expect(armed).toBe(due);
  });

  it('a broker with no receiver holds what it accepts, under one prune alarm; one holding nothing arms nothing', async () => {
    const { t, stub } = await scopeOn(env.HOLDING_BROKER_SCOPE);
    const broker = brokerStub(env.HOLDING_DELIVERY_BROKER, t);
    expect(await runInDurableObject(broker, async (_i, state) => state.storage.getAlarm())).toBeNull();

    const before = Date.now();
    await stub.invoke('test/emit-event', {});
    const held = await runInDurableObject(broker, async (_i, state) => ({
      rows: state.storage.sql.exec('SELECT COUNT(*) AS n FROM broker_messages WHERE next_at IS NULL').one().n,
      alarm: await state.storage.getAlarm(),
    }));
    expect(held.rows).toBe(1);
    expect(held.alarm).toBeGreaterThanOrEqual(before + BROKER_HELD_RETENTION_MS);
  });
});
