import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import {
  ControlPlaneError,
  createControlPlaneApi,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
  settleUnrecordedOutcomes,
  UNRECORDED_OUTCOME_LOG,
  type VerticalClient,
} from '../src/index.js';

/**
 * An installed vertical's members over the control plane (#1150). The plane decides two
 * things and nothing else: WHICH scope (K-3, the tenant pin) and WHO is acting — the person a
 * dashboard token was minted for (#977). The bound itself is the vertical's, so a fake vertical
 * stands in here and records what it was asked; the bound is tested against the real host in
 * vertical-auth's `members-surface.test.ts`.
 */
describe('/tenants/:t/scopes/:s/members — the plane names the scope and the person', () => {
  const SECRET = 'test-tenant-token-secret';
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const staff = platformActorId.parse(ulid());
  const staffHeaders = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const tA = tenantId.parse(ulid());
  const tB = tenantId.parse(ulid());
  const sA = scopeId.parse(ulid());
  const sB = scopeId.parse(ulid());
  const ann = principalId.parse(ulid());
  const bo = principalId.parse(ulid());
  const member = principalId.parse(ulid());
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const asked: { verb: string; input: Record<string, unknown> }[] = [];
  let refuseNext: ControlPlaneError | null = null;

  const fakeVertical = {
    listMembers: async (tenant: string, scope: string) => {
      asked.push({ verb: 'list', input: { tenant, scope } });
      return { roles: ['agent'], members: [], invites: [] };
    },
    ...Object.fromEntries(
      (['inviteMember', 'changeMemberRole', 'removeMember'] as const).map((verb) => [
        verb,
        async (input: Record<string, unknown>) => {
          asked.push({ verb, input });
          if (refuseNext) {
            const e = refuseNext;
            refuseNext = null;
            throw e;
          }
          if (verb === 'inviteMember') {
            return { principal: member, roleKey: input.roleKey, email: input.email, acceptUrl: `${String(input.origin)}/?invite=t` };
          }
          return verb === 'removeMember' ? { revoked: ['agent'], unbound: 1, inviteWithdrawn: false } : undefined;
        },
      ]),
    ),
  } as unknown as VerticalClient;

  const mint = async (t: string, principal?: string): Promise<Record<string, string>> => {
    const res = await app.request('/tenant-tokens', {
      method: 'POST', headers: staffHeaders, body: JSON.stringify(principal ? { tenantId: t, principal } : { tenantId: t }),
    });
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    return { [SERVICE_TOKEN_HEADER]: token, 'content-type': 'application/json' };
  };
  const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
    app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-members-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(SECRET, serviceActor),
      tenantTokenSecret: SECRET,
      verticals: { 'demo-vert': fakeVertical },
    });
    for (const [t, s, slug] of [[tA, sA, 'acme'], [tB, sB, 'rival']] as const) {
      await host.admin.createTenant(staff, { id: t, slug, name: slug });
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'demo-vert' });
      await host.admin.activateScope(staff, t, s);
      await host.admin.bindHostname(staff, {
        hostname: `${slug}-desk.global.substrat.run`, tenantId: t, scopeId: s, surface: 'app', region: null, canonical: true,
      });
    }
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('invites, moves and removes as the person the token names, with the origin from the hostname directory', async () => {
    const asAnn = await mint(tA, ann);
    asked.length = 0;
    const invited = await post(`/tenants/${tA}/scopes/${sA}/members`, asAnn, { roleKey: 'agent', email: 'kim@example.test' });
    expect(invited.status).toBe(201);
    expect(await invited.json()).toMatchObject({ principal: member, acceptUrl: 'https://acme-desk.global.substrat.run/?invite=t' });
    expect((await post(`/tenants/${tA}/scopes/${sA}/members/${member}/role`, asAnn, { from: 'agent', to: 'lead' })).status).toBe(200);
    const removed = await post(`/tenants/${tA}/scopes/${sA}/members/${member}/remove`, asAnn);
    // Each answer carries the operation id its admin rows are paired by (#2064).
    expect(await removed.json()).toEqual({ revoked: ['agent'], unbound: 1, inviteWithdrawn: false, operationId: expect.any(String) });
    expect(asked).toEqual([
      { verb: 'inviteMember', input: { tenantId: tA, scopeId: sA, caller: ann, origin: 'https://acme-desk.global.substrat.run', roleKey: 'agent', email: 'kim@example.test' } },
      { verb: 'changeMemberRole', input: { tenantId: tA, scopeId: sA, caller: ann, principal: member, from: 'agent', to: 'lead' } },
      { verb: 'removeMember', input: { tenantId: tA, scopeId: sA, caller: ann, principal: member } },
    ]);

    // Each change is two admin rows, intent then applied, on behalf of the person.
    const log = (await host.admin.auditLog(staff, { tenantId: tA })).filter((r) => r.action === 'manageScopeMember');
    expect(log.map((r) => (r.after as { phase: string; change: string }).phase + ':' + (r.after as { change: string }).change).sort())
      .toEqual(['applied:invite', 'applied:remove', 'applied:role', 'intent:invite', 'intent:remove', 'intent:role']);
    for (const r of log) expect(r.onBehalfOf?.principal).toBe(ann);
  });

  it('refuses every write from a credential that names no person — and still reads the roster', async () => {
    const nobody = await mint(tA);
    asked.length = 0;
    expect((await post(`/tenants/${tA}/scopes/${sA}/members`, nobody, { roleKey: 'agent' })).status).toBe(403);
    expect((await post(`/tenants/${tA}/scopes/${sA}/members/${member}/role`, nobody, { from: 'agent', to: 'lead' })).status).toBe(403);
    expect((await post(`/tenants/${tA}/scopes/${sA}/members/${member}/remove`, nobody)).status).toBe(403);
    // Staff names no person in the vertical either.
    expect((await post(`/tenants/${tA}/scopes/${sA}/members/${member}/remove`, staffHeaders)).status).toBe(403);
    expect(asked).toEqual([]);
    const read = await app.request(`/tenants/${tA}/scopes/${sA}/members`, { headers: nobody });
    expect(read.status).toBe(200);
    expect(asked).toEqual([{ verb: 'list', input: { tenant: tA, scope: sA } }]);
  });

  it('isolates tenants: another tenant’s person reaches neither the scope nor the vertical', async () => {
    const asBo = await mint(tB, bo);
    asked.length = 0;
    expect((await app.request(`/tenants/${tA}/scopes/${sA}/members`, { headers: asBo })).status).toBe(403);
    expect((await post(`/tenants/${tA}/scopes/${sA}/members`, asBo, { roleKey: 'agent' })).status).toBe(403);
    // Its own tenant's path, naming the OTHER tenant's scope: unknown (K-3).
    expect((await post(`/tenants/${tB}/scopes/${sA}/members/${member}/remove`, asBo)).status).toBe(404);
    expect(asked).toEqual([]);
    // The positive twin: its own scope.
    expect((await post(`/tenants/${tB}/scopes/${sB}/members/${member}/remove`, asBo)).status).toBe(200);
  });

  it('relays the vertical’s refusal verbatim and audits it as refused', async () => {
    const asAnn = await mint(tA, ann);
    refuseNext = new ControlPlaneError(403, "you cannot invite at 'lead': you do not hold perm:use");
    const res = await post(`/tenants/${tA}/scopes/${sA}/members`, asAnn, { roleKey: 'lead' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/do not hold perm:use/);
    const last = (await host.admin.auditLog(staff, { tenantId: tA }))
      .filter((r) => r.action === 'manageScopeMember')
      .map((r) => r.after as { phase: string; roleKey?: string; error?: string })
      .filter((a) => a.roleKey === 'lead');
    expect(last.map((a) => a.phase).sort()).toEqual(['intent', 'refused']);
  });
  /**
   * Runs `fn` with `recordMemberChange` throwing on `phase`, and console.error captured. A
   * person's token writes through an attributed view (#977) with an admin of its own, so the
   * failure is injected into each view the request makes.
   */
  const withUnwritable = async (phase: string, fn: () => Promise<Response>) => {
    const attributed = host.attributed;
    host.attributed = (...args: Parameters<SqliteScopeHost['attributed']>) => {
      const view = attributed.apply(host, args);
      const record = view.admin.recordMemberChange;
      view.admin.recordMemberChange = async (actor, entry) => {
        if (entry.phase === phase) throw new Error('admin log unavailable');
        return record(actor, entry);
      };
      return view;
    };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await fn();
      return { res, logged: logged.mock.calls.slice() };
    } finally {
      host.attributed = attributed;
      logged.mockRestore();
    }
  };
  const memberRows = async (operationId: string) =>
    (await host.admin.auditLog(staff, { tenantId: tA, action: 'manageScopeMember' }))
      .filter((r) => (r.after as { operationId: string }).operationId === operationId)
      .map((r) => [r.actor, (r.after as { phase: string }).phase]);

  it("a refusal whose `refused` row cannot be written still answers the vertical's 403 — logged, and closed by the sweep (#2064)", async () => {
    const asAnn = await mint(tA, ann);
    refuseNext = new ControlPlaneError(403, 'you do not hold perm:use');
    const { res, logged } = await withUnwritable('refused', () => post(`/tenants/${tA}/scopes/${sA}/members`, asAnn, { roleKey: 'lead' }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; operationId: string };
    expect(body.error).toMatch(/do not hold perm:use/);
    expect(logged).toEqual([
      [UNRECORDED_OUTCOME_LOG, { flow: 'member-change', operationId: body.operationId, phase: 'refused', auditError: 'admin log unavailable' }],
    ]);
    expect(await memberRows(body.operationId)).toEqual([[serviceActor, 'intent']]);
    const sweep = platformActorId.parse(ulid());
    await settleUnrecordedOutcomes({ admin: host.admin, actor: sweep, now: new Date(Date.now() + 2 * 3600_000) });
    expect(await memberRows(body.operationId)).toEqual([[serviceActor, 'intent'], [sweep, 'unknown']]);
  });

  it('a change whose `applied` row cannot be written answers success with an audit warning — the invite keeps its link (#2064)', async () => {
    const asAnn = await mint(tA, ann);
    for (const [path, body, status] of [
      [`/tenants/${tA}/scopes/${sA}/members`, { roleKey: 'agent' }, 201],
      [`/tenants/${tA}/scopes/${sA}/members/${member}/role`, { from: 'agent', to: 'lead' }, 200],
      [`/tenants/${tA}/scopes/${sA}/members/${member}/remove`, {}, 200],
    ] as const) {
      const { res, logged } = await withUnwritable('applied', () => post(path, asAnn, body));
      expect(res.status).toBe(status);
      const answer = (await res.json()) as { auditWarning: string; operationId: string; acceptUrl?: string; revoked?: string[]; to?: string };
      expect(answer.auditWarning).toMatch(/completed, but its outcome could not be written/);
      if (status === 201) expect(answer.acceptUrl).toBe('https://acme-desk.global.substrat.run/?invite=t');
      expect(logged).toEqual([
        [UNRECORDED_OUTCOME_LOG, { flow: 'member-change', operationId: answer.operationId, phase: 'applied', auditError: 'admin log unavailable' }],
      ]);
      expect(await memberRows(answer.operationId)).toEqual([[serviceActor, 'intent']]);
    }
  });
});
