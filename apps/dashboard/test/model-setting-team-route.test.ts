import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId, toProblem } from '@substrat-run/contracts';
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

const LISTED = 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fp8';
const UNLISTED = 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fast';
/** The problem document minus what differs per request. */
const problemOf = (body: Record<string, unknown>) => {
  const { instance: _instance, requestId: _requestId, ...rest } = body;
  return rest;
};

it('holds every write of a model setting to the catalog, with one problem document', async () => {
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
    const request = (method: string, path: string, body?: unknown) => app.request(`/api/teams/${team}${path}`, {
      method,
      headers: { cookie: `sb_session=${sub}; sb_team=${team}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, env);
    const put = (value: string, scope: string = appScopeId) =>
      request('PUT', `/apps/${scope}/env`, { entries: [{ key: 'MODEL', value, secret: false }] });
    const stored = async (scope: string = appScopeId) =>
      (await walkAll(dash, 'dashboard/list-app-env', { appScopeId: scope })).find((v) => v.key === 'MODEL')?.value;
    /** The module operation, reached directly and naming no model key. */
    const direct = async (scope: string, value: string) => {
      try {
        await dash.invoke('dashboard/set-app-env', { appScopeId: scope, modelKeys: [], entries: [{ key: 'MODEL', value, secret: false }] });
        return null;
      } catch (err) {
        return problemOf(toProblem(err) as unknown as Record<string, unknown>);
      }
    };

    // A row saved before the model kind existed (nothing remembered yet) stays readable and can
    // be resubmitted unchanged through the Environment tab.
    expect(await direct(appScopeId, UNLISTED)).toBeNull();
    expect((await put(UNLISTED)).status).toBe(200);
    expect(await stored()).toBe(UNLISTED);

    // The Environment tab: a listed model saves; a new unlisted one is refused.
    expect((await put(LISTED)).status).toBe(200);
    expect(await stored()).toBe(LISTED);
    const refusedPut = await put(UNLISTED);
    expect(refusedPut.status).toBe(400);
    const expected = problemOf((await refusedPut.json()) as Record<string, unknown>);
    expect(expected).toMatchObject({ code: 'validation_failed', detail: 'MODEL must be a listed model' });
    expect(await stored()).toBe(LISTED);

    // The module operation reached directly, naming no model key: the app remembered MODEL from the
    // Environment write, so the same refusal answers.
    expect(await direct(appScopeId, UNLISTED)).toEqual(expected);
    expect(await stored()).toBe(LISTED);

    // The install form: an unlisted model is refused before anything is recorded.
    const before = (await walkAll(dash, 'dashboard/list-apps', {})).length;
    const refusedInstall = await request('POST', '/apps', { verticalSlug: vertical, name: 'Second', config: { MODEL: UNLISTED } });
    expect(refusedInstall.status).toBe(400);
    expect(problemOf((await refusedInstall.json()) as Record<string, unknown>)).toEqual(expected);
    expect((await walkAll(dash, 'dashboard/list-apps', {})).length).toBe(before);

    // An install that sets no model at all still records the vertical's model keys with the app, so a
    // direct write to that app later is held to the catalog too. (The plane here refuses the
    // provisioning itself; the record and its keys are written first.)
    await request('POST', '/apps', { verticalSlug: vertical, name: 'Third' });
    const third = (await walkAll(dash, 'dashboard/list-apps', {})).find((a) => a.name === 'Third');
    expect(third).toBeDefined();
    expect(await direct(third!.app_scope_id, UNLISTED)).toEqual(expected);
    expect(await stored(third!.app_scope_id)).toBeUndefined();

    // The install form's picker reads the same catalog.
    const catalog = (await (await request('GET', '/model-catalog')).json()) as Array<{ id: string }>;
    expect(catalog.map((m) => m.id)).toContain(LISTED);
    expect(catalog.map((m) => m.id)).not.toContain(UNLISTED);
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
