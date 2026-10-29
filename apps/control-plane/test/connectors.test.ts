import type { ScopeHost } from '@substrat-run/kernel';
import { connectionId, permissionKey } from '@substrat-run/contracts';
import { describe, expect, it } from 'vitest';
import { SCRIVE_CALLBACK_ROUTE, SCRIVE_CONNECTION_GRANTS } from '@substrat-run/connector-scrive';
import { FORTNOX_CONNECTION_GRANTS } from '@substrat-run/connector-fortnox';
import { PLANIMA_CONNECTION_GRANTS } from '@substrat-run/connector-planima';
import {
  CONNECTORS,
  connectionBindersFor,
  connectionInspectorsFor,
  connectorGrantsFor,
  connectorSweepersFor,
  connectorSweepEveryMinutesFor,
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
    expect(providers).toContain('planima');
    expect(Object.keys(connectionInspectorsFor(ENV)).sort()).toEqual([...providers].sort());
    expect(Object.keys(connectorSweepersFor(ENV)).sort()).toEqual([...providers].sort());
    expect(Object.keys(connectorGrantsFor()).sort()).toEqual([...providers].sort());
    expect(connectorSweepEveryMinutesFor()).toEqual({ planima: 120 });
    // A provider that is not registered is absent everywhere — the inspection route
    // 501s honestly rather than the plane pretending it operates it.
    expect(connectionInspectorsFor(ENV)['docusign']).toBeUndefined();
  });

  it('preserves existing provider options on rebind without copying binding metadata', () => {
    const binder = connectionBindersFor(ENV)['planima']!;
    const current = {
      scopeId: 'scope', operation: 'maintenance/record-plan', permission: 'plan:record',
      organizationId: 42, currency: 'EUR', window: { fromYear: 2026, toYear: 2030 },
      horizonYears: 50, boundAt: '2026-10-20T00:00:00Z', lastSync: { hash: 'old' },
    };
    expect(binder.options!({ horizonYears: 10 }, current)).toEqual({
      organizationId: 42, currency: 'EUR', window: { fromYear: 2026, toYear: 2030 }, horizonYears: 10,
    });
    expect(binder.options!({ organizationId: null }, current)).toMatchObject({ organizationId: null });
    expect(() => binder.options!({ horizonYear: 10 }, current)).toThrow();
  });

  it('validates Fortnox landing kinds and rejects unknown options', () => {
    const options = connectionBindersFor(ENV)['fortnox']!.options!;
    expect(options(undefined)).toEqual({});
    expect(options({ kind: 'supplier-invoice' })).toEqual({ kind: 'supplier-invoice' });
    expect(() => options({ kind: 'future-kind' })).toThrow();
    expect(() => options({ typo: 'supplier-invoice' })).toThrow();
  });

  it('takes the declared grants from the connector, never a second list', () => {
    // The failure this reproduces (#716/#841): a hand-kept copy beside the connector
    // that drifted for months. `toBe` on the identity, not `toEqual` on the contents.
    expect(connectorGrantsFor()['scrive']).toBe(SCRIVE_CONNECTION_GRANTS);
    expect(connectorGrantsFor()['fortnox']).toBe(FORTNOX_CONNECTION_GRANTS);
    expect(connectorGrantsFor()['planima']).toBe(PLANIMA_CONNECTION_GRANTS);
  });

  it('every registered connector answers both probes', () => {
    // #1326. `ConnectionInspector` leaves them optional because a caller may find a
    // provider that has nothing to probe with; a connector on THIS fleet may not, and
    // `RegisteredConnectionInspector` is what refuses one at compile time. Asserted for
    // the whole array rather than per connector, because the failure being prevented is
    // an omission — planima shipped with both probes exported, a dashboard door in
    // front of them and no registration behind it, so the first tenant to press Test
    // connection got `501 no probe registered for provider 'planima'` and read it as
    // Planima being down. A per-connector test cannot catch the connector nobody added.
    const inspectors = connectionInspectorsFor({});
    for (const { provider } of CONNECTORS) {
      expect(typeof inspectors[provider]?.probe, provider).toBe('function');
      expect(typeof inspectors[provider]?.probeCandidate, provider).toBe('function');
    }
  });

  it('refuses a malformed Planima candidate without spending a provider round trip', async () => {
    // Planima's whole connect path is a pasted token, so this probe is the only thing
    // between a typo and a connection that looks healthy and syncs nothing.
    const probe = await connectionInspectorsFor({})['planima']!.probeCandidate!({});
    expect(probe.ok).toBe(false);
    expect(probe.refused).toBe(true);
    expect(probe.error).toMatch(/token/);
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

  it('Microsoft 365 dispatches channel-folder writes, sweeps the folder, and binds only with a folder (#2101)', async () => {
    const m365 = CONNECTORS.find((c) => c.provider === 'microsoft365')!;
    expect(m365.dispatch).toBeDefined();
    expect(m365.mail).toBeDefined();
    const inspector = connectionInspectorsFor({})['microsoft365']!;
    expect(inspector.bindings).toBeDefined();
    const target = { tenantId: '01JZ0000000000000000000002', scopeId: '01JZ0000000000000000000003', vertical: 'acme-crm', operation: 'docs/land', permission: 'docs:land' };
    // No folder is refused before anything is read — the host here has nothing to read.
    expect(() => inspector.bindScope!(null as never, { id: 'con_x' } as never, target)).toThrow(/channel folder/);
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

it('registered poll binding doors preserve the vertical landing configuration', async () => {
  const id = connectionId.parse('01JZ0000000000000000000001');
  const target = { tenantId: '01JZ0000000000000000000002', scopeId: '01JZ0000000000000000000003', vertical: 'acme-crm' };
  for (const [provider, operation, permission] of [['planima', 'maintenance/record-plan', 'plan:record'], ['fortnox', 'ledger/record-period', 'ledger:record']] as const) {
    const records = new Map<string, unknown>();
    const host = {
      connectionGrantsInScope: async () => [{ connectionId: id, permission: permissionKey.parse(permission) }],
      admin: {
        putConnectorState: async (_id: string, key: string, value: unknown) => { records.set(key, value); },
        listConnectorState: async (_id: string, prefix: string) => [...records].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      },
    } as unknown as ScopeHost;
    const row = { id } as Parameters<NonNullable<ReturnType<typeof connectionInspectorsFor>[string]['bindScope']>>[1];
    const inspector = connectionInspectorsFor({})[provider]!;
    const binding = await inspector.bindScope!(host, row, { ...target, operation: operation!, permission: permission!, ...(provider === 'planima' ? { organizationId: null, currency: 'SEK', window: null, horizonYears: 50 } : {}) });
    expect(binding).toMatchObject({ ...target, operation, permission });
    if (provider === 'planima') expect(binding).toMatchObject({ organizationId: null, currency: 'SEK', window: null, horizonYears: 50 });
    expect(await inspector.bindings!(host, row)).toEqual([binding]);
    expect(records.size).toBe(1);
  }
});

describe('connection binders (#2316)', () => {
  const ENV = { SCRIVE_BASE_URL: 'https://api-testbed.scrive.test', PLATFORM_CP_URL: 'https://cp.test' };
  it('binds from a declaration only for a provider whose inspector binds, with the door\'s options (#2316)', () => {
    const binders = connectionBindersFor(ENV);
    // Scrive is dispatched, not polled: nothing to bind, so a declaration for it binds nothing.
    expect(Object.keys(binders).sort()).toEqual(['fortnox', 'microsoft365', 'planima']);
    expect(binders['planima']!.options!({ organizationId: null, horizonYears: 50 })).toEqual({ organizationId: null, horizonYears: 50 });
    // The staff door's schema, strict: a typo'd option is refused rather than bound with a default.
    expect(() => binders['planima']!.options!({ horizonYear: 50 })).toThrow();
    expect(() => binders['fortnox']!.options!({ horizonYears: 50 })).toThrow();
    expect(binders['fortnox']!.options!(undefined)).toEqual({});
  });

  it('re-writes a Fortnox binding that does not carry its connection\'s company (#2316)', () => {
    const stale = connectionBindersFor(ENV)['fortnox']!.stale!;
    const binding = { scopeId: 's', operation: 'ledger/record-period', permission: 'ledger:record' };
    const row = { externalAccountRef: '111111' } as Parameters<typeof stale>[1];
    expect(stale(binding, row)).toBe(true);
    expect(stale({ ...binding, externalAccountRef: '111111' } as typeof binding, row)).toBe(false);
    expect(connectionBindersFor(ENV)['planima']!.stale).toBeUndefined();
  });
});
