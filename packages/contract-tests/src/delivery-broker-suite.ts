/**
 * Contract suite for K-74's handoff (rfc/broker-and-tenant-isolation.md §4.1): after a commit a scope
 * hands its broker every event it emitted and every intent it raised, once each, and the broker
 * delivers each once, retrying a failure.
 *
 * Driven against a real scope on both adapters, because the Durable Object hands off across an RPC
 * hop and retries from its alarm, and the pure host does neither: the place a message is lost or
 * doubled is exactly that difference. The fixture owns what differs — how the broker is made to
 * refuse, and how a retry or a delivery pass is run — and the suite only says what must hold.
 *
 * The fixture's host runs `contractTestBareOps` (`test/emit-event`, `platform/request`), with a
 * receiver that records what it is given.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ulid, type BrokerMessage, type ScopeHost } from '@substrat-run/kernel';

export interface DeliveryBrokerFixture {
  host: ScopeHost;
  /** Every message the receiver was given, in order, failed attempts excluded. */
  received(): readonly BrokerMessage[];
  /** The broker refuses the next `n` handoffs, as an unreachable broker would. */
  refuseHandoffs(n: number): void;
  /** The receiver fails the next `n` deliveries. */
  failDeliveries(n: number): void;
  /** Run the scope's handoff retry: the pure host's `retryHandoffs`, the Durable Object's alarm. */
  retryHandoffs(tenant: TenantId, scope: ScopeId): Promise<void>;
  /** Run one delivery pass for the tenant's broker, with every retry already due. */
  deliverDue(tenant: TenantId): Promise<void>;
  cleanup(): Promise<void>;
}

export function deliveryBrokerContractSuite(adapterName: string, makeFixture: () => Promise<DeliveryBrokerFixture>): void {
  describe(`delivery broker handoff (K-74): ${adapterName}`, () => {
    let fixture: DeliveryBrokerFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    const alice = principalId.parse(ulid());

    /** A fresh scope per case, so no case reads another's messages. */
    const freshScope = async (): Promise<ScopeId> => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t1, scopeId: s, vertical: 'broker-vertical' });
      await host.admin.activateScope(staff, t1, s);
      return s;
    };
    const of = (scope: ScopeId) => fixture.received().filter((m) => m.scopeId === scope);

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      await host.admin.createTenant(staff, { id: t1, slug: 'broker-tenant', name: 'Broker Tenant' });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('hands off an emitted event and a raised intent, and the broker delivers each once', async () => {
      const s = await freshScope();
      const stub = await host.getScope(alice, t1, s);
      await stub.invoke('test/emit-event', {});
      const intentId = await stub.invoke<string>('platform/request', { kind: 'provision-sibling', payload: { slug: 'cafe' } });
      await fixture.deliverDue(t1);

      const got = of(s);
      expect(got.map((m) => m.kind).sort()).toEqual(['event', 'intent']);
      expect(got.find((m) => m.kind === 'event')).toMatchObject({ tenantId: t1, scopeId: s, type: 'test.happened' });
      const intent = got.find((m) => m.kind === 'intent')!;
      expect(intent).toMatchObject({ id: intentId, type: 'provision-sibling' });
      expect(JSON.parse(intent.body)).toMatchObject({ id: intentId, kind: 'provision-sibling' });

      // A later commit hands off only what is new: nothing already held goes again.
      await stub.invoke('test/emit-event', {});
      await fixture.deliverDue(t1);
      expect(of(s).map((m) => m.kind).sort()).toEqual(['event', 'event', 'intent']);
      expect(new Set(of(s).map((m) => m.id)).size).toBe(3);
    });

    it('retries a refused handoff, and the message arrives once', async () => {
      const s = await freshScope();
      const stub = await host.getScope(alice, t1, s);
      fixture.refuseHandoffs(1);
      await stub.invoke('test/emit-event', {});
      await fixture.deliverDue(t1);
      expect(of(s)).toHaveLength(0);

      await fixture.retryHandoffs(t1, s);
      await fixture.retryHandoffs(t1, s);
      await fixture.deliverDue(t1);
      expect(of(s).map((m) => m.kind)).toEqual(['event']);
    });

    it('retries a failed delivery until it lands, and delivers it once', async () => {
      const s = await freshScope();
      const stub = await host.getScope(alice, t1, s);
      fixture.failDeliveries(2);
      await stub.invoke('test/emit-event', {});
      await fixture.deliverDue(t1);
      await fixture.deliverDue(t1);
      expect(of(s)).toHaveLength(0);

      await fixture.deliverDue(t1);
      await fixture.deliverDue(t1);
      expect(of(s).map((m) => m.kind)).toEqual(['event']);
    });

    it('hands off a backlog larger than one batch, with nothing doubled', async () => {
      const s = await freshScope();
      const stub = await host.getScope(alice, t1, s);
      fixture.refuseHandoffs(1);
      // HANDOFF_BATCH + 10 events (not intents: a scope holds at most 32 pending, the cap A7 removes),
      // the first committed while the broker refused it.
      for (let i = 0; i < 60; i++) await stub.invoke('test/emit-event', {});
      await fixture.retryHandoffs(t1, s);
      for (let i = 0; i < 3; i++) await fixture.deliverDue(t1);
      const got = of(s).map((m) => m.id);
      expect(got).toHaveLength(60);
      expect(new Set(got).size).toBe(60);
      expect(of(s).every((m) => m.kind === 'event')).toBe(true);
    });
  });
}
