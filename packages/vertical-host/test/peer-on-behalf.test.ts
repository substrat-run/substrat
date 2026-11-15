/**
 * The peer door taking a call made FOR a person (#3161): `/internal/vertical-invoke` with
 * `onBehalf`, and the built-in `PEER_CLIENT_OPERATION`, against a REAL `SqliteScopeHost`.
 *
 * What is pinned: the platform's own question is answered before any module is looked up; a call
 * for a person runs only through `delegatedPeer` and never falls back to the peer; an admitted one
 * runs as the person with the token's scope as the kernel's ceiling; a refusal tells the caller
 * nothing but "refused" (or "retry"), the reason going to the operator's line; and the token is
 * never written to a log.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  PEER_CLIENT_OPERATION,
  PLATFORM_SECRET_HEADER,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { PEER_CALLER, peerMod } from '@substrat-run/contract-tests';
import { invocationLog, mountPlatformSurface, type DelegatedPeerAnswer, type PlatformSurfaceDeps, type VerticalScopeHost } from '../src/index.js';

type Env = { PLATFORM_SECRET: string };
const SECRET = 'sekret';
const ENV: Env = { PLATFORM_SECRET: SECRET };
const READ = permissionKey.parse('peer:read');
const WRITE = permissionKey.parse('peer:write');
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.the-persons-token.sig';
const platform = { [PLATFORM_SECRET_HEADER]: SECRET, 'content-type': 'application/json' };

describe('/internal/vertical-invoke for a person (#3161)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-peer-on-behalf-'));
  const sqlite = new SqliteScopeHost({ dir });
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const ada: PrincipalId = principalId.parse(ulid());
  const callerScope = scopeId.parse(ulid());
  const peerCalls: unknown[] = [];

  const host = {
    verticalInvokeLocal: async (...args: unknown[]) => {
      peerCalls.push(args);
      const [caller, tenant, scope, operation, input, options] = args as Parameters<NonNullable<VerticalScopeHost['verticalInvokeLocal']>>;
      return (await sqlite.getVerticalScope(caller, tenant, scope)).invoke(operation, input, options);
    },
    getScope: sqlite.getScope.bind(sqlite),
  } as unknown as VerticalScopeHost;

  /** What the worker's door would answer; each case sets it. */
  let answer: DelegatedPeerAnswer = { admitted: true, principal: ada, scope: [READ, WRITE], actor: 'todo-client' };
  const delegatedPeer = vi.fn<NonNullable<PlatformSurfaceDeps<Env>['delegatedPeer']>>(async () => answer);

  const appWith = (over: Partial<PlatformSurfaceDeps<Env>> = {}, h: VerticalScopeHost = host) => {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', invocationLog<Env>({ routerSecret: () => 'router-secret' }));
    mountPlatformSurface<Env>(app, {
      platformSecret: (env) => env.PLATFORM_SECRET,
      hostFor: () => h,
      roles: [],
      ownerRoleKey: 'admin',
      ...over,
    });
    return app;
  };
  const door = appWith({ delegatedPeer, peerClient: async () => ({ clientId: 'notes-client' }) });

  const post = (app: Hono<{ Bindings: Env }>, body: unknown) =>
    app.request('/internal/vertical-invoke', { method: 'POST', headers: platform, body: JSON.stringify(body) }, ENV);
  const call = (operation: string, input?: unknown, extra: Record<string, unknown> = {}) => ({
    caller: { vertical: PEER_CALLER, scope: callerScope },
    tenantId: t,
    scopeId: s,
    operation,
    ...(input === undefined ? {} : { input }),
    onBehalf: { token: TOKEN },
    ...extra,
  });
  const actorOf = async (id: string): Promise<unknown> => {
    const rows = await (await sqlite.getScope(ada, t, s)).invoke<{ actor: string; entity_id: string }[]>('peer/outbox');
    const row = rows.find((r) => r.entity_id === id);
    if (!row) return undefined;
    try { return JSON.parse(row.actor) as unknown; } catch { return row.actor; }
  };

  let spies: Array<{ mock: { calls: unknown[][] }; mockClear(): void; mockRestore(): void }> = [];
  const logged = () => spies.flatMap((spy) => spy.mock.calls).map((c) => c.map(String).join(' ')).join('\n');
  const lines = () =>
    spies[0]!.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])) as Record<string, unknown>; } catch { return null; } })
      .filter((l): l is Record<string, unknown> => l?.['substrat'] === 'invocation');

  beforeAll(async () => {
    sqlite.registerModule(peerMod);
    await sqlite.admin.createTenant(staff, { id: t, slug: `peer-ob-${t.slice(-8).toLowerCase()}`, name: 'Peer on behalf' });
    await sqlite.admin.grantEntitlement(staff, t, 'peer');
    await sqlite.provisionScope(staff, { tenantId: t, scopeId: s });
    await sqlite.admin.activateScope(staff, t, s);
    await sqlite.admin.defineRole(staff, t, { key: 'owner', permissions: [READ, WRITE], source: 'vertical' });
    await sqlite.admin.assignRole(staff, { principalId: ada, roleKey: 'owner', node: { tenantId: t, scopeId: null } });
    spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  });
  afterEach(() => {
    // Whatever a case did, the token was never written anywhere.
    expect(logged()).not.toContain('the-persons-token');
    for (const spy of spies) spy.mockClear();
    delegatedPeer.mockClear();
  });
  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    await sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('PEER_CLIENT_OPERATION', () => {
    it("is answered from the hook, before any module or peer admission is reached", async () => {
      const res = await post(door, { ...call(PEER_CLIENT_OPERATION), onBehalf: undefined });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: { clientId: 'notes-client' } });
      expect(peerCalls).toHaveLength(0);
    });

    it('with no hook, and on a host that takes no peer calls at all, answers that it signs nobody in', async () => {
      const bare = appWith({}, {} as VerticalScopeHost);
      const res = await post(bare, { ...call(PEER_CLIENT_OPERATION), onBehalf: undefined });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ result: { clientId: null } });
    });
  });

  it('a call for a person on an app with no `delegatedPeer` is refused, 403 problem, and runs nothing', async () => {
    const res = await post(appWith(), call('peer/note', { id: 'no-hook', body: 'x' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'forbidden', detail: 'this app does not take calls for a person' });
    expect(peerCalls).toHaveLength(0);
    expect(await actorOf('no-hook')).toBeUndefined();
  });

  it('an admitted call runs as the person, never the peer, and the line names a principal', async () => {
    answer = { admitted: true, principal: ada, scope: [READ, WRITE], actor: 'todo-client' };
    const res = await post(door, call('peer/note', { id: 'as-ada', body: 'x' }));
    expect(res.status).toBe(200);
    expect(await actorOf('as-ada')).toBe(ada);
    expect(peerCalls).toHaveLength(0);
    // The hook is handed the platform's caller and the token, and nothing else decides who.
    expect(delegatedPeer).toHaveBeenCalledWith(ENV, { tenantId: t, scopeId: s }, { vertical: PEER_CALLER, scope: callerScope }, TOKEN);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ status: 200, operation: 'peer/note', principalKind: 'principal' });
  });

  it("the token's scope is a ceiling: a key the person holds but the token does not delegate is refused", async () => {
    answer = { admitted: true, principal: ada, scope: [READ], actor: 'todo-client' };
    const write = await post(door, call('peer/note', { id: 'over-ceiling', body: 'x' }));
    expect(write.status).toBe(403);
    expect(await actorOf('over-ceiling')).toBeUndefined();
    // Twin: inside the ceiling, the same person reads.
    expect((await post(door, call('peer/list'))).status).toBe(200);
  });

  describe("the calling vertical passes this scope's peer admission too", () => {
    const peerSwitch = { vertical: PEER_CALLER, node: { tenantId: t, scopeId: s }, reason: 'incident' };

    it('switched off here, a call for a person through it is refused 403 and runs nothing; on again, it runs', async () => {
      answer = { admitted: true, principal: ada, scope: [READ, WRITE], actor: 'todo-client' };
      await sqlite.admin.revokeFromPeer(staff, peerSwitch);
      try {
        const res = await post(door, call('peer/note', { id: 'switched-off', body: 'x' }));
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: 'forbidden', detail: expect.stringContaining('switched off on this scope') });
        expect(await actorOf('switched-off')).toBeUndefined();
        expect(lines()[0]).toMatchObject({ status: 403, problemCode: 'forbidden', principalKind: 'principal', operation: 'peer/note' });
      } finally {
        await sqlite.admin.restoreToPeer(staff, { ...peerSwitch, reason: 'resolved' });
      }
      expect((await post(door, call('peer/note', { id: 'switched-on', body: 'x' }))).status).toBe(200);
      expect(await actorOf('switched-on')).toBe(ada);
    });

    it('a vertical this scope does not declare as a peer is refused, whatever its token admitted', async () => {
      answer = { admitted: true, principal: ada, scope: [READ, WRITE], actor: 'todo-client' };
      const res = await post(door, { ...call('peer/note', { id: 'undeclared', body: 'x' }), caller: { vertical: 'stranger', scope: callerScope } });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'forbidden', detail: expect.stringContaining('not a declared peer') });
      expect(await actorOf('undeclared')).toBeUndefined();
    });
  });

  it.each([
    ['not-master', 403],
    ['token-refused', 403],
    ['unknown', 403],
    ['invited', 403],
    ['blocked', 403],
    ['unavailable', 503],
  ] as const)('refused as %s: %i, a body that does not say why, and the reason on the operator’s line', async (reason, status) => {
    answer = { admitted: false, reason };
    const res = await post(door, call('peer/note', { id: `refused-${reason}`, body: 'x' }));
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    // One sentence per status, whatever the reason was.
    expect(await res.json()).toMatchObject(
      status === 403
        ? { code: 'forbidden', detail: 'this call for a person was refused' }
        : { code: 'unavailable', detail: 'this call for a person cannot be answered now; retry' },
    );
    expect(peerCalls).toHaveLength(0);
    expect(await actorOf(`refused-${reason}`)).toBeUndefined();
    const warned = spies[1]!.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(warned).toContainEqual({ host: 'peer-on-behalf-refused', tenantId: t, scopeId: s, caller: PEER_CALLER, reason });
    expect(lines()[0]).toMatchObject({ status, principalKind: 'principal' });
  });

  it('a body that names a principal beside the token is still refused — strict — and nothing runs', async () => {
    const res = await post(door, call('peer/note', { id: 'named', body: 'x' }, { principal: ada }));
    expect(res.status).toBe(400);
    expect(delegatedPeer).not.toHaveBeenCalled();
    expect(await actorOf('named')).toBeUndefined();
  });
});
