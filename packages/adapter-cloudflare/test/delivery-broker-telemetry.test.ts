/**
 * #3474 on the Durable Object: the shared telemetry suite over `TelemetryBrokerScopeDO` and
 * `TelemetryDeliveryBrokerDO` (test/worker.ts), whose script binds `SUBSTRAT_BROKER_TELEMETRY` to a
 * recorder, plus what only this adapter decides: a broker with no dataset bound answers no state.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { deliveryBrokerTelemetryContractSuite } from '@substrat-run/contract-tests';
import { brokerName, ulid } from '@substrat-run/kernel';
import { DELIVERY_HANDOFF_KEY, type HandoffState } from '../src/delivery-handoff.js';
import type { DeliveryBrokerRpc } from '../src/delivery-broker-do.js';
import { CloudflareScopeHost } from './test-host.js';
import { DELIVERY_BROKER_APP, brokerTelemetryTest, type TelemetryDeliveryBrokerDO } from './worker.js';

const brokerStub = (ns: DurableObjectNamespace, t: TenantId) => ns.get(ns.idFromName(brokerName(t, DELIVERY_BROKER_APP)));

deliveryBrokerTelemetryContractSuite('adapter-cloudflare', async () => {
  const state = brokerTelemetryTest();
  Object.assign(state, { received: [], refusals: 0, failures: 0, written: [] });
  return {
    host: new CloudflareScopeHost({ scope: env.TELEMETRY_BROKER_SCOPE, controlPlane: env.CONTROL_PLANE }),
    written: () => state.written,
    refuseHandoffs: (n) => void (state.refusals = n),
    failDeliveries: (n) => void (state.failures = n),
    retryHandoffs: async (_t, s: ScopeId) => {
      const stub = env.TELEMETRY_BROKER_SCOPE.get(env.TELEMETRY_BROKER_SCOPE.idFromName(s));
      await runInDurableObject(stub, async (_i, st) => {
        const h = await st.storage.get<HandoffState>(DELIVERY_HANDOFF_KEY);
        if (h?.due !== undefined) await st.storage.put(DELIVERY_HANDOFF_KEY, { ...h, due: Date.now() - 1 });
      });
      await runDurableObjectAlarm(stub);
    },
    deliverDue: (t) =>
      runInDurableObject(brokerStub(env.TELEMETRY_DELIVERY_BROKER, t), (instance) =>
        (instance as unknown as TelemetryDeliveryBrokerDO).drive(),
      ),
    brokerState: (t) => (brokerStub(env.TELEMETRY_DELIVERY_BROKER, t) as unknown as DeliveryBrokerRpc).state(),
    cleanup: async () => {},
  };
});

describe('broker telemetry off (#3474): adapter-cloudflare', () => {
  it('a broker whose script binds no dataset answers no state', async () => {
    const t = tenantId.parse(ulid());
    expect(await (brokerStub(env.TEST_DELIVERY_BROKER, t) as unknown as DeliveryBrokerRpc).state()).toBeNull();
  });
});
