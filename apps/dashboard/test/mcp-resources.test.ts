import { describe, expect, it } from 'vitest';
import { mcpResourceOf, scopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { issuerAppFor, mcpResourcesFor, reconcileMcpResources } from '../src/mcp-resources.js';
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

  it('matches the issuer the dashboard wrote for it', () => {
    expect(issuerAppFor('https://auth-acme.global.substrat.run', [auth])).toBe(auth);
    expect(issuerAppFor('https://auth-acme.global.substrat.run/', [auth])).toBe(auth);
  });

  it('matches nothing for an issuer outside the team, or none at all', () => {
    expect(issuerAppFor('https://login.example.com', [auth])).toBeUndefined();
    expect(issuerAppFor(null, [auth])).toBeUndefined();
    expect(issuerAppFor('not a url', [auth])).toBeUndefined();
    // Same host on another scheme is another origin.
    expect(issuerAppFor('http://auth-acme.global.substrat.run', [auth])).toBeUndefined();
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

  function harness(opts: { unreadable?: string } = {}) {
    const deliveries: Array<{ scopeId: string; key: string; value: string }> = [];
    const run = () =>
      reconcileMcpResources({
        apps: [authA, authB, desk, builtin, failed],
        isIssuer: (a) => a.vertical_slug === 'auth-server',
        issuerOf: async (id) => {
          if (id === opts.unreadable) throw new Error('forbidden: dashboard:read');
          return identities[id] ?? null;
        },
        controlPlane: {
          listHostnames: async (id) =>
            id === desk.app_scope_id
              ? [{ hostname: 'desk-acme.global.substrat.run', status: 'active' } as never]
              : id === builtin.app_scope_id
                ? [{ hostname: 'crm-acme.global.substrat.run', status: 'active' } as never]
                : [],
          configureInstance: async (sid, entries) => {
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
      value: JSON.stringify([mcpResourceOf('https://desk-acme.global.substrat.run')]),
    });
    expect(deliveries).toContainEqual({ scopeId: authB.app_scope_id, key: `substrat:resources:${desk.app_scope_id}`, value: '' });
    expect(outcomes).toContainEqual({
      appScopeId: desk.app_scope_id,
      registeredAt: authA.app_scope_id,
      resources: [mcpResourceOf('https://desk-acme.global.substrat.run')],
      clearedAt: [authB.app_scope_id],
    });
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

  it('skips an app its caller may not read, and still converges the rest', async () => {
    const { run, deliveries } = harness({ unreadable: desk.app_scope_id });
    const outcomes = await run();
    expect(deliveries.some((d) => d.key === `substrat:resources:${desk.app_scope_id}`)).toBe(false);
    expect(outcomes).toContainEqual({ appScopeId: desk.app_scope_id, skipped: 'forbidden: dashboard:read' });
    expect(deliveries.some((d) => d.key === `substrat:resources:${builtin.app_scope_id}`)).toBe(true);
  });

  it('does nothing at all for a team with no auth-server', async () => {
    const out = await reconcileMcpResources({
      apps: [desk, builtin],
      isIssuer: () => false,
      issuerOf: async () => {
        throw new Error('never asked');
      },
      controlPlane: {
        listHostnames: async () => {
          throw new Error('never asked');
        },
        configureInstance: async () => {
          throw new Error('never asked');
        },
      },
    });
    expect(out).toEqual([]);
  });
});
