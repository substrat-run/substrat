import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { orgId, platformActorId, principalId, scopeId, tenantId, type EmittedModel, type PrincipalId, type ScopeId } from '@substrat-run/contracts';
import { manualClock, ulid, type ManualClock, type OperationHandler } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';
import { EXPLANATION_LIMITS } from '../src/module.js';
import { ASK_MAX_STEPS, ASK_UNEXPOSED, READ_FAILED, exposedReads, toolNameOf } from '../src/ask.js';
import { dashboardRoutes } from '../src/routes.js';
import { SERVICE_TOKEN, tenantPlane } from './tenant-plane.js';

/**
 * (Harness shared in shape with explanations-route.test.ts.) AI-written text in the dashboard (#1749), end to end: the worker driven the way a request
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
  default: { request(path: string, init: RequestInit, env: unknown, executionCtx?: unknown): Response | Promise<Response> };
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

  /** What a route handed `waitUntil` (the list-apps reconcile passes), settled before the host closes. */
  const background: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => void background.push(p), passThroughOnException: () => undefined };

  afterEach(async () => {
    await Promise.allSettled(background.splice(0));
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
      executionCtx as never,
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

  /** A scripted model: each call answers the next entry, and every call's inputs are kept. */
  const script = (...answers: unknown[]) => {
    env.AI = {
      run: async (model: string, inputs: unknown) => {
        modelCalls.push({ model, inputs });
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next ?? { response: 'out of script' };
      },
    };
  };
  const ask = (who: keyof typeof subs, messages: Array<{ role: 'user' | 'assistant'; text: string }>) =>
    as(who, 'POST', '/assistant/ask', { messages });
  type Ev = { id: number; t: string; [k: string]: unknown };
  const events = async (res: Response | Promise<Response>): Promise<Ev[]> => {
    const r = await res;
    expect(r.status, await r.clone().text()).toBe(200);
    return ((await r.json()) as { events: Ev[] }).events;
  };
  /** What the model was sent on call `n` (1-based), all messages flattened to text. */
  const sentOn = (n: number) => JSON.stringify(modelCalls[n - 1]!.inputs);

  describe('Ask (#2283)', () => {
    it('reads through the tools, answers, and returns the protocol’s events in order', async () => {
      const f = await myFinding();
      script(
        { response: '', tool_calls: [{ id: 'call_1', name: 'list_findings', arguments: { status: 'open' } }] },
        { response: '', tool_calls: [{ id: 'call_2', name: 'finding_evidence', arguments: { id: f.id } }] },
        { response: '**Uploads** keep failing: a supplier refuses them with 503.' },
      );
      const evs = await events(ask('viewer', [{ role: 'user', text: 'Why do uploads fail?' }]));

      expect(evs.map((e) => e.t)).toEqual([
        'user-message', 'turn-start',
        'step-start', 'tool-input', 'tool-output', 'step-end',
        'step-start', 'tool-input', 'tool-output', 'step-end',
        'text-start', 'text-delta', 'text-end', 'data-provenance', 'turn-finish',
      ]);
      expect(evs.map((e) => e.id)).toEqual(evs.map((_, i) => i + 1));
      expect(evs.find((e) => e.t === 'text-delta')).toMatchObject({ delta: 'Uploads keep failing: a supplier refuses them with 503.' });
      expect(evs.find((e) => e.t === 'data-provenance')).toMatchObject({ sources: 2, model: expect.stringContaining('llama') });
      expect(evs.at(-1)).toMatchObject({ t: 'turn-finish', reason: 'done' });
      // The route's own answer, as the Findings page reads it.
      const listed = evs.filter((e) => e.t === 'tool-output')[0]!.output as { entries: Array<Record<string, unknown>> };
      expect(listed.entries.map((x) => x.id)).toEqual([f.id]);

      // The second model call saw the list; the third saw the redacted evidence and nothing more.
      expect(sentOn(2)).toContain(f.id);
      expect(sentOn(3)).toContain('upstream refused Bearer [secret] for [email]');
      // Free text from the apps' own errors stays redacted; the platform's record ids do reach the
      // model (an app's scope id is how it asks about that app), as the privacy policy says.
      const all = JSON.stringify(modelCalls);
      expect(all).not.toContain('ops@acme.example');
      expect(sentOn(2)).toContain(appScope);

      // One unit of budget for the question, however many steps it took.
      expect((await ok(as('viewer', 'GET', '/explanations'))).budget!.person.used).toBe(1);
    });

    it('every declared read is a tool, and nothing that writes is', async () => {
      script({ response: 'Ok.' });
      await events(ask('viewer', [{ role: 'user', text: 'What can you read?' }]));
      const offered = ((modelCalls[0]!.inputs as { tools: Array<{ function: { name: string } }> }).tools ?? []).map((t) => t.function.name).sort();
      const reads = exposedReads(dashboardRoutes).map(([name]) => toolNameOf(name));
      expect(offered).toEqual([...reads, 'finding_evidence', 'process_map'].sort());
      // Not one route that writes, and not the AI's own records.
      const writes = Object.entries(dashboardRoutes).filter(([, d]) => d.http.method !== 'GET').map(([name]) => toolNameOf(name));
      for (const w of writes) expect(offered).not.toContain(w);
      for (const r of Object.keys(ASK_UNEXPOSED)) expect(offered).not.toContain(toolNameOf(r));
      // The team, observability, deployments and findings are all reachable.
      for (const t of ['list_members', 'list_team_audit', 'observability_logs', 'app_requests', 'list_deployments', 'list_findings']) expect(offered).toContain(t);
    });

    it('reads the team’s roster with the members’ addresses, as the Team page shows them', async () => {
      const owner = await host.getScope(people.owner, tenant, dashScope);
      const org = orgId.parse(ulid());
      await host.admin.createOrg(staff, { id: org, tenantId: tenant, slug: 'explain-org', name: 'Explain' });
      await owner.invoke('dashboard/init-team', { orgId: org, ownerEmail: 'owner@acme.test' });
      await owner.invoke('dashboard/invite-member', { email: 'jane@acme.test', roleKey: 'viewer' });
      script(
        { response: '', tool_calls: [{ id: 'call_1', name: 'list_members', arguments: {} }] },
        { response: 'Jane is invited as a viewer.' },
      );
      const evs = await events(ask('viewer', [{ role: 'user', text: 'Who is on the team?' }]));
      const roster = evs.find((e) => e.t === 'tool-output')!.output as { entries: Array<{ email: string; role_key: string; status: string }> };
      expect(roster.entries).toEqual(expect.arrayContaining([expect.objectContaining({ email: 'jane@acme.test', role_key: 'viewer', status: 'invited' })]));
      expect(sentOn(2)).toContain('jane@acme.test');
    });

    /** Wrap the team scope's `list-members` so it answers `answer` (or throws it), and leave every other call alone. */
    const membersAnswer = (answer: (real: unknown) => unknown) => {
      const real = host.getScope.bind(host);
      return vi.spyOn(host, 'getScope').mockImplementation(async (...args: Parameters<typeof host.getScope>) => {
        const stub = await real(...args);
        return {
          ...stub,
          invoke: async (op: string, input?: unknown) =>
            op === 'dashboard/list-members' ? answer(await stub.invoke(op, input)) : stub.invoke(op, input),
        } as typeof stub;
      });
    };

    it('reads what the route publishes: a field the handler returns and the route does not declare never reaches the model', async () => {
      const spy = membersAnswer((real) => {
        const page = real as { entries: Array<Record<string, unknown>> };
        return { ...page, internalNote: 'tenant-internal-zz', entries: page.entries.map((e) => ({ ...e, rowSecret: 'row-internal-zz' })) };
      });
      try {
        script({ response: '', tool_calls: [{ id: 'call_1', name: 'list_members', arguments: {} }] }, { response: 'Ok.' });
        const evs = await events(ask('viewer', [{ role: 'user', text: 'Who is on the team?' }]));
        expect(evs.some((e) => e.t === 'tool-output')).toBe(true);
        expect(JSON.stringify(modelCalls)).not.toContain('internal-zz');
        expect(JSON.stringify(evs)).not.toContain('internal-zz');
      } finally {
        spy.mockRestore();
      }
    });

    it('a read that fails on the platform’s side says so in a fixed sentence, never in its own words', async () => {
      const spy = membersAnswer(() => {
        throw new Error('SQLITE_ERROR: no such column members.secret_column_zz');
      });
      try {
        script({ response: '', tool_calls: [{ id: 'call_1', name: 'list_members', arguments: {} }] }, { response: 'The roster could not be read.' });
        const evs = await events(ask('viewer', [{ role: 'user', text: 'Who is on the team?' }]));
        expect(evs.find((e) => e.t === 'tool-output')).toMatchObject({ output: { error: READ_FAILED } });
        expect(JSON.stringify(modelCalls)).not.toContain('secret_column_zz');
        expect(JSON.stringify(evs)).not.toContain('secret_column_zz');
      } finally {
        spy.mockRestore();
      }
    });

    it('carries the conversation so far to the model', async () => {
      script({ response: 'You have one app.' });
      await events(
        ask('viewer', [
          { role: 'user', text: 'How many apps do I have?' },
          { role: 'assistant', text: 'One, called Desk.' },
          { role: 'user', text: 'Is it running?' },
        ]),
      );
      expect(sentOn(1)).toContain('One, called Desk.');
      expect(sentOn(1)).toContain('Is it running?');
    });

    it('a person who may read the apps but not the findings gets a refusal from the findings tools', async () => {
      // A role holding `dashboard:read` alone: none of the seeded roles is that narrow.
      await host.admin.defineRole(staff, tenant, { key: 'apps-reader', permissions: ['dashboard:read' as never], source: 'vertical' });
      const reader = principalId.parse(ulid());
      await host.admin.assignRole(staff, { principalId: reader, roleKey: 'apps-reader', node: { tenantId: tenant, scopeId: null } });
      await host.admin.linkIdentity(staff, { provider: PROVIDER, externalId: 'sub-reader', principal: reader, tenantId: tenant, scopeId: dashScope });
      script(
        { response: '', tool_calls: [{ id: 'call_1', name: 'list_findings', arguments: {} }] },
        { response: '', tool_calls: [{ id: 'call_2', name: 'list_apps', arguments: {} }] },
        { response: 'You can see one app, but not its findings.' },
      );
      const res = await app.request(
        `/api/teams/${tenant}/assistant/ask`,
        { method: 'POST', headers: { cookie: 'sb_session=sub-reader', 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', text: 'What is failing?' }] }) },
        env,
        executionCtx as never,
      );
      const evs = await events(res);
      const outputs = evs.filter((e) => e.t === 'tool-output').map((e) => e.output);
      expect(outputs).toMatchObject([
        { refused: expect.stringContaining('not part of your role') },
        { entries: [expect.objectContaining({ name: 'Desk', vertical_slug: SLUG, status: 'provisioning' })] },
      ]);
      expect(JSON.stringify(modelCalls)).not.toContain('deploy.upload');
    });

    it('a person with no role in the team is refused before anything runs', async () => {
      script({ response: 'never' });
      const res = await ask('nobody', [{ role: 'user', text: 'Anything?' }]);
      expect(res.status).toBe(403);
      expect(modelCalls).toEqual([]);
    });

    it('a spent budget ends the turn on a budget notice, with no model call', async () => {
      const dash = await host.getScope(people.viewer, tenant, dashScope);
      for (let i = 0; i < EXPLANATION_LIMITS.perPersonPerDay; i++) {
        await dash.invoke('dashboard/reserve-explanation', { subject: `finding:filler-${i}` });
      }
      script({ response: 'never' });
      const evs = await events(ask('viewer', [{ role: 'user', text: 'Anything?' }]));
      expect(evs.map((e) => e.t)).toEqual(['user-message', 'turn-start', 'budget-notice', 'turn-finish']);
      expect(evs.at(-1)).toMatchObject({ reason: 'budget' });
      expect(modelCalls).toEqual([]);
    });

    it('a model that fails ends the turn on an error the person can read, and the call still counts', async () => {
      script(new Error('upstream 529 at account 8cbb'));
      const evs = await events(ask('viewer', [{ role: 'user', text: 'Anything?' }]));
      expect(evs.at(-1)).toMatchObject({ t: 'turn-error', code: 'model_unavailable' });
      expect(JSON.stringify(evs)).not.toContain('8cbb');
      expect((await ok(as('viewer', 'GET', '/explanations'))).budget!.person.used).toBe(1);
    });

    it('a model that keeps calling tools is stopped after its steps', async () => {
      script(...Array.from({ length: 10 }, (_, i) => ({ response: '', tool_calls: [{ id: `call_${i}`, name: 'list_apps', arguments: {} }] })));
      await ask('viewer', [{ role: 'user', text: 'Loop.' }]);
      expect(modelCalls).toHaveLength(ASK_MAX_STEPS);
    });

    it('refuses a conversation that does not end with a question, before anything runs', async () => {
      script({ response: 'never' });
      const res = await ask('viewer', [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello' }]);
      expect(res.status).toBe(400);
      expect(modelCalls).toEqual([]);
    });

    it('with the flag off, asking is refused and nothing is called', async () => {
      env.AI_EXPLANATIONS = undefined;
      script({ response: 'never' });
      expect((await ask('viewer', [{ role: 'user', text: 'Anything?' }])).status).toBe(409);
      expect(modelCalls).toEqual([]);
    });
  });
});
