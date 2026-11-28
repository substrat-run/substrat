/**
 * #3474 on the pure host: the shared telemetry suite over `InProcessDeliveryBroker`, and the kernel's
 * `BrokerTelemetry` over a real store — the published layout, what observing costs a handoff, a
 * repeated handoff, a sink that throws, and the seams #3470 calls.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { TenantId } from '@substrat-run/contracts';
import {
  contractTestBareOps,
  decodeBrokerDataPoint,
  deliveryBrokerTelemetryContractSuite,
  type WrittenDataPoint,
} from '@substrat-run/contract-tests';
import {
  BROKER_DATA_POINT_LAYOUT,
  BrokerStore,
  BrokerTelemetry,
  brokerDataPoint,
  traceIdOf,
  type BrokerMessage,
  type BrokerPoint,
  type BrokerStateReport,
  type BrokerTelemetrySink,
  type DeliveryBroker,
} from '@substrat-run/kernel';
import { InProcessDeliveryBroker, SqliteScopeHost } from '../src/index.js';

/** A sink that writes what Analytics Engine would receive. */
const layoutSink = (written: WrittenDataPoint[]): BrokerTelemetrySink => ({
  point: (p) => void written.push(brokerDataPoint(p)),
  state: (s) => void written.push(brokerDataPoint(s)),
});

deliveryBrokerTelemetryContractSuite('adapter-sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-broker-telemetry-'));
  const written: WrittenDataPoint[] = [];
  const sink = layoutSink(written);
  let refusals = 0;
  let failures = 0;
  const brokers = new Map<string, InProcessDeliveryBroker>();
  const brokerOf = (tenant: string) => {
    let b = brokers.get(tenant);
    if (!b) {
      b = new InProcessDeliveryBroker({
        retryMs: [0],
        receiver: {
          async deliver() {
            if (failures > 0) {
              failures--;
              throw new Error('receiver down');
            }
          },
        },
        telemetry: { sink, tenantId: tenant, app: 'broker-vertical' },
      });
      brokers.set(tenant, b);
    }
    return b;
  };
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
  const host = new SqliteScopeHost({
    dir,
    deliveryBroker: ({ tenantId: t }) => reached(t),
    brokerTelemetry: { sink, appOf: () => 'broker-vertical' },
  });
  for (const [name, handler] of Object.entries(contractTestBareOps)) host.defineOperation(name, handler);
  return {
    host,
    written: () => written,
    refuseHandoffs: (n) => void (refusals = n),
    failDeliveries: (n) => void (failures = n),
    retryHandoffs: (t, s) => host.retryHandoffs(t, s),
    deliverDue: async (t: TenantId) => void (await brokerOf(t).deliverDue()),
    brokerState: async (t) => brokerOf(t).state(),
    cleanup: async () => {
      await host.close();
      for (const b of brokers.values()) b.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

describe('BrokerTelemetry over a store (#3474)', () => {
  const ids = { tenantId: 'T1', app: 'app-a' };
  const message = (i: number, kind: 'event' | 'intent' = 'event'): BrokerMessage => ({
    id: `01J${String(i).padStart(23, '0')}`,
    kind,
    tenantId: 'T1',
    scopeId: 'S1',
    type: 'thing.happened',
    body: JSON.stringify({ secret: 'zz-content-marker' }),
    committedAt: '2026-11-28T10:00:00.000Z',
  });
  /** A store over a real database, counting the statements it runs. */
  const counted = () => {
    const db = new Database(':memory:');
    const count = { statements: 0 };
    const store = new BrokerStore(
      {
        run: (q, ...p) => void (count.statements++, db.prepare(q).run(...p)),
        all: <T>(q: string, ...p: unknown[]) => (count.statements++, db.prepare(q).all(...p) as T[]),
      },
      { delivers: false },
    );
    count.statements = 0; // the DDL the store runs when it opens
    return { db, store, count };
  };
  const recorder = () => {
    const points: BrokerPoint[] = [];
    const states: BrokerStateReport[] = [];
    return { points, states, sink: { point: (p: BrokerPoint) => void points.push(p), state: (s: BrokerStateReport) => void states.push(s) } };
  };

  it('the layout is published: positions only grow', () => {
    expect(BROKER_DATA_POINT_LAYOUT.indexes.map((f) => f.name)).toEqual(['substrat.tenant.id']);
    expect(BROKER_DATA_POINT_LAYOUT.blobs.map((f) => `${f.ordinal}=${f.name}`)).toEqual([
      'blob1=substrat.vertical',
      'blob2=substrat.broker.step',
      'blob3=substrat.broker.outcome',
      'blob4=substrat.scope.id',
      'blob5=substrat.broker.receiver',
      'blob6=substrat.broker.channel',
      'blob7=trace.id',
      'blob8=substrat.message.id',
    ]);
    expect(BROKER_DATA_POINT_LAYOUT.doubles.map((f) => `${f.ordinal}=${f.name}`)).toEqual([
      'double1=substrat.broker.messages',
      'double2=substrat.broker.duplicates',
      'double3=substrat.broker.duration',
      'double4=substrat.broker.age',
      'double5=substrat.broker.attempts',
      'double6=substrat.broker.wait',
      'double7=substrat.broker.queue.depth',
      'double8=substrat.broker.queue.oldest_age',
      'double9=substrat.broker.paused_receivers',
      'double10=substrat.broker.dead_letters',
    ]);
  });

  it('costs a warm handoff one primary-key read per 50 ids, and no aggregate read', () => {
    const batch = Array.from({ length: 100 }, (_, i) => message(i + 1, i % 2 ? 'intent' : 'event'));
    const plain = counted();
    plain.store.accept(batch, 2_000);
    // Two statements per accepted message: the row and the mark.
    expect(plain.count.statements).toBe(200);

    const { db, store, count } = counted();
    const { sink, states } = recorder();
    const telemetry = new BrokerTelemetry(store, sink, ids);
    // The first receipt after a wake reads the state whole, once.
    const first = [message(0)];
    const held0 = telemetry.heldBefore(first);
    store.accept(first, 1_000);
    telemetry.received(first, held0, 1_000);
    count.statements = 0;
    const held = telemetry.heldBefore(batch);
    store.accept(batch, 2_000);
    telemetry.received(batch, held, 2_000);
    // Observing adds ceil(100 / 50) primary-key reads; the state moves in memory.
    expect(count.statements).toBe(200 + 2);
    expect(states.at(-1)).toMatchObject({ depth: 101, oldestAgeMs: 1_000 });
    db.close();
  });

  it('a repeated handoff is a receipt of duplicates, and moves no state', () => {
    const { db, store } = counted();
    const { sink, points, states } = recorder();
    const telemetry = new BrokerTelemetry(store, sink, ids);
    const batch = [message(1), message(2)];
    for (let round = 0; round < 2; round++) {
      const held = telemetry.heldBefore(batch);
      store.accept(batch, 1_000);
      telemetry.received(batch, held, 1_000);
    }
    expect(points.map((p) => [p.step, p.messages, p.duplicates])).toEqual([
      ['receipt', 2, 0],
      ['receipt', 2, 2],
    ]);
    expect(states.map((s) => s.depth)).toEqual([2]);
    db.close();
  });

  it('a sink that throws drops the point and fails nothing', () => {
    const { db, store } = counted();
    const telemetry = new BrokerTelemetry(store, { point: () => { throw new Error('down'); }, state: () => { throw new Error('down'); } }, ids);
    const batch = [message(1)];
    expect(() => telemetry.received(batch, telemetry.heldBefore(batch), 1_000)).not.toThrow();
    telemetry.passObserver().delivered(batch[0]!, 1_000, 1_010);
    expect(telemetry.dropped).toBe(3);
    db.close();
  });

  it("#3470's seams write dead letter and pause points, carrying no content", () => {
    const { db, store } = counted();
    const written: WrittenDataPoint[] = [];
    const telemetry = new BrokerTelemetry(store, layoutSink(written), ids);
    telemetry.deadLettered(message(1), Date.parse('2026-11-28T10:01:00.000Z'), { attempts: 5, receiver: 'lake' });
    telemetry.pauseStarted('lake', 0);
    telemetry.pauseEnded('lake', 0, 30_000);
    const got = written.map(decodeBrokerDataPoint);
    expect(got.map((p) => [p['substrat.broker.step'], p['substrat.broker.outcome'], p['substrat.broker.receiver']])).toEqual([
      ['dead-letter', 'dead', 'lake'],
      ['pause-start', 'paused', 'lake'],
      ['pause-end', 'resumed', 'lake'],
    ]);
    expect(got[0]).toMatchObject({ 'substrat.broker.attempts': 5, 'substrat.broker.age': 60_000 });
    expect(got[2]).toMatchObject({ 'substrat.broker.duration': 30_000 });
    expect(JSON.stringify(written)).not.toMatch(/zz-content-marker|thing\.happened/);
    db.close();
  });

  it('takes the trace id from a traceparent, and nothing else', () => {
    expect(traceIdOf('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(traceIdOf('garbage')).toBeNull();
    expect(traceIdOf(undefined)).toBeNull();
  });
});
