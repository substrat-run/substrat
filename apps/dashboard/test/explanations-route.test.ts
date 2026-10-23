import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId, type EmittedModel, type PrincipalId, type ScopeId } from '@substrat-run/contracts';
import { manualClock, ulid, type ManualClock, type OperationHandler } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { EXPLANATION_LIMITS } from '../src/module.js';
import { SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';

/**
 * AI-written text in the dashboard (#1749), end to end: the worker driven the way a request
 * reaches it, the real control plane over a SQLite host behind the service binding, and a
 * Workers AI binding that records what it was sent. What these pin is the wiring the pure
 * suite (`explain.test.ts`) cannot see:
 *
 * - each route asks its gate before the plane or the model is reached, and reads only this
 *   team's finding and this team's app;
 * - what reaches the model is the redacted allowlist, never a row;
 * - a page load never calls the model, a written text is filed and served from the team's
 *   scope, and newer evidence marks it as written against older data;
 * - a spent budget is refused BEFORE the model is called, so it costs nothing;
 * - with the flag off, nothing is offered and nothing is called.
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

// Named through a variable: `tsconfig.json` excludes `src/worker.ts` (findings-role-gate.test.ts says why).
const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const PROVIDER = 'authhero';
const staff = platformActorId.parse(ulid());
const SLUG = 'acme/desk';
const HOUR = 3_600_000;
const ANSWER = 'Uploads have failed three times since Monday. The refusals come from a supplier, not from your app.';

const MODEL: EmittedModel = {
  entities: {},
  lifecycles: {
    order: {
      field: 'state',
      initial: 'open',
      states: { open: { on: { 'desk/advance': 'shipped' } }, shipped: { terminal: true } },
    },
  },
};

const emitOrder = (ctx: Parameters<OperationHandler<never, unknown>>[0], id: string, state: string) =>
  ctx.emit({ type: 'order.moved', schemaVersion: 1, entity: { entityType: 'order', entityId: id }, piiClass: 'none', payload: { id, state } });
const openOrder = ((ctx, input: { id: string }) => emitOrder(ctx, input.id, 'open')) as OperationHandler<never, unknown>;
const advanceOrder = ((ctx, input: { id: string; to: string }) => emitOrder(ctx, input.id, input.to)) as OperationHandler<never, unknown>;

type View = {
  available: boolean;
  reason: string | null;
  disclosure: { vendor: string; location: string; sent: string } | null;
  explanation: { text: string; writtenAt: string; current: boolean; provenance: { summary: string; model: string; sources: { kind: string }[] } } | null;
  budget: { person: { used: number; limit: number }; team: { used: number; limit: number } } | null;
};

describe('AI-written text in the dashboard (#1749)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let clock: ManualClock;
  const tenant = tenantId.parse(ulid());
  const otherTenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  let appScope: ScopeId;
  let env: Record<string, unknown>;
  /** EVERY request that reached the plane — a refused route leaves this empty. */
  let planeCalls: string[];
  /** Every call the model binding received, with what it was sent. */
  let modelCalls: Array<{ model: string; inputs: unknown }>;
  const people: Record<'owner' | 'viewer' | 'nobody', PrincipalId> = {} as never;
  const subs = { owner: 'sub-owner', viewer: 'sub-viewer', nobody: 'sub-nobody' } as const;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-explanations-'));
    clock = manualClock(new Date());
    host = new SqliteScopeHost({ dir, clock: clock.read });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    host.defineOperation('desk/open', openOrder);
    host.defineOperation('desk/advance', advanceOrder);
    planeCalls = [];
    modelCalls = [];

    people.owner = principalId.parse(ulid());
    people.viewer = principalId.parse(ulid());
    people.nobody = principalId.parse(ulid());
    await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner: people.owner, slug: 'explain', name: 'Explain' });
    await host.admin.createTenant(staff, { id: otherTenant, slug: 'elsewhere', name: 'Elsewhere' });
    await host.admin.registerIdentityPool(staff, { provider: PROVIDER, topology: 'central', tenantId: null });
    await host.admin.assignRole(staff, { principalId: people.viewer, roleKey: 'viewer', node: { tenantId: tenant, scopeId: null } });
    for (const who of ['owner', 'viewer', 'nobody'] as const) {
      await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: subs[who], principal: people[who], tenantId: tenant, scopeId: dashScope });
    }

    // One app running a version that declares the `order` lifecycle.
    await host.admin.registerVertical(staff, { slug: SLUG, name: 'Desk', source: 'cli', ownerTenant: tenant });
    const version = ulid();
    await host.admin.publishVersion(staff, {
      id: version,
      verticalSlug: SLUG,
      version: '1.0.0',
      manifestDigest: 'manifest',
      permissionDigest: 'perm',
      migrationDigest: 'mig',
      deploymentRef: null,
      manifestJson: JSON.stringify({
        version: '1.0.0',
        entry: 'index.js',
        compatibilityDate: '2026-07-01',
        registry: { permissions: [], roles: [], entityGrants: [] },
        digests: { manifest: 'manifest', permission: 'perm', migration: 'mig' },
        model: MODEL,
      }),
    });
    await host.admin.admitVersion(staff, version);
    appScope = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: tenant, scopeId: appScope, vertical: SLUG });
    await host.admin.activateScope(staff, tenant, appScope);
    await (await host.getScope(people.owner, tenant, dashScope)).invoke('dashboard/provision-app', { appScopeId: appScope, verticalSlug: SLUG, name: 'Desk' });
    await host.admin.bindScopeVersion(staff, tenant, appScope, version);

    // A finding on this team, from failures whose messages carry a token and an address, and
    // one on another team.
    for (let i = 0; i < 3; i++) {
      await host.admin.recordOpsFailure({
        actor: staff,
        operation: 'deploy.upload',
        tenantId: tenant,
        scopeId: appScope,
        vertical: SLUG,
        origin: 'provider',
        status: 503,
        message: `upstream refused Bearer ${'tok' + 'en'}${'A1b2C3d4E5f6'} for ops@acme.example`,
      });
    }
    await host.admin.recordOpsFailure({ actor: staff, operation: 'deploy.theirs', tenantId: otherTenant, message: 'x' });

    const plane = tenantPlane(host, staff);
    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: SERVICE_TOKEN,
      AI_EXPLANATIONS: '1',
      AI: {
        run: async (model: string, inputs: unknown) => {
          modelCalls.push({ model, inputs });
          return { response: `## Summary\n${ANSWER}` };
        },
      },
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

  const as = (who: keyof typeof subs, method: string, path: string, body?: unknown) =>
    app.request(
      `/api/teams/${tenant}${path}`,
      {
        method,
        headers: { cookie: `sb_session=${subs[who]}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  const ok = async (res: Response | Promise<Response>): Promise<View> => {
    const r = await res;
    expect(r.status, await r.clone().text()).toBe(200);
    return (await r.json()) as View;
  };
  const myFinding = async () => (await host.admin.listFindings(staff, { tenantId: tenant }))[0]!;
  const theirFinding = async () => (await host.admin.listFindings(staff, { tenantId: otherTenant }))[0]!;
  const sent = () => JSON.stringify(modelCalls.map((c) => c.inputs));
  /** The facts the last call carried, parsed back out of its user message. */
  const sentFacts = (): Record<string, unknown> => {
    const { messages } = modelCalls.at(-1)!.inputs as { messages: { role: string; content: string }[] };
    return JSON.parse(messages.find((m) => m.role === 'user')!.content.replace(/^Facts:\n/, '')) as Record<string, unknown>;
  };

  describe('a finding’s explanation', () => {
    it('a page load reads the offer and the budget, and calls no model', async () => {
      const f = await myFinding();
      const view = await ok(as('viewer', 'GET', `/findings/${f.id}/explanation`));
      expect(view).toMatchObject({
        available: true,
        reason: null,
        explanation: null,
        budget: { person: { used: 0, limit: EXPLANATION_LIMITS.perPersonPerDay }, team: { used: 0, limit: EXPLANATION_LIMITS.perTeamPerDay } },
      });
      expect(view.disclosure!.sent).toContain('secrets and contact details removed');
      expect(modelCalls).toEqual([]);
    });

    it('writes once from the redacted evidence, files it, and serves the filed text without another call', async () => {
      const f = await myFinding();
      const written = await ok(as('viewer', 'POST', `/findings/${f.id}/explanation`));
      expect(modelCalls).toHaveLength(1);
      // Markdown is dropped before filing: the stored copy is the copy a person reads.
      expect(written.explanation).toMatchObject({ text: ANSWER, current: true });
      expect(written.explanation!.provenance.summary).toBe('3 failure records');
      expect(written.explanation!.provenance.sources.map((s) => s.kind)).toEqual(['finding', 'ops-failures']);
      expect(written.budget!.person.used).toBe(1);

      // What the model was sent: the facts, redacted, and no identifier of a tenant, scope or person.
      expect(sentFacts().failures).toMatchObject({ inWindow: 3, origins: { provider: 3 }, samples: ['upstream refused Bearer [secret] for [email]'] });
      for (const id of [tenant, dashScope, appScope, people.viewer, f.id]) expect(sent()).not.toContain(id);
      expect(sent()).not.toContain('ops@acme.example');

      const again = await ok(as('owner', 'GET', `/findings/${f.id}/explanation`));
      expect(again.explanation).toMatchObject({ text: ANSWER, current: true });
      expect(modelCalls).toHaveLength(1);
    });

    it('marks a filed text as written against older data once the finding moves', async () => {
      const f = await myFinding();
      await ok(as('viewer', 'POST', `/findings/${f.id}/explanation`));
      await host.admin.recordOpsFailure({ actor: staff, operation: 'deploy.upload', tenantId: tenant, scopeId: appScope, vertical: SLUG, origin: 'provider', status: 503, message: 'again' });
      const view = await ok(as('viewer', 'GET', `/findings/${f.id}/explanation`));
      expect(view.explanation).toMatchObject({ text: ANSWER, current: false });
    });

    it('a person without read-findings is refused both, before the plane or the model is asked', async () => {
      const f = await myFinding();
      planeCalls = [];
      for (const method of ['GET', 'POST']) {
        const res = await as('nobody', method, `/findings/${f.id}/explanation`);
        expect(res.status, method).toBe(403);
      }
      expect(planeCalls).toEqual([]);
      expect(modelCalls).toEqual([]);
    });

    it('another team’s finding is not found, and nothing is sent', async () => {
      const res = await as('owner', 'POST', `/findings/${(await theirFinding()).id}/explanation`);
      expect(res.status).toBe(404);
      expect(modelCalls).toEqual([]);
    });

    it('a spent budget is refused before the model is called', async () => {
      const dash = await host.getScope(people.viewer, tenant, dashScope);
      for (let i = 0; i < EXPLANATION_LIMITS.perPersonPerDay; i++) {
        await dash.invoke('dashboard/record-explanation', {
          subject: `finding:filler-${i}`,
          digest: '0'.repeat(64),
          text: 'filler',
          provenance: { writtenAt: clock.read(), model: 'm', since: 's', until: 'u', sources: [], summary: '' },
          model: 'cloudflare:@cf/x',
          usage: { inputTokens: 1, outputTokens: 1, listUsd: null },
        });
      }
      const f = await myFinding();
      const res = await as('viewer', 'POST', `/findings/${f.id}/explanation`);
      expect(res.status).toBe(429);
      expect(modelCalls).toEqual([]);
      // The owner's own allowance is untouched; the team's is not yet reached.
      const owner = await ok(as('owner', 'POST', `/findings/${f.id}/explanation`));
      expect(owner.budget).toMatchObject({ person: { used: 1 }, team: { used: EXPLANATION_LIMITS.perPersonPerDay + 1 } });
    });

    it('with the flag off, nothing is offered and nothing is called', async () => {
      env.AI_EXPLANATIONS = undefined;
      const f = await myFinding();
      expect(await ok(as('viewer', 'GET', `/findings/${f.id}/explanation`))).toEqual({
        available: false,
        reason: 'off',
        disclosure: null,
        explanation: null,
        budget: null,
      });
      expect((await as('viewer', 'POST', `/findings/${f.id}/explanation`)).status).toBe(409);
      expect(modelCalls).toEqual([]);
    });

    it('a model the deployment cannot run is said as such', async () => {
      env.AI_EXPLANATIONS_MODEL = 'nosuchprovider:model';
      const f = await myFinding();
      expect(await ok(as('viewer', 'GET', `/findings/${f.id}/explanation`))).toMatchObject({ available: false, reason: 'not-configured' });
    });
  });

  describe('the record in the team’s scope', () => {
    const record = (who: PrincipalId, subject: string, text = 'filed') =>
      host.getScope(who, tenant, dashScope).then((dash) =>
        dash.invoke('dashboard/record-explanation', {
          subject,
          digest: 'a'.repeat(64),
          text,
          provenance: { writtenAt: clock.read(), model: 'm', since: 's', until: 'u', sources: [], summary: '1 failure record' },
          model: 'cloudflare:@cf/x',
          usage: { inputTokens: 10, outputTokens: 5, listUsd: '0.0001' },
        }),
      );
    const budget = async (who: PrincipalId) => (await host.getScope(who, tenant, dashScope)).invoke('dashboard/explanation-budget', {});
    const newest = async (subject: string) =>
      ((await (await host.getScope(people.viewer, tenant, dashScope)).invoke('dashboard/get-explanation', { subject })) as { explanation: { text: string } | null }).explanation;

    it('dashboard/explanation-budget counts the caller’s own rows and the team’s, for today only', async () => {
      clock.set(new Date(Date.now() - 2 * 86_400_000));
      await record(people.viewer, 'finding:old');
      clock.set(new Date());
      await record(people.viewer, 'finding:a');
      await record(people.owner, 'finding:b');
      expect(await budget(people.viewer)).toEqual({
        person: { used: 1, limit: EXPLANATION_LIMITS.perPersonPerDay },
        team: { used: 2, limit: EXPLANATION_LIMITS.perTeamPerDay },
      });
    });

    it('dashboard/get-explanation answers the newest text for a subject, and null for one never written', async () => {
      await record(people.viewer, 'finding:a', 'first');
      clock.set(new Date(Date.now() + 1000));
      await record(people.viewer, 'finding:a', 'second');
      expect((await newest('finding:a'))?.text).toBe('second');
      expect(await newest('finding:never')).toBeNull();
    });

    it('a write prunes what is past retention', async () => {
      clock.set(new Date(Date.now() - 91 * 86_400_000));
      await record(people.viewer, 'finding:ancient');
      clock.set(new Date());
      expect(await newest('finding:ancient')).not.toBeNull();
      await record(people.viewer, 'finding:today');
      expect(await newest('finding:ancient')).toBeNull();
    });

    it('a person with no role in the team can neither read nor file', async () => {
      await expect(budget(people.nobody)).rejects.toThrow(/permission/i);
      await expect(record(people.nobody, 'finding:x')).rejects.toThrow(/permission/i);
    });
  });

  describe('a process map’s note', () => {
    const note = (scope: string) => `/apps/${scope}/processes/note`;

    beforeEach(async () => {
      clock.set(new Date(Date.now() - HOUR));
      const stub = await host.getScope(people.owner, tenant, appScope);
      await stub.invoke('desk/open', { id: 'ORDER-ONE' });
      await stub.invoke('desk/advance', { id: 'ORDER-ONE', to: 'shipped' });
      await stub.invoke('desk/open', { id: 'ORDER-TWO' });
      clock.set(new Date());
    });

    it('writes from the replay the map draws: counts and declared names, never record ids', async () => {
      expect((await ok(as('viewer', 'GET', `${note(appScope)}?entity=order&period=7d`))).explanation).toBeNull();
      const written = await ok(as('viewer', 'POST', note(appScope), { entity: 'order', period: '7d' }));
      expect(modelCalls).toHaveLength(1);
      expect(written.explanation).toMatchObject({ text: ANSWER, current: true });
      expect(written.explanation!.provenance.sources.map((s) => s.kind)).toEqual(['lifecycle-flow']);
      expect(sentFacts()).toMatchObject({ entity: 'order', period: '7d', current: { started: 2, finished: 1 } });
      expect(sent()).not.toContain('ORDER-ONE');
      expect(sent()).not.toContain('ORDER-TWO');
      // A note is filed per period: the 24h map has none yet.
      expect((await ok(as('viewer', 'GET', `${note(appScope)}?entity=order&period=24h`))).explanation).toBeNull();
    });

    it('a scope that is not one of this team’s apps is not found, and nothing is sent', async () => {
      const res = await as('owner', 'POST', note(ulid()), { entity: 'order', period: '7d' });
      expect(res.status).toBe(404);
      expect(modelCalls).toEqual([]);
    });

    it('a lifecycle the running version does not declare is not found', async () => {
      const res = await as('owner', 'POST', note(appScope), { entity: 'shipment', period: '7d' });
      expect(res.status).toBe(404);
      expect(modelCalls).toEqual([]);
    });
  });
});
