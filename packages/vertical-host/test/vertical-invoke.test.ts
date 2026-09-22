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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { PLATFORM_SECRET_HEADER, ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { PEER_CALLER, peerMod } from '@substrat-run/contract-tests';
import { mountPlatformSurface, type VerticalScopeHost } from '../src/index.js';

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
    peerSwitchLocal: async (scope: string, vertical: string, to: 'on' | 'off') => {
      calls.push(['peerSwitchLocal', scope, vertical, to]);
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
    expect(calls.at(-1)).toEqual(['peerSwitchLocal', s, PEER_CALLER, 'off']);
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
