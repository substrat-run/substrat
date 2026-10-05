import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';

/**
 * The Findings routes ask WHO inside the team is calling (#1748).
 *
 * The control plane confines the dashboard's credential to the team; it cannot tell the people
 * in it apart. So reading the inbox needs `dashboard:read-findings` and acting on it needs
 * `dashboard:manage-findings`, both checked in the dashboard's own scope before the plane is
 * asked anything. These drive the WORKER, for the reason `deployments-role-gate.test.ts`
 * gives: the fact under test is that each route calls its gate.
 */

// The mocks are hoisted above the imports; the host they hand out is set per test.
const shared = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@substrat-run/adapter-cloudflare', () => ({
  defineScopeDO: () => class {},
  defineScopeSweeperDO: () => class {},
  SCOPE_SWEEPER_NAME: 'scope-sweeper',
  ControlPlaneDO: class {},
  // `hostFor` builds one per request and registers the modules on it; the shared SQLite
  // host already carries them, so registration is the one call that must not repeat.
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
  // The session cookie carries the OIDC `sub` directly; an empty one is no session.
  verifySession: async (_env: unknown, token: string | undefined) => (token ? { id: token } : null),
}));

// Named through a variable on purpose: `tsconfig.json` EXCLUDES `src/worker.ts` (it is
// typechecked by `tsconfig.worker.json`, where declaration emit is off), and a literal
// specifier would pull it back into the config that cannot compile it.
const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const PROVIDER = 'authhero';
const staff = platformActorId.parse(ulid());

describe('the /api/findings routes ask the caller’s permission (#1748)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const otherTenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  /** EVERY request that reached the plane — a refused route leaves this empty. */
  let planeCalls: string[];
  let env: Record<string, unknown>;

  /** One login per role, plus a linked person holding no role at all. */
  const subs = { owner: 'sub-owner', member: 'sub-member', viewer: 'sub-viewer', nobody: 'sub-nobody' } as const;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-findings-role-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    planeCalls = [];

    const owner = principalId.parse(ulid());
    await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'roles', name: 'Roles' });
    await host.admin.createTenant(staff, { id: otherTenant, slug: 'elsewhere', name: 'Elsewhere' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    const link = (sub: string, principal: typeof owner) =>
      host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: sub, principal, tenantId: tenant, scopeId: dashScope });
    await link(subs.owner, owner);
    for (const role of ['member', 'viewer'] as const) {
      const p = principalId.parse(ulid());
      await host.admin.assignRole(staff, { principalId: p, roleKey: role, node: { tenantId: tenant, scopeId: null } });
      await link(subs[role], p);
    }
    await link(subs.nobody, principalId.parse(ulid()));

    // One finding on this team and one on another, both from ops failures.
    for (const t of [tenant, otherTenant]) {
      await host.admin.recordOpsFailure({ actor: staff, operation: `deploy.${t === tenant ? 'mine' : 'theirs'}`, tenantId: t, message: 'x' });
    }

    const plane = tenantPlane(host, staff);
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: SERVICE_TOKEN,
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          const path = u.pathname.replace(/^\/api/, '') + u.search;
          planeCalls.push(`${init?.method ?? 'GET'} ${path}`);
          return plane.request(path, init);
        },
      },
    };
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const asRole = (role: keyof typeof subs, method: string, path: string, body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: { cookie: `sb_session=${subs[role]}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );

  const myFinding = async () => (await host.admin.listFindings(staff, { tenantId: tenant }))[0]!;
  const rule = () => ({ operation: 'deploy.mine', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'known' });

  async function refused(role: keyof typeof subs, method: string, path: string, body?: unknown) {
    const res = await asRole(role, method, path, body);
    expect(res.status, `${role}: ${method} ${path}`).toBe(403);
    // Refused BEFORE the plane was contacted at all.
    expect(planeCalls).toEqual([]);
  }

  it('reads: every role holding read-findings sees this team’s findings and only them', async () => {
    for (const role of ['owner', 'member', 'viewer'] as const) {
      const res = await asRole(role, 'GET', '/api/findings');
      expect(res.status, role).toBe(200);
      const body = (await res.json()) as { available: boolean; entries: { tenantId: string; operation: string }[] };
      expect(body.available).toBe(true);
      expect(body.entries.map((f) => [f.tenantId, f.operation])).toEqual([[tenant, 'deploy.mine']]);
    }
  });
  it('reads: a person with no role is refused the inbox and its rules', async () => {
    await refused('nobody', 'GET', '/api/findings');
    await refused('nobody', 'GET', '/api/findings/rules');
  });

  it('verdicts: a viewer cannot acknowledge, resolve or reopen, and nothing moves', async () => {
    const f = await myFinding();
    await refused('viewer', 'PUT', `/api/findings/${f.id}/status`, { status: 'resolved' });
    expect((await myFinding()).status).toBe('open');
  });
  it('verdicts: a member and an owner can', async () => {
    const f = await myFinding();
    for (const [role, status] of [
      ['member', 'acked'],
      ['owner', 'resolved'],
    ] as const) {
      const res = await asRole(role, 'PUT', `/api/findings/${f.id}/status`, { status });
      expect(res.status, role).toBe(200);
      expect((await myFinding()).status).toBe(status);
    }
  });

  it('rules: a viewer cannot suppress or revoke, and nothing is suppressed', async () => {
    await refused('viewer', 'POST', '/api/findings/rules', rule());
    await refused('viewer', 'DELETE', `/api/findings/rules/${ulid()}`);
    expect((await myFinding()).status).toBe('open');
  });
  it('rules: a member can suppress, and revoke what they suppressed', async () => {
    const res = await asRole('member', 'POST', '/api/findings/rules', rule());
    expect(res.status).toBe(201);
    const { rule: created } = (await res.json()) as { rule: { id: string } };
    expect((await myFinding()).status).toBe('suppressed');
    expect((await asRole('member', 'DELETE', `/api/findings/rules/${created.id}`)).status).toBe(200);
    expect((await host.admin.listFindingRules(staff, tenant, { active: true }))).toEqual([]);
  });
});
