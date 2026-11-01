/**
 * The peer door's far end over HTTP (#1706): `/internal/vertical-invoke` and `/internal/peer-switch`
 * against a REAL `SqliteScopeHost`, behind the platform-secret gate every `/internal` verb shares.
 *
 * What is pinned here, each beside its twin:
 * - only the platform reaches it — no secret, 403, and the host is never called;
 * - a bearer token is not a credential here. The door takes no token at all, so #1683's
 *   own-token check is never the thing between a caller and it: a bearer is ignored with the
 *   secret (the call still acts as the peer) and useless without it (still 403);
 * - the body names the caller and nothing that could act as a person — a `principal` beside it
 *   is refused (strict), so no future field can turn a peer call into an impersonation;
 * - the call acts as `{ vertical, scope }` on the spine, and an undeclared peer is refused.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  PLATFORM_SECRET_HEADER,
  PARENT_REQUEST_ID_HEADER,
  REQUEST_ID_HEADER,
  SCOPE_GATE_REASONS,
  substratError,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { PEER_CALLER, peerMod } from '@substrat-run/contract-tests';
import { invocationLog, mountPlatformSurface, writePlatformCallLine, type VerticalScopeHost } from '../src/index.js';

type Env = { PLATFORM_SECRET: string };
const SECRET = 'sekret';
const ENV: Env = { PLATFORM_SECRET: SECRET };
const READ = permissionKey.parse('peer:read');
const WRITE = permissionKey.parse('peer:write');

describe('/internal/vertical-invoke — the peer door over HTTP (#1706)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-peer-http-'));
  const sqlite = new SqliteScopeHost({ dir });
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const alice: PrincipalId = principalId.parse(ulid());
  const callerScope = scopeId.parse(ulid());
  const calls: unknown[][] = [];

  // The deployment's host, as `mountPlatformSurface` sees it: only the two peer verbs are
  // reached here, each forwarding to the real pure host's door and switch.
  const host = {
    verticalInvokeLocal: async (...args: unknown[]) => {
      calls.push(args);
      const [caller, tenant, scope, operation, input, options] = args as Parameters<
        NonNullable<VerticalScopeHost['verticalInvokeLocal']>
      >;
      return (await sqlite.getVerticalScope(caller, tenant, scope)).invoke(operation, input, options);
    },
    peerSwitchLocal: async (scope: string, vertical: string, to: 'on' | 'off', opts?: { tenantHeld?: boolean }) => {
      calls.push(['peerSwitchLocal', scope, vertical, to, opts]);
      return { held: true, changed: true, permissions: [READ, WRITE] };
    },
  } as unknown as VerticalScopeHost;

  const app = new Hono<{ Bindings: Env }>();
  mountPlatformSurface<Env>(app, {
    platformSecret: (env) => env.PLATFORM_SECRET,
    hostFor: () => host,
    roles: [],
    ownerRoleKey: 'admin',
  });

  const invoke = (body: unknown, headers: Record<string, string> = {}) =>
    app.request(
      '/internal/vertical-invoke',
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
      ENV,
    );
  const platform = { [PLATFORM_SECRET_HEADER]: SECRET };
  const note = (id: string) => ({
    caller: { vertical: PEER_CALLER, scope: callerScope },
    tenantId: t,
    scopeId: s,
    operation: 'peer/note',
    input: { id, body: `note ${id}` },
  });
  const actorOf = async (id: string): Promise<unknown> => {
    const rows = await (await sqlite.getScope(alice, t, s)).invoke<{ actor: string; entity_id: string }[]>(
      'peer/outbox',
    );
    const row = rows.find((r) => r.entity_id === id);
    return row ? JSON.parse(row.actor) : undefined;
  };

  beforeAll(async () => {
    sqlite.registerModule(peerMod);
    await sqlite.admin.createTenant(staff, { id: t, slug: `peer-http-${t.slice(-8).toLowerCase()}`, name: 'Peer HTTP' });
    await sqlite.admin.grantEntitlement(staff, t, 'peer');
    await sqlite.provisionScope(staff, { tenantId: t, scopeId: s });
    await sqlite.admin.activateScope(staff, t, s);
    await sqlite.admin.defineRole(staff, t, { key: 'owner', permissions: [READ, WRITE], source: 'vertical' });
    await sqlite.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t, scopeId: null } });
  });

  afterAll(async () => {
    await sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('without the platform secret: 403, and the door is never reached', async () => {
    const before = calls.length;
    const res = await invoke(note('no-secret'));
    expect(res.status).toBe(403);
    expect(calls.length).toBe(before);
    expect(await actorOf('no-secret')).toBeUndefined();
  });

  it('a bearer token is no credential here: without the secret it is still 403', async () => {
    const before = calls.length;
    const res = await invoke(note('bearer-only'), { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig' });
    expect(res.status).toBe(403);
    expect(calls.length).toBe(before);
  });

  it('twin: with the secret, the operation runs and the spine names { vertical, scope }', async () => {
    const res = await invoke(note('with-secret'), platform);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { id: 'with-secret' } });
    expect(await actorOf('with-secret')).toEqual({ vertical: PEER_CALLER, scope: callerScope });
  });

  it('a bearer beside the secret changes nothing: the call still acts as the peer, never as the token’s user', async () => {
    const res = await invoke(note('bearer-and-secret'), { ...platform, authorization: `Bearer for-${alice}` });
    expect(res.status).toBe(200);
    expect(await actorOf('bearer-and-secret')).toEqual({ vertical: PEER_CALLER, scope: callerScope });
  });

  it('a body that also names a principal is refused — strict — and nothing runs', async () => {
    const before = calls.length;
    const res = await invoke({ ...note('with-principal'), principal: alice }, platform);
    expect(res.status).toBe(400);
    expect(calls.length).toBe(before);
    expect(await actorOf('with-principal')).toBeUndefined();
  });

  it('an undeclared peer reaches the door and is refused there: 403 forbidden', async () => {
    const res = await invoke({ ...note('stranger'), caller: { vertical: 'acme/stranger', scope: callerScope } }, platform);
    expect(res.status).toBe(403);
    expect(await actorOf('stranger')).toBeUndefined();
  });

  it('the peer switch forwards the parsed switch and answers its outcome', async () => {
    const res = await app.request(
      '/internal/peer-switch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...platform },
        body: JSON.stringify({ scopeId: s, vertical: PEER_CALLER, to: 'off' }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ held: true, changed: true, permissions: [READ, WRITE] });
    expect(calls.at(-1)).toEqual(['peerSwitchLocal', s, PEER_CALLER, 'off', { tenantHeld: undefined }]);
  });

  it("carries the platform's tenantHeld through to the host (#2030), and refuses one that is not a boolean", async () => {
    const post = (body: unknown) =>
      app.request(
        '/internal/peer-switch',
        { method: 'POST', headers: { 'content-type': 'application/json', ...platform }, body: JSON.stringify(body) },
        ENV,
      );
    const body = { scopeId: s, vertical: PEER_CALLER, to: 'off' };
    expect((await post({ ...body, tenantHeld: true })).status).toBe(200);
    expect(calls.at(-1)).toEqual(['peerSwitchLocal', s, PEER_CALLER, 'off', { tenantHeld: true }]);
    const before = calls.length;
    expect((await post({ ...body, tenantHeld: 'yes' })).status).toBe(400);
    expect(calls.length).toBe(before);
  });

  describe('the call is one line, naming the request that made it (#2192)', () => {
    // As deployed: the request is stamped (here by the middleware, hosted by the platform's
    // entry), and no router assertion names a tenant, so the stamp's own writer is silent.
    const logged = new Hono<{ Bindings: Env }>();
    logged.use('*', invocationLog<Env>({ routerSecret: () => 'router-secret' }));
    mountPlatformSurface<Env>(logged, {
      platformSecret: (env) => env.PLATFORM_SECRET,
      hostFor: () => host,
      roles: [],
      ownerRoleKey: 'admin',
    });
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      logged.request(
        '/internal/vertical-invoke',
        { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
        ENV,
      );
    const PARENT = ulid();
    let log: ReturnType<typeof vi.spyOn>;
    const output = () => log.mock.calls.map((c: unknown[]) => String(c[0]));
    const lines = () =>
      output()
        .map((l: string) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
        .filter((l: Record<string, unknown> | null): l is Record<string, unknown> => l?.['substrat'] === 'invocation');
    beforeAll(() => {
      log = vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => log.mockClear());
    afterAll(() => log.mockRestore());

    it('writes exactly one line: the body’s tenant and scope, its own request id, the caller’s as parent, and its events stamped', async () => {
      const res = await post(note('lined'), { ...platform, [PARENT_REQUEST_ID_HEADER]: PARENT, 'x-substrat-vertical': 'acme/target' });
      expect(res.status).toBe(200);
      const id = res.headers.get(REQUEST_ID_HEADER);
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toMatchObject({
        tenantId: t,
        scopeId: s,
        vertical: 'acme/target',
        method: 'POST',
        path: '/internal/vertical-invoke',
        invocationId: id,
        parentInvocationId: PARENT,
        // Where the parent's line is: the caller's scope, from the verified body.
        parentScopeId: callerScope,
        status: 200,
        level: 'info',
        operation: 'peer/note',
        principalKind: 'vertical',
        eventCount: 1,
        // #2762: the scope host's count — `peer/note` logs nothing, which is a `0`, not "not recorded".
        logLines: 0,
      });
      // The operation ran under the same id, which is what stamps its events with it.
      expect((calls.at(-1)![5] as { invocationId?: string }).invocationId).toBe(id);
    });

    it('a refused call is still one line, with the status the caller got', async () => {
      const res = await post(
        { ...note('refused-line'), caller: { vertical: 'acme/stranger', scope: callerScope } },
        { ...platform, [PARENT_REQUEST_ID_HEADER]: PARENT },
      );
      expect(res.status).toBe(403);
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toMatchObject({ status: 403, level: 'warn', problemCode: 'forbidden', parentInvocationId: PARENT });
    });

    it('names the status and code the caller got: a suspended scope is the neutral 404 not_found on both', async () => {
      const gated = new Hono<{ Bindings: Env }>();
      gated.use('*', invocationLog<Env>({ routerSecret: () => 'router-secret' }));
      mountPlatformSurface<Env>(gated, {
        platformSecret: (env) => env.PLATFORM_SECRET,
        hostFor: () =>
          ({
            verticalInvokeLocal: async () => {
              throw substratError('conflict', `scope not active (status: suspended): ${s}`, { reason: SCOPE_GATE_REASONS.notActive });
            },
          }) as unknown as VerticalScopeHost,
        roles: [],
        ownerRoleKey: 'admin',
      });
      const res = await gated.request(
        '/internal/vertical-invoke',
        { method: 'POST', headers: { 'content-type': 'application/json', ...platform }, body: JSON.stringify(note('suspended')) },
        ENV,
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code?: string }).code).toBe('not_found');
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toMatchObject({ status: 404, problemCode: 'not_found', level: 'warn' });
    });

    it('the tenant is the verified body’s: a tenant header beside it changes nothing', async () => {
      const other = tenantId.parse(ulid());
      const res = await post(note('header-tenant'), { ...platform, 'x-substrat-tenant': other, 'x-substrat-scope': ulid() });
      expect(res.status).toBe(200);
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toMatchObject({ tenantId: t, scopeId: s });
      expect(output().join('\n')).not.toContain(other);
    });

    it('without the platform secret there is no line at all, whatever the body or headers name', async () => {
      const res = await post(note('no-secret-line'), { [PARENT_REQUEST_ID_HEADER]: PARENT });
      expect(res.status).toBe(403);
      expect(lines()).toHaveLength(0);
    });

    it.each([
      ['lowercased', PARENT.toLowerCase()],
      ['repeated', `${PARENT}, ${ulid()}`],
      ['oversized', `${PARENT}${'Z'.repeat(4000)}`],
      ['not an id', 'drop table'],
    ])('a %s parent is dropped: never on the line, never logged raw', async (_name, value) => {
      const res = await post(note(`bad-parent-${_name}`), { ...platform, [PARENT_REQUEST_ID_HEADER]: value });
      expect(res.status).toBe(200);
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).not.toHaveProperty('parentInvocationId');
      expect(lines()[0]).not.toHaveProperty('parentScopeId');
      expect(output().join('\n')).not.toContain(value);
    });

    it('a call with no parent writes no parent key, so the line is what it was before the field', async () => {
      await post(note('no-parent'), platform);
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).not.toHaveProperty('parentInvocationId');
      expect(lines()[0]).not.toHaveProperty('parentScopeId');
    });

    it('a malformed parent scope is dropped beside a good parent, and never logged raw', () => {
      const bad = `${callerScope}, ${ulid()}`;
      writePlatformCallLine({
        tenantId: t, scopeId: s, vertical: null, method: 'POST', url: 'https://v/internal/vertical-invoke', env: {},
        invocationId: ulid(), parentInvocationId: PARENT, parentScopeId: bad, status: 200, problemCode: null,
        principalKind: 'vertical', operation: 'peer/note', emitted: undefined, started: Date.now(),
      });
      expect(lines()).toHaveLength(1);
      expect(lines()[0]).toMatchObject({ parentInvocationId: PARENT });
      expect(lines()[0]).not.toHaveProperty('parentScopeId');
      expect(output().join('\n')).not.toContain(bad);
    });

    it('an unstamped request (no entry, no middleware) still runs, and writes no line', async () => {
      const res = await invoke(note('unstamped'), { ...platform, [PARENT_REQUEST_ID_HEADER]: PARENT });
      expect(res.status).toBe(200);
      expect(lines()).toHaveLength(0);
    });
  });

  it('a deployment built before the door answers 501 on both routes', async () => {
    const bare = new Hono<{ Bindings: Env }>();
    mountPlatformSurface<Env>(bare, {
      platformSecret: (env) => env.PLATFORM_SECRET,
      hostFor: () => ({}) as VerticalScopeHost,
      roles: [],
      ownerRoleKey: 'admin',
    });
    const post = (path: string, body: unknown) =>
      bare.request(
        path,
        { method: 'POST', headers: { 'content-type': 'application/json', ...platform }, body: JSON.stringify(body) },
        ENV,
      );
    expect((await post('/internal/vertical-invoke', note('old'))).status).toBe(501);
    expect((await post('/internal/peer-switch', { scopeId: s, vertical: PEER_CALLER, to: 'off' })).status).toBe(501);
  });
});
