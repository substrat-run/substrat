import { describe, expect, it } from 'vitest';
import { SCRIVE_CALLBACK_ROUTE, SCRIVE_CONNECTION_GRANTS } from '@substrat-run/connector-scrive';
import { FORTNOX_CONNECTION_GRANTS } from '@substrat-run/connector-fortnox';
import {
  CONNECTORS,
  connectionInspectorsFor,
  connectorGrantsFor,
  connectorSweepersFor,
} from '../src/connectors.js';

/**
 * The connector registry (#990).
 *
 * Wiring a connector used to be six hand edits scattered through `worker.ts`, five of
 * which are a silent no-op when forgotten — an unwired sweeper simply never polls, an
 * unwired inspector 501s, an undeclared grant heals nothing. So what this pins is not
 * "the registry has a scrive entry" but that **every derived surface is derived**: a
 * connector present in `CONNECTORS` appears in all of them, which is what makes the
 * second connector one entry rather than six.
 */
describe('connector registry', () => {
  const ENV = { SCRIVE_BASE_URL: 'https://api-testbed.scrive.test', PLATFORM_CP_URL: 'https://cp.test' };

  it('derives every wiring surface from the same array', () => {
    const providers = CONNECTORS.map((c) => c.provider);
    expect(providers).toContain('scrive');
    expect(providers).toContain('fortnox');
    expect(Object.keys(connectionInspectorsFor(ENV)).sort()).toEqual([...providers].sort());
    expect(Object.keys(connectorSweepersFor(ENV)).sort()).toEqual([...providers].sort());
    expect(Object.keys(connectorGrantsFor()).sort()).toEqual([...providers].sort());
    // A provider that is not registered is absent everywhere — the inspection route
    // 501s honestly rather than the plane pretending it operates it.
    expect(connectionInspectorsFor(ENV)['docusign']).toBeUndefined();
  });

  it('takes the declared grants from the connector, never a second list', () => {
    // The failure this reproduces (#716/#841): a hand-kept copy beside the connector
    // that drifted for months. `toBe` on the identity, not `toEqual` on the contents.
    expect(connectorGrantsFor()['scrive']).toBe(SCRIVE_CONNECTION_GRANTS);
    expect(connectorGrantsFor()['fortnox']).toBe(FORTNOX_CONNECTION_GRANTS);
  });

  it('a poll-only connector registers with no dispatch and no callback — by design, not omission', () => {
    // Fortnox (#1203): nothing inside a scope initiates a bookkeeping read, so there
    // is no dispatch handler to wire and no `connector:fortnox` intent kind to drain.
    // The registration is complete without them; what MUST be present is the sweep
    // (the whole trigger surface) and the inspection roles the console reads.
    const fortnox = CONNECTORS.find((c) => c.provider === 'fortnox')!;
    expect(fortnox.dispatch).toBeUndefined();
    expect(fortnox.callback).toBeUndefined();
    const inspector = connectionInspectorsFor({})['fortnox']!;
    expect(inspector.probe).toBeDefined();
    expect(inspector.activity).toBeDefined();
    expect(inspector.credential).toBeDefined();
    expect(inspector.probeCandidate).toBeDefined();
    expect(connectorSweepersFor({})['fortnox']).toBeDefined();
  });

  it('refuses a malformed Fortnox candidate without spending a provider round trip', async () => {
    const inspector = connectionInspectorsFor({})['fortnox']!;
    // No fetch is reachable here (the inspector got a real fetchImpl, but a malformed
    // credential must be refused before any call) — a throw would mean it tried.
    const probe = await inspector.probeCandidate!({ clientId: 'ci' });
    expect(probe.ok).toBe(false);
    expect(probe.refused).toBe(true);
    expect(probe.error).toMatch(/clientSecret/);
  });

  it('mounts each connector callback at the route the connector itself declares', () => {
    const scrive = CONNECTORS.find((c) => c.provider === 'scrive');
    expect(scrive?.callback?.route).toBe(SCRIVE_CALLBACK_ROUTE);
  });

  it('refuses to act with no provider base rather than defaulting to the testbed', async () => {
    // #610/#990: the old default sent a PRODUCTION credential to the testbed, which
    // answers 401 — indistinguishable from a mistyped key. A named throw is the whole
    // point, and it must fire on every role the connector plays, not just dispatch.
    const blank = {};
    const scrive = CONNECTORS.find((c) => c.provider === 'scrive')!;
    const inspector = connectionInspectorsFor(blank)['scrive']!;
    await expect(inspector.probeCandidate!({ clientId: 'ci' })).rejects.toThrow(/SCRIVE_BASE_URL/);
    // The sweeper and the dispatcher fail per CALL, never at wiring time: building the
    // drain's handler map or the sweep's sweeper map must not take the whole pass down
    // over one connector's unset var. So constructing them is fine…
    const sweeper = scrive.sweep(blank);
    const dispatcher = scrive.dispatch!(blank);
    // …and using them is what refuses.
    await expect(
      sweeper(null as never, 'con_x' as never, { fetch: null as never }),
    ).rejects.toThrow(/SCRIVE_BASE_URL/);
    await expect(dispatcher(null as never, null as never)).rejects.toThrow(/SCRIVE_BASE_URL/);
  });
});
