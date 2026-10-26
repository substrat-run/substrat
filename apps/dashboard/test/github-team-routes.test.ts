import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { connectionId, platformActorId, principalId, scopeId, tenantId, type TenantId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';

/**
 * GitHub import takes its team from the request (#2170). The `sb_team` cookie is shared by
 * every tab, so a tab still showing team A whose cookie another tab moved to team B would
 * connect GitHub to B, list B's repos and wire a repo's CI to push into B.
 */

const shared = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@substrat-run/adapter-cloudflare', () => ({
  defineScopeDO: () => class {},
  defineScopeSweeperDO: () => class {},
  SCOPE_SWEEPER_NAME: 'scope-sweeper',
  ControlPlaneDO: class {},
  CloudflareScopeHost: class {
    constructor() {
      const target = shared.host as object;
      return new Proxy(target, {
        get(t, key) {
          if (key === 'registerModule' || key === 'registerExecutor') return () => undefined;
          const v = Reflect.get(t, key) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
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

// Named through a variable: `tsconfig.json` excludes `src/worker.ts` (see findings-role-gate.test.ts).
const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const PROVIDER = 'authhero';
const OWNER = 'sub-owner';
const staff = platformActorId.parse(ulid());

/** A GitHub App key GitHub would accept the JWT of: the stub never checks it, `crypto.subtle` must import it. */
async function appKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
}
const keyPem = await appKeyPem();

describe('GitHub import acts on the team the request names (#2170)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const teamA = tenantId.parse(ulid());
  const teamB = tenantId.parse(ulid());
  const stranger = tenantId.parse(ulid());
  let env: Record<string, unknown>;
  /** Every installation GitHub was asked for a token for, the tenants push tokens were minted for, and every repo link written. */
  let installations: string[];
  let minted: string[];
  let links: Array<{ tenantId: string; repo: string }>;

  /** A new team owned by the login `sub`; answers its dashboard scope. */
  const seat = async (team: TenantId, slug: string, sub = OWNER) => {
    const dash = scopeId.parse(ulid());
    const owner = principalId.parse(ulid());
    await provisionDashboard(host, { tenantId: team, scopeId: dash, owner, slug, name: slug });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: sub, principal: owner, tenantId: team, scopeId: dash });
    return dash;
  };
  let dashA: ReturnType<typeof scopeId.parse>;
  const connectGithub = (team: TenantId, installationId: string) =>
    host.admin.createConnection(staff, {
      id: connectionId.parse(ulid()),
      tenantId: team,
      vertical: 'dashboard',
      provider: 'github',
      label: `GitHub — ${installationId}`,
      externalAccountRef: `acct-${installationId}`,
      scopes: ['contents:read', 'metadata:read'],
      secret: { installationId },
      createdBy: staff,
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-github-team-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(1)) });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    // One person, owner of two teams, each with its own GitHub installation.
    dashA = await seat(teamA, 'team-a');
    await seat(teamB, 'team-b');
    await host.admin.createTenant(staff, { id: stranger, slug: 'stranger', name: 'Stranger' });
    await connectGithub(teamA, 'inst-a');
    await connectGithub(teamB, 'inst-b');
    installations = [];
    minted = [];
    links = [];

    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const token = /^\/app\/installations\/([^/]+)\/access_tokens$/.exec(path);
      if (token) {
        installations.push(token[1]!);
        return Response.json({ token: 'installation-token' });
      }
      const installation = /^\/app\/installations\/([^/]+)$/.exec(path);
      if (installation) return Response.json({ account: { login: `acct-${installation[1]}` } });
      if (path.endsWith('/actions/secrets/public-key')) return Response.json({ key: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))), key_id: 'k1' });
      if (path.includes('/actions/secrets/')) return new Response(null, { status: 201 });
      if (path.includes('/contents/')) return new Response(null, { status: init?.method === 'PUT' ? 201 : 404 });
      if (path === '/installation/repositories') return Response.json({ repositories: [] });
      return new Response('unexpected GitHub call', { status: 500 });
    });

    const plane = tenantPlane(host, staff);
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: SERVICE_TOKEN,
      CP_PUBLIC_URL: 'https://plane.test/api',
      GITHUB_APP_ID: '1',
      GITHUB_APP_SLUG: 'substrat-test',
      GITHUB_APP_PRIVATE_KEY: keyPem,
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          const path = u.pathname.replace(/^\/api/, '') + u.search;
          if (path === '/push-tokens') {
            const { tenantId: t } = JSON.parse(String(init?.body)) as { tenantId: string };
            minted.push(t);
            return Response.json({ token: 'push-token', tenantSlug: t === teamA ? 'team-a' : 'team-b' });
          }
          return plane.request(path, init);
        },
      },
      GITHUB_REPO_LINK: {
        idFromName: (name: string) => name,
        get: () => ({ setLink: async (link: { tenantId: string; repo: string }) => void links.push(link) }),
      },
    };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A request from a tab whose cookie another tab has since moved to `cookieTeam`. */
  const fromTab = (cookieTeam: TenantId, method: string, path: string, body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: { cookie: `sb_session=${OWNER}; sb_team=${cookieTeam}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );

  it('one-click CI set up from a tab on team A wires the repo to A, whichever team the cookie pins', async () => {
    const res = await fromTab(teamB, 'POST', `/api/teams/${teamA}/github/setup-ci`, { repo: 'acme/helpdesk', branch: 'main' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, vertical: 'team-a/helpdesk' });
    expect(installations).toEqual(['inst-a']);
    expect(minted).toEqual([teamA]);
    expect(links).toEqual([{ tenantId: teamA, slug: 'helpdesk', repo: 'acme/helpdesk' }]);
  });

  /** Nothing reached GitHub, the push-token mint or a repo link. */
  const untouched = () => {
    expect(installations).toEqual([]);
    expect(minted).toEqual([]);
    expect(links).toEqual([]);
  };

  it('a team the caller is not in is a 404, and nothing is minted or written', async () => {
    const res = await fromTab(teamA, 'POST', `/api/teams/${stranger}/github/setup-ci`, { repo: 'acme/helpdesk', branch: 'main' });
    expect(res.status).toBe(404);
    untouched();
  });

  it('the role is the one held in the path’s team: a viewer there is refused, though they own the cookie’s team', async () => {
    const twoHats = 'sub-two-hats';
    const teamC = tenantId.parse(ulid());
    await seat(teamC, 'team-c', twoHats);
    const viewerA = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: viewerA, roleKey: 'viewer', node: { tenantId: teamA, scopeId: null } });
    await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: twoHats, principal: viewerA, tenantId: teamA, scopeId: dashA });

    const res = await app.request(
      `/api/teams/${teamA}/github/setup-ci`,
      { method: 'POST', headers: { cookie: `sb_session=${twoHats}; sb_team=${teamC}`, 'content-type': 'application/json' }, body: JSON.stringify({ repo: 'acme/helpdesk', branch: 'main' }) },
      env,
    );
    expect(res.status).toBe(403);
    untouched();
  });

  it('the install callback connects the team its signed state names, and points the cookie back at it', async () => {
    const begun = await fromTab(teamA, 'POST', `/api/teams/${teamA}/github/connect`);
    expect(begun.status, await begun.clone().text()).toBe(200);
    const state = new URL(((await begun.json()) as { url: string }).url).searchParams.get('state')!;

    // While this tab was on GitHub, another switched the cookie to B.
    const res = await fromTab(teamB, 'GET', `/api/github/callback?installation_id=inst-new&state=${encodeURIComponent(state)}`);
    expect(res.status, await res.clone().text()).toBe(302);
    expect(res.headers.get('set-cookie')).toContain(`sb_team=${teamA}`);
    const accounts = async (team: TenantId) =>
      (await host.admin.listConnections(staff, { tenantId: team, vertical: 'dashboard', provider: 'github' })).map((x) => x.externalAccountRef).sort();
    expect(await accounts(teamA)).toEqual(['acct-inst-a', 'acct-inst-new']);
    expect(await accounts(teamB)).toEqual(['acct-inst-b']);
  });

  it('repos are listed from the path’s team’s GitHub account', async () => {
    const res = await fromTab(teamB, 'GET', `/api/teams/${teamA}/github/repos`);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ configured: true, connected: true, account: 'acct-inst-a', accounts: ['acct-inst-a'], repos: [] });
    expect(installations).toEqual(['inst-a']);
  });
});
