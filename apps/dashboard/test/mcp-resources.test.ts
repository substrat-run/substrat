import { describe, expect, it } from 'vitest';
import { SHARED_ISSUER_CONFIG_KEY, mcpResourceOf, scopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import {
  McpReconcileGate,
  isSharedIssuer,
  issuerFor,
  logUnsettled,
  mcpResourcesFor,
  reconcileConverged,
  reconcileMcpResources,
  teamIssuers,
} from '../src/mcp-resources.js';
import type { DashboardAppRow } from '../src/module.js';

/**
 * Registering a vertical's MCP endpoint at its team auth-server (#1619) — the dashboard's
 * half. The auth-server's half, which turns a delivery into rows and is proven against a
 * real client and the real vertical mount, is `demos/auth-server/test/mcp-resources.test.ts`.
 *
 * What is pinned here is what the dashboard decides: which strings an app IS, which issuer
 * its stored identity names, and that the Apps list's reconcile converges every app onto
 * exactly one registration, repeatably.
 */

const row = (over: Partial<DashboardAppRow>): DashboardAppRow =>
  ({
    id: ulid(),
    app_scope_id: scopeId.parse(ulid()),
    vertical_slug: 'ticket0',
    name: 'App',
    status: 'active',
    hostname: null,
    created_at: '2026-09-01T00:00:00.000Z',
    ...over,
  }) as DashboardAppRow;

describe('the resources an app is', () => {
  it('is one MCP endpoint per hostname it actively answers on, through the shared computation', () => {
    expect(
      mcpResourcesFor([
        { hostname: 'desk-acme.global.substrat.run', status: 'active' },
        { hostname: 'support.acme.example', status: 'active' },
        { hostname: 'pending.acme.example', status: 'pending' },
        { hostname: 'desk-acme.global.substrat.run', status: 'active' },
      ]),
    ).toEqual([mcpResourceOf('https://desk-acme.global.substrat.run'), mcpResourceOf('https://support.acme.example')]);
    // The string itself — what the vertical publishes on that hostname.
    expect(mcpResourceOf('https://support.acme.example')).toBe('https://support.acme.example/api/mcp');
  });

  it('is nothing for an app with no live hostname', () => {
    expect(mcpResourcesFor([{ hostname: 'x.example', status: 'failed' }])).toEqual([]);
  });
});

describe('which team auth-server a stored identity names', () => {
  const auth = row({ vertical_slug: 'auth-server', hostname: 'auth-acme.global.substrat.run' });
  const isIssuer = (a: DashboardAppRow) => a.vertical_slug === 'auth-server';
  const noLive = { listHostnames: async () => [] };

  it('matches the issuer the dashboard wrote for it', async () => {
    const [issuer] = await teamIssuers([auth], isIssuer, noLive);
    expect(issuerFor('https://auth-acme.global.substrat.run', [issuer!])?.scopeId).toBe(auth.app_scope_id);
    expect(issuerFor('https://auth-acme.global.substrat.run/', [issuer!])?.scopeId).toBe(auth.app_scope_id);
  });

  it('matches nothing for an issuer outside the team, or none at all', async () => {
    const issuers = await teamIssuers([auth], isIssuer, noLive);
    expect(issuerFor('https://login.example.com', issuers)).toBeUndefined();
    expect(issuerFor(null, issuers)).toBeUndefined();
    expect(issuerFor('not a url', issuers)).toBeUndefined();
    // Same host on another scheme is another origin.
    expect(issuerFor('http://auth-acme.global.substrat.run', issuers)).toBeUndefined();
  });

  /**
   * The stored hostname is an install-time snapshot and can be null while the router serves
   * the app. An auth-server found only through it would drop out of every registration.
   */
  it('finds an auth-server whose stored hostname is null but whose routing is live', async () => {
    const unstored = row({ vertical_slug: 'auth-server', hostname: null });
    const issuers = await teamIssuers([unstored], isIssuer, {
      listHostnames: async () => [
        { hostname: 'auth-acme.global.substrat.run', status: 'active' } as never,
        { hostname: 'login.acme.example', status: 'active' } as never,
      ],
    });
    // Every hostname it answers on is an origin its issuer URL may carry, custom domain too.
    expect(issuerFor('https://auth-acme.global.substrat.run', issuers)?.scopeId).toBe(unstored.app_scope_id);
    expect(issuerFor('https://login.acme.example', issuers)?.scopeId).toBe(unstored.app_scope_id);
  });

  it('falls back to the stored hostname when the live read fails', async () => {
    const issuers = await teamIssuers([auth], isIssuer, {
      listHostnames: async () => {
        throw new Error('control plane unreachable');
      },
    });
    expect(issuerFor('https://auth-acme.global.substrat.run', issuers)?.scopeId).toBe(auth.app_scope_id);
  });
});

describe('the Apps list reconcile (existing installs)', () => {
  const authA = row({ vertical_slug: 'auth-server', hostname: 'auth-a.global.substrat.run' });
  const authB = row({ vertical_slug: 'auth-server', hostname: 'auth-b.global.substrat.run' });
  const desk = row({ hostname: 'desk-acme.global.substrat.run' });
  const builtin = row({ hostname: 'crm-acme.global.substrat.run' });
  const failed = row({ status: 'failed' });
  const identities: Record<string, string | null> = {
    [desk.app_scope_id]: 'https://auth-a.global.substrat.run',
    [builtin.app_scope_id]: null,
    [authA.app_scope_id]: null,
    [authB.app_scope_id]: null,
  };
  const DESK_RESOURCE = mcpResourceOf('https://desk-acme.global.substrat.run');

  function harness(opts: { unreadable?: string; downIssuer?: string; apps?: DashboardAppRow[]; live?: Record<string, string[]> } = {}) {
    const deliveries: Array<{ scopeId: string; key: string; value: string }> = [];
    const live: Record<string, string[]> = opts.live ?? {
      [desk.app_scope_id]: ['desk-acme.global.substrat.run'],
      [builtin.app_scope_id]: ['crm-acme.global.substrat.run'],
    };
    const run = () =>
      reconcileMcpResources({
        apps: opts.apps ?? [authA, authB, desk, builtin, failed],
        isIssuer: (a) => a.vertical_slug === 'auth-server',
        issuerOf: async (id) => {
          if (id === opts.unreadable) throw new Error('forbidden: dashboard:read');
          return identities[id] ?? null;
        },
        controlPlane: {
          listHostnames: async (id) => (live[id] ?? []).map((hostname) => ({ hostname, status: 'active' }) as never),
          configureInstance: async (sid, entries) => {
            if (sid === opts.downIssuer) throw new Error('issuer unreachable');
            for (const e of entries) deliveries.push({ scopeId: sid, ...e });
          },
        },
      });
    return { run, deliveries };
  }

  it('registers an app at the issuer its identity names, and clears it at every other one', async () => {
    const { run, deliveries } = harness();
    const outcomes = await run();

    expect(deliveries).toContainEqual({
      scopeId: authA.app_scope_id,
      key: `substrat:resources:${desk.app_scope_id}`,
      value: JSON.stringify([DESK_RESOURCE]),
    });
    expect(deliveries).toContainEqual({ scopeId: authB.app_scope_id, key: `substrat:resources:${desk.app_scope_id}`, value: '' });
    expect(outcomes).toContainEqual({
      appScopeId: desk.app_scope_id,
      registeredAt: authA.app_scope_id,
      resources: [DESK_RESOURCE],
      clearedAt: [authB.app_scope_id],
      failed: [],
      sharedIssuer: true,
      markerFailed: null,
    });
    expect(reconcileConverged(outcomes)).toBe(true);
  });

  /** One unreachable issuer must not stop the app converging at the one it signs in with. */
  it('still registers at the healthy issuer when another issuer fails, and reports the failure', async () => {
    const { run, deliveries } = harness({ downIssuer: authB.app_scope_id });
    const outcomes = await run();

    expect(deliveries).toContainEqual({
      scopeId: authA.app_scope_id,
      key: `substrat:resources:${desk.app_scope_id}`,
      value: JSON.stringify([DESK_RESOURCE]),
    });
    expect(outcomes).toContainEqual({
      appScopeId: desk.app_scope_id,
      registeredAt: authA.app_scope_id,
      resources: [DESK_RESOURCE],
      clearedAt: [],
      failed: [{ issuerScopeId: authB.app_scope_id, reason: 'issuer unreachable' }],
      sharedIssuer: true,
      markerFailed: null,
    });
    // And the pass says so, so its gate runs it again rather than marking it done.
    expect(reconcileConverged(outcomes)).toBe(false);
  });

  it('still clears at the other issuers when the registration itself fails', async () => {
    const { run, deliveries } = harness({ downIssuer: authA.app_scope_id });
    const outcomes = await run();
    expect(deliveries).toContainEqual({ scopeId: authB.app_scope_id, key: `substrat:resources:${desk.app_scope_id}`, value: '' });
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        appScopeId: desk.app_scope_id,
        registeredAt: null,
        clearedAt: [authB.app_scope_id],
        failed: [{ issuerScopeId: authA.app_scope_id, reason: 'issuer unreachable' }],
      }),
    );
  });

  it('converges an install bound to an auth-server whose stored hostname is null', async () => {
    const unstored = row({ vertical_slug: 'auth-server', hostname: null });
    const bound = row({ hostname: 'desk-acme.global.substrat.run' });
    identities[bound.app_scope_id] = 'https://auth-a.global.substrat.run';
    const { run, deliveries } = harness({
      apps: [unstored, bound],
      live: {
        [unstored.app_scope_id]: ['auth-a.global.substrat.run'],
        [bound.app_scope_id]: ['desk-acme.global.substrat.run'],
      },
    });
    await run();
    // Order-free: the two go out concurrently.
    expect(deliveries).toHaveLength(2);
    expect(deliveries).toEqual(
      expect.arrayContaining([
        { scopeId: unstored.app_scope_id, key: `substrat:resources:${bound.app_scope_id}`, value: JSON.stringify([DESK_RESOURCE]) },
        { scopeId: bound.app_scope_id, key: SHARED_ISSUER_CONFIG_KEY, value: 'true' },
      ]),
    );
  });

  /**
   * The heal for #1683. An install made before the shared-issuer marker existed signs in at
   * a team auth-server and accepts any bearer that issuer signed. Nothing reconfigures it
   * by hand, so this pass has to be what tells it — to the app's own scope, the key alone,
   * never `substrat:auth` (which would mean reading back the client secret).
   */
  it('tells an existing team install that its issuer is shared (#1683)', async () => {
    const { run, deliveries } = harness();
    const outcomes = await run();
    const toDesk = deliveries.filter((d) => d.scopeId === desk.app_scope_id);
    expect(toDesk).toEqual([{ scopeId: desk.app_scope_id, key: SHARED_ISSUER_CONFIG_KEY, value: 'true' }]);
    expect(outcomes).toContainEqual(expect.objectContaining({ appScopeId: desk.app_scope_id, sharedIssuer: true }));
  });

  it('marks an install whose identity names some other issuer as NOT shared, and one with no identity not at all', async () => {
    const external = row({ hostname: 'ops-acme.global.substrat.run' });
    identities[external.app_scope_id] = 'https://login.example-idp.test';
    const { run, deliveries } = harness({ apps: [authA, external, builtin] });
    const outcomes = await run();
    // Cleared rather than left alone: an Identity change away from a team issuer whose
    // own delivery did not land is repaired here.
    expect(deliveries.filter((d) => d.scopeId === external.app_scope_id)).toEqual([
      { scopeId: external.app_scope_id, key: SHARED_ISSUER_CONFIG_KEY, value: '' },
    ]);
    expect(outcomes).toContainEqual(expect.objectContaining({ appScopeId: external.app_scope_id, sharedIssuer: false }));
    // No stored identity: nothing delivered, since its deployment may store no config.
    expect(deliveries.some((d) => d.scopeId === builtin.app_scope_id)).toBe(false);
    expect(outcomes).toContainEqual(expect.objectContaining({ appScopeId: builtin.app_scope_id, sharedIssuer: null }));
  });

  it('is not converged while the marker has not landed, so the next load tries again', async () => {
    const { run } = harness({ downIssuer: desk.app_scope_id });
    const outcomes = await run();
    expect(outcomes).toContainEqual(
      expect.objectContaining({ appScopeId: desk.app_scope_id, sharedIssuer: null, markerFailed: 'issuer unreachable' }),
    );
    expect(reconcileConverged(outcomes)).toBe(false);
  });

  it('registers an app with no team issuer nowhere, and clears it everywhere', async () => {
    const { run, deliveries } = harness();
    await run();
    const forBuiltin = deliveries.filter((d) => d.key === `substrat:resources:${builtin.app_scope_id}`);
    expect(forBuiltin).toEqual([
      { scopeId: authA.app_scope_id, key: `substrat:resources:${builtin.app_scope_id}`, value: '' },
      { scopeId: authB.app_scope_id, key: `substrat:resources:${builtin.app_scope_id}`, value: '' },
    ]);
  });

  it('leaves the issuers themselves and apps that are not live alone', async () => {
    const { run, deliveries } = harness();
    await run();
    for (const skipped of [authA, authB, failed]) {
      expect(deliveries.some((d) => d.key === `substrat:resources:${skipped.app_scope_id}`)).toBe(false);
    }
  });

  it('is repeatable: a second pass delivers exactly what the first did', async () => {
    const { run, deliveries } = harness();
    await run();
    const first = [...deliveries];
    deliveries.length = 0;
    await run();
    expect(deliveries).toEqual(first);
  });

  it('skips an app whose identity cannot be read, still converges the rest, and is not done', async () => {
    const { run, deliveries } = harness({ unreadable: desk.app_scope_id });
    const outcomes = await run();
    expect(deliveries.some((d) => d.key === `substrat:resources:${desk.app_scope_id}`)).toBe(false);
    expect(outcomes).toContainEqual({ appScopeId: desk.app_scope_id, skipped: 'forbidden: dashboard:read' });
    expect(deliveries.some((d) => d.key === `substrat:resources:${builtin.app_scope_id}`)).toBe(true);
    expect(reconcileConverged(outcomes)).toBe(false);
  });

  /**
   * A team with no auth-server is a real, empty answer, and the walk still runs on it
   * (#1683): nothing is registered anywhere, but an app that once signed in at a team
   * issuer — since switched to an outside one, or whose team deleted that issuer — must be
   * told its issuer is no longer shared, or its stale `"true"` stands.
   */
  it('for a team with no auth-server, registers nothing and clears the marker on every app with an identity', async () => {
    const external = row({ hostname: 'ops-acme.global.substrat.run' });
    identities[external.app_scope_id] = 'https://login.example-idp.test';
    const deliveries: Array<{ scopeId: string; key: string; value: string }> = [];
    const out = await reconcileMcpResources({
      apps: [external, builtin],
      isIssuer: () => false,
      issuerOf: async (id) => identities[id] ?? null,
      controlPlane: {
        listHostnames: async () => {
          throw new Error('never asked');
        },
        configureInstance: async (sid, entries) => {
          for (const e of entries) deliveries.push({ scopeId: sid, ...e });
        },
      },
    });
    expect(deliveries).toEqual([{ scopeId: external.app_scope_id, key: SHARED_ISSUER_CONFIG_KEY, value: '' }]);
    expect(out).toContainEqual(expect.objectContaining({ appScopeId: external.app_scope_id, sharedIssuer: false }));
    expect(reconcileConverged(out)).toBe(true);
  });

  /**
   * The other empty: an auth-server EXISTS, but this pass cannot read where it answers (no
   * stored hostname, and the live read failed). Treating that as "no issuers" would tell
   * every app bound there that its issuer is not shared, and mark the pass converged, so
   * pre-marker installs stayed open for the life of the isolate. Nothing is delivered and
   * the next load tries again.
   */
  it('delivers nothing and is not converged while an auth-server cannot be located', async () => {
    const unstored = row({ vertical_slug: 'auth-server', hostname: null });
    const bound = row({ hostname: 'desk-acme.global.substrat.run' });
    identities[bound.app_scope_id] = 'https://auth-a.global.substrat.run';
    const deliveries: unknown[] = [];
    const out = await reconcileMcpResources({
      apps: [unstored, bound],
      isIssuer: (a) => a.vertical_slug === 'auth-server',
      issuerOf: async (id) => identities[id] ?? null,
      controlPlane: {
        listHostnames: async () => {
          throw new Error('control plane unreachable');
        },
        configureInstance: async (_sid, entries) => {
          deliveries.push(...entries);
        },
      },
    });
    expect(deliveries).toEqual([]);
    expect(out).toEqual([{ appScopeId: unstored.app_scope_id, skipped: 'auth-server hostnames could not be read' }]);
    expect(reconcileConverged(out)).toBe(false);
  });
});

describe('the one shared-issuer classification (#1683)', () => {
  const issuers = [{ scopeId: scopeId.parse(ulid()), origins: new Set(['https://auth-a.global.substrat.run']) }];

  it('is decided by the issuer: an external pick that IS a team auth-server is shared', () => {
    expect(isSharedIssuer({ source: 'external', issuer: 'https://auth-a.global.substrat.run' }, issuers)).toBe(true);
    expect(isSharedIssuer({ source: 'external', issuer: 'https://login.example-idp.test' }, issuers)).toBe(false);
    expect(isSharedIssuer({ source: 'auth-server', issuer: 'https://auth-a.global.substrat.run' }, [])).toBe(true);
    expect(isSharedIssuer({ issuer: null }, issuers)).toBe(false);
  });
});

describe('what a pass left undone is logged', () => {
  const app = scopeId.parse(ulid());
  const settled = { appScopeId: app, registeredAt: null, resources: [], clearedAt: [], failed: [], sharedIssuer: true, markerFailed: null };

  it('logs a marker-only failure — a security delivery that keeps failing must be visible', () => {
    const logged: string[] = [];
    const unsettled = logUnsettled('tenant-a', [{ ...settled, sharedIssuer: null, markerFailed: 'scope unreachable' }], (m, d) =>
      logged.push(`${m} ${d}`),
    );
    expect(unsettled).toHaveLength(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('shared-issuer marker');
    expect(logged[0]).toContain('scope unreachable');
  });

  it('stays quiet for a pass that settled everything', () => {
    const logged: string[] = [];
    expect(logUnsettled('tenant-a', [settled], (m) => logged.push(m))).toEqual([]);
    expect(logged).toEqual([]);
  });
});

describe('the gate the Apps list runs the reconcile through', () => {
  const team = scopeId.parse(ulid());

  /** Keyed by team: the second member's load finds the first member's pass already done. */
  it('runs one pass for a team however many of its members load the list', async () => {
    const gate = new McpReconcileGate();
    let passes = 0;
    const pass = async () => {
      passes++;
      return true;
    };
    // An owner's load, then a viewer's: the worker hands the gate the TEAM, never the member.
    await gate.run(team, pass);
    expect(gate.run(team, pass)).toBeNull();
    expect(passes).toBe(1);
    // Another team is another pass.
    await gate.run(scopeId.parse(ulid()), pass);
    expect(passes).toBe(2);
  });

  it('does not start a second pass while one is still running', async () => {
    const gate = new McpReconcileGate();
    let release!: () => void;
    let passes = 0;
    const first = gate.run(team, () => {
      passes++;
      return new Promise<boolean>((resolve) => (release = () => resolve(true)));
    });
    expect(gate.run(team, async () => (passes++, true))).toBeNull();
    release();
    await first;
    expect(passes).toBe(1);
  });

  it('runs again on the next load after a pass that threw, and stops once one converges', async () => {
    const gate = new McpReconcileGate();
    let passes = 0;
    await expect(
      gate.run(team, async () => {
        passes++;
        throw new Error('catalog unreachable');
      }),
    ).rejects.toThrow('catalog unreachable');
    await gate.run(team, async () => (passes++, true));
    expect(passes).toBe(2);
    expect(gate.run(team, async () => (passes++, true))).toBeNull();
    expect(passes).toBe(2);
  });

  it('runs again after a pass that finished but left a delivery undone', async () => {
    const gate = new McpReconcileGate();
    let passes = 0;
    await gate.run(team, async () => (passes++, false));
    await gate.run(team, async () => (passes++, true));
    expect(gate.run(team, async () => (passes++, true))).toBeNull();
    expect(passes).toBe(2);
  });
});
