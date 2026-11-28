/**
 * K-74 on the pure host: the shared handoff suite over `InProcessDeliveryBroker`, plus what only this
 * adapter decides — that a host given no broker hands off nothing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type TenantId } from '@substrat-run/contracts';
import { contractTestBareOps, deliveryBrokerContractSuite } from '@substrat-run/contract-tests';
import { ulid, type BrokerMessage, type DeliveryBroker } from '@substrat-run/kernel';
import { InProcessDeliveryBroker, SqliteScopeHost } from '../src/index.js';

const bareHost = (options: ConstructorParameters<typeof SqliteScopeHost>[0]) => {
  const host = new SqliteScopeHost(options);
  for (const [name, handler] of Object.entries(contractTestBareOps)) host.defineOperation(name, handler);
  return host;
};

deliveryBrokerContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-broker-'));
  const received: BrokerMessage[] = [];
  let refusals = 0;
  let failures = 0;
  const brokers = new Map<string, InProcessDeliveryBroker>();
  const brokerOf = (tenant: string) => {
    let b = brokers.get(tenant);
    if (!b) {
      b = new InProcessDeliveryBroker({
        // Every retry due at once: the suite runs passes back to back, on no clock of its own.
        policy: { backoff: { initialMs: 0 }, jitter: 0 },
        receiver: {
          async deliver(m) {
            if (failures > 0) {
              failures--;
              throw new Error('receiver down');
            }
            received.push(m);
          },
        },
      });
      brokers.set(tenant, b);
    }
    return b;
  };
  // The broker as a scope reaches it, refusing on request as an unreachable one would.
  const reached = (tenant: string): DeliveryBroker => ({
    handOff: async (messages) => {
      if (refusals > 0) {
        refusals--;
        throw new Error('broker unreachable');
      }
      return brokerOf(tenant).handOff(messages);
    },
    marks: (t, s) => brokerOf(tenant).marks(t, s),
  });
  const host = bareHost({ dir, deliveryBroker: ({ tenantId: t }) => reached(t) });
  return {
    host,
    received: () => received,
    refuseHandoffs: (n) => void (refusals = n),
    failDeliveries: (n) => void (failures = n),
    retryHandoffs: (t, s) => host.retryHandoffs(t, s),
    deliverDue: async (t: TenantId) => void (await brokerOf(t).deliverDue()),
    cleanup: async () => {
      await host.close();
      for (const b of brokers.values()) b.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

describe('delivery broker off (K-74): adapter-sqlite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-broker-off-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a host given no broker hands off nothing, and retrying is a no-op', async () => {
    const host = bareHost({ dir });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'broker-off', name: 'Broker Off' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'broker-vertical' });
    await host.admin.activateScope(staff, t, s);
    const stub = await host.getScope(principalId.parse(ulid()), t, s);
    await stub.invoke('test/emit-event', {});
    await expect(host.retryHandoffs(t, s)).resolves.toBeUndefined();
    await host.close();
  });
});

describe('the in-process broker (K-74)', () => {
  it('stores a repeated handoff once, acknowledges it again, and keeps the marks', async () => {
    const broker = new InProcessDeliveryBroker();
    const m: BrokerMessage = {
      id: ulid(),
      kind: 'event',
      tenantId: 't',
      scopeId: 's',
      type: 'x.happened',
      body: '{}',
      committedAt: '2026-11-27T10:00:00.000Z',
    };
    expect(await broker.handOff([m])).toEqual({ acked: [m.id] });
    expect(await broker.handOff([m])).toEqual({ acked: [m.id] });
    expect(broker.pending()).toBe(1);
    expect(await broker.marks('t', 's')).toEqual({ event: m.id });
    broker.close();
  });

  const message = (): BrokerMessage => ({
    id: ulid(),
    kind: 'event',
    tenantId: 't',
    scopeId: 's',
    type: 'x',
    body: '{}',
    committedAt: '2026-11-28T10:00:00.000Z',
  });

  it('runs overlapping delivery passes one at a time, so a message reaches the receiver once', async () => {
    const delivered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const broker = new InProcessDeliveryBroker({
      receiver: {
        async deliver(m) {
          await gate;
          delivered.push(m.id);
        },
      },
    });
    const m = message();
    await broker.handOff([m]);
    const first = broker.deliverDue();
    const second = broker.deliverDue();
    release();
    await Promise.all([first, second]);
    expect(delivered).toEqual([m.id]);
    broker.close();
  });

  it('makes the rows it held without a receiver due once it is opened with one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-broker-held-'));
    const file = join(dir, 'broker.sqlite');
    const m = message();
    const holding = new InProcessDeliveryBroker({ file });
    await holding.handOff([m]);
    holding.close();
    const delivered: string[] = [];
    const delivering = new InProcessDeliveryBroker({ file, receiver: { deliver: async (x) => void delivered.push(x.id) } });
    expect(await delivering.deliverDue()).toMatchObject({ delivered: 1 });
    expect(delivered).toEqual([m.id]);
    delivering.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('after its last delivery, still says when the delivered row is to be pruned', async () => {
    let now = Date.parse('2026-11-28T10:00:00Z');
    const broker = new InProcessDeliveryBroker({ now: () => now, receiver: { deliver: async () => {} } });
    await broker.handOff([{ id: ulid(), kind: 'event', tenantId: 't', scopeId: 's', type: 'x', body: '{}', committedAt: '2026-11-28T10:00:00.000Z' }]);
    const delivered = now;
    const pass = await broker.deliverDue();
    expect(pass).toMatchObject({ delivered: 1, failed: 0 });
    // The row is kept for a duplicate handoff to find, and the pass says when its bound runs out.
    expect(pass.nextAt).toBeGreaterThan(delivered);
    now = pass.nextAt!;
    // At that moment the row is pruned, and a broker holding nothing has no next wake.
    expect(await broker.deliverDue()).toEqual({ delivered: 0, failed: 0, deadLettered: 0, nextAt: null });
    broker.close();
  });
});
