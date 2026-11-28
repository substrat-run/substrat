/**
 * Contract suite for #3474 (rfc/broker-and-tenant-isolation.md §9.1): what a delivery broker and the
 * scopes handing off to it report — a point at each handoff, receipt, delivery and retry, and the
 * broker's state when it moves — and that none of it carries message content.
 *
 * Driven against a real scope on both adapters, through the published data-point layout: the
 * fixture's sink keeps what was written as Analytics Engine would receive it, and the suite reads it
 * back with `decodeBrokerDataPoint`, so a field dropped from the layout fails here on both.
 *
 * The fixture's host runs `contractTestBareOps`, its receiver records what it is given, and every
 * retry is due at once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { BROKER_DATA_POINT_LAYOUT, ulid, type BrokerPoint, type ScopeHost } from '@substrat-run/kernel';

/** A data point as Analytics Engine receives it. */
export interface WrittenDataPoint {
  indexes: string[];
  blobs: string[];
  doubles: number[];
}

/** What a reader gets back from a point, by the layout's names. */
export type DecodedBrokerPoint = Record<string, string | number>;

/** Read a written point back by `BROKER_DATA_POINT_LAYOUT`'s names, as a staff query would. */
export function decodeBrokerDataPoint(p: WrittenDataPoint): DecodedBrokerPoint {
  const L = BROKER_DATA_POINT_LAYOUT;
  const out: DecodedBrokerPoint = {};
  L.indexes.forEach((f, i) => (out[f.name] = p.indexes[i] ?? f.absent));
  L.blobs.forEach((f, i) => (out[f.name] = p.blobs[i] ?? f.absent));
  L.doubles.forEach((f, i) => (out[f.name] = p.doubles[i] ?? f.absent));
  return out;
}

export interface DeliveryBrokerTelemetryFixture {
  host: ScopeHost;
  /** Every point written, the scope's and the broker's, in order. */
  written(): readonly WrittenDataPoint[];
  refuseHandoffs(n: number): void;
  failDeliveries(n: number): void;
  retryHandoffs(tenant: TenantId, scope: ScopeId): Promise<void>;
  deliverDue(tenant: TenantId): Promise<void>;
  /** The broker's own answer to a staff read (`state()`). */
  brokerState(tenant: TenantId): Promise<{ depth: number; deadLetters: number; pausedReceivers: number } | null>;
  cleanup(): Promise<void>;
}

/** What content the suite's operations commit, none of which may reach a point. */
const CONTENT = ['zz-content-marker', 'cafe-marker', 'hello', 'world', 'test.happened', 'provision-sibling'];

export function deliveryBrokerTelemetryContractSuite(
  adapterName: string,
  makeFixture: () => Promise<DeliveryBrokerTelemetryFixture>,
): void {
  describe(`delivery broker telemetry (#3474): ${adapterName}`, () => {
    let fixture: DeliveryBrokerTelemetryFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());
    const alice = principalId.parse(ulid());

    /** A fresh tenant per case: a broker is one per (tenant, app), and so is its state. */
    const freshScope = async (): Promise<{ t: TenantId; s: ScopeId }> => {
      const t = tenantId.parse(ulid());
      const s = scopeId.parse(ulid());
      await host.admin.createTenant(staff, { id: t, slug: `telemetry-${t.toLowerCase()}`, name: 'Telemetry' });
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'broker-vertical' });
      await host.admin.activateScope(staff, t, s);
      return { t, s };
    };
    const decoded = (t: TenantId) =>
      fixture
        .written()
        .map(decodeBrokerDataPoint)
        .filter((p) => p['substrat.tenant.id'] === t);
    const steps = (t: TenantId, step: BrokerPoint['step'] | 'state') => decoded(t).filter((p) => p['substrat.broker.step'] === step);

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('reports the handoff, each receipt and each delivery, and the state moving, with no content', async () => {
      const { t, s } = await freshScope();
      const stub = await host.getScope(alice, t, s);
      await stub.invoke('test/emit-event', { secret: 'zz-content-marker' });
      const intentId = await stub.invoke<string>('platform/request', { kind: 'provision-sibling', payload: { slug: 'cafe-marker' } });

      const handoffs = steps(t, 'handoff');
      expect(handoffs.length).toBeGreaterThanOrEqual(2);
      expect(handoffs.every((p) => p['substrat.broker.outcome'] === 'acked' && p['substrat.scope.id'] === s)).toBe(true);
      expect(handoffs.reduce((n, p) => n + Number(p['substrat.broker.messages']), 0)).toBe(2);
      const receipts = steps(t, 'receipt');
      expect(receipts.map((p) => p['substrat.broker.channel']).sort()).toEqual(['event', 'intent']);
      expect(receipts.every((p) => p['substrat.broker.outcome'] === 'stored' && p['substrat.broker.duplicates'] === 0)).toBe(true);
      expect(receipts.every((p) => p['substrat.vertical'] === 'broker-vertical')).toBe(true);

      await fixture.deliverDue(t);
      const deliveries = steps(t, 'delivery');
      expect(deliveries).toHaveLength(2);
      expect(deliveries.every((p) => p['substrat.broker.outcome'] === 'delivered')).toBe(true);
      expect(deliveries.map((p) => p['substrat.message.id'])).toContain(intentId);

      const depths = steps(t, 'state').map((p) => p['substrat.broker.queue.depth']);
      expect(Math.max(...depths.map(Number))).toBeGreaterThanOrEqual(1);
      expect(depths.at(-1)).toBe(0);
      expect(await fixture.brokerState(t)).toMatchObject({ depth: 0, deadLetters: 0, pausedReceivers: 0 });

      const text = JSON.stringify(fixture.written());
      for (const c of CONTENT) expect(text).not.toContain(c);
    });

    it('reports a failed attempt as a retry with its attempt count, then the delivery', async () => {
      const { t, s } = await freshScope();
      const stub = await host.getScope(alice, t, s);
      fixture.failDeliveries(1);
      await stub.invoke('test/emit-event', {});
      await fixture.deliverDue(t);
      const [retry] = steps(t, 'retry');
      expect(retry).toMatchObject({ 'substrat.broker.outcome': 'scheduled', 'substrat.broker.attempts': 1, 'substrat.scope.id': s });
      expect(steps(t, 'delivery')).toHaveLength(0);

      await fixture.deliverDue(t);
      const [delivery] = steps(t, 'delivery');
      expect(delivery?.['substrat.message.id']).toBe(retry?.['substrat.message.id']);
    });

    it('reports a refused handoff as failed, and its retry as acked', async () => {
      const { t, s } = await freshScope();
      const stub = await host.getScope(alice, t, s);
      fixture.refuseHandoffs(1);
      await stub.invoke('test/emit-event', {});
      expect(steps(t, 'handoff').map((p) => p['substrat.broker.outcome'])).toEqual(['failed']);
      expect(steps(t, 'receipt')).toHaveLength(0);

      await fixture.retryHandoffs(t, s);
      expect(steps(t, 'handoff').map((p) => p['substrat.broker.outcome'])).toEqual(['failed', 'acked']);
      expect(steps(t, 'receipt')).toHaveLength(1);
    });

    it('reports state only when it moves: passes over nothing write none', async () => {
      const { t, s } = await freshScope();
      const stub = await host.getScope(alice, t, s);
      await stub.invoke('test/emit-event', {});
      await fixture.deliverDue(t);
      const before = steps(t, 'state').length;
      await fixture.deliverDue(t);
      await fixture.deliverDue(t);
      expect(steps(t, 'state')).toHaveLength(before);
    });
  });
}
