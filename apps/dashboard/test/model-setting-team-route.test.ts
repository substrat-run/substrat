import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { walkAll } from '../src/walk-all.js';

const shared = vi.hoisted(() => ({ host: null as unknown }));
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@substrat-run/adapter-cloudflare', () => ({
  defineScopeDO: () => class {}, defineScopeSweeperDO: () => class {},
  SCOPE_SWEEPER_NAME: 'scope-sweeper', ControlPlaneDO: class {},
  CloudflareScopeHost: class {
    constructor() {
      const target = shared.host as object;
      return new Proxy(target, {
        get(t, key) {
          if (key === 'registerModule' || key === 'registerExecutor') return () => undefined;
          const value = Reflect.get(t, key) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(t) : value;
        },
      });
    }
  },
}));
vi.mock('@substrat-run/oidc-rp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@substrat-run/oidc-rp')>()),
  mountOidcRoutes: () => undefined,
  verifySession: async (_env: unknown, token: string | undefined) => (token ? { id: token } : null),
}));

const { default: app } = (await import('../src/worker.js')) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

it('accepts priced models, rejects new unlisted ids, and preserves a stored unlisted value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-model-setting-'));
  const host = new SqliteScopeHost({ dir });
  shared.host = host;
  try {
    for (const module of MODULES) host.registerModule(module);
    const staff = platformActorId.parse(ulid());
    const team = tenantId.parse(ulid());
    const appScopeId = scopeId.parse(ulid());
    const vertical = 'acme/widgets';
    const sub = 'sub-owner';
    await host.admin.registerIdentityPool(staff, { provider: 'authhero', topology: 'central', tenantId: null });
    await host.admin.registerVertical(staff, {
      slug: vertical, name: 'Widgets', source: 'cli',
      envSpec: [{ key: 'MODEL', kind: 'model', description: 'Assistant model', required: false, secret: false }],
    });
    const node = await provisionDashboard(host, {
      tenantId: team, scopeId: scopeId.parse(ulid()), owner: principalId.parse(ulid()), slug: 'team', name: 'Team',
    });
    await host.admin.linkIdentity(staff, { provider: 'authhero', externalId: sub, principal: node.principal, tenantId: team, scopeId: node.scopeId });
    const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
    await dash.invoke('dashboard/provision-app', { appScopeId, verticalSlug: vertical, name: 'App' });
    const env = {
      SCOPE: {}, CONTROL_PLANE: {}, SESSION_SECRET: 'test-session-secret', CP_SERVICE_TOKEN: 'test-service-token',
      CONTROL_PLANE_SVC: { fetch: async () => Response.json({ detail: 'unavailable' }, { status: 501 }) },
    };
    const path = `/api/teams/${team}/apps/${appScopeId}/env`;
    const send = (method: string, value?: string) => app.request(path, {
      method,
      headers: { cookie: `sb_session=${sub}; sb_team=${team}`, 'content-type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify({ entries: [{ key: 'MODEL', value, secret: false }] }) }),
    }, env);
    const stored = async () => (await walkAll(dash, 'dashboard/list-app-env', { appScopeId }))[0]?.value;

    expect((await send('PUT', 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fp8')).status).toBe(200);
    expect(await stored()).toBe('cloudflare:@cf/meta/llama-3.1-8b-instruct-fp8');
    expect((await send('PUT', 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fast')).status).toBe(400);
    expect(await stored()).toBe('cloudflare:@cf/meta/llama-3.1-8b-instruct-fp8');

    // A row saved before the model kind existed remains visible and can be resubmitted unchanged.
    await dash.invoke('dashboard/set-app-env', {
      appScopeId, entries: [{ key: 'MODEL', value: 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fast', secret: false }],
    });
    expect((await send('GET')).status).toBe(200);
    expect(await stored()).toBe('cloudflare:@cf/meta/llama-3.1-8b-instruct-fast');
    expect((await send('PUT', 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fast')).status).toBe(200);
    expect(await stored()).toBe('cloudflare:@cf/meta/llama-3.1-8b-instruct-fast');
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
