import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import {
  ControlPlaneClient,
  ControlPlaneError,
  createControlPlaneApi,
  identityTenantsResponse,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';
import { DEV_ACTOR_HEADER, SERVICE_TOKEN_HEADER } from '../src/auth.js';

/**
 * The connect seam (first-flow.md slice 4): a vertical registers into a
 * separately-run control plane over HTTP and gates on its authoritative
 * lifecycle. Here the "control plane" is the router over a SqliteScopeHost and
 * the client calls it in-process via `app.fetch` — no network — but the boundary
 * is real: the client only ever sees the HTTP surface, exactly as a separate
 * deployment would.
 */
describe('ControlPlaneClient — the connect seam', () => {
  it('registers a tenant + scope and gates on the remote lifecycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-client-'));
    const host = new SqliteScopeHost({ dir });
    const actor = platformActorId.parse(ulid());
    const app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });

    const client = new ControlPlaneClient({
      baseUrl: 'http://cp.local',
      actor,
      fetch: (input, init) => app.fetch(new Request(input, init)),
    });

    const T = tenantId.parse(ulid());
    const S = scopeId.parse(ulid());

    // The vertical registers itself.
    await client.createTenant({ id: T, slug: 'acme', name: 'Acme' });
    await client.grantEntitlement(T, 'notes');
    // `global` is the only provisionable jurisdiction over HTTP until enforcement
    // exists (K-32); `eu`/`us` are gated at the boundary.
    await client.provisionScope({ tenantId: T, scopeId: S, slug: 'main', vertical: 'demo', jurisdiction: 'global' });
    // Registration and confirmation are the same moment in this direction, but they
    // stay two calls — the directory never decides on its own that a scope is ready.
    await client.activateScope(T, S);

    // Registered and active → the gate passes and the entitlement is visible.
    await expect(client.assertScopeActive(T, S)).resolves.toBeUndefined();
    expect((await client.listEntitlements(T)).map((e) => e.entitlementKey)).toContain('notes');

    // The console suspends the scope on the control plane → the vertical's gate
    // now fails closed, across the HTTP boundary.
    await host.admin.suspendScope(actor, T, S);
    await expect(client.assertScopeActive(T, S)).rejects.toThrow(/scope not active/);

    // Unsuspend → passes again. Suspend the TENANT → the cascade fails closed
    // too, which a scope-status-only check would miss.
    await host.admin.unsuspendScope(actor, T, S);
    await expect(client.assertScopeActive(T, S)).resolves.toBeUndefined();
    await host.admin.setTenantStatus(actor, T, 'suspended');
    await expect(client.assertScopeActive(T, S)).rejects.toThrow(/tenant not active/);
  });

  it('sends one credential: the dev-actor header without a service token, only the token with one (#980)', async () => {
    const seen: Headers[] = [];
    const capture = (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init).headers);
      return Promise.resolve(new Response('{"status":"active"}', { headers: { 'content-type': 'application/json' } }));
    };
    const actor = platformActorId.parse(ulid());
    const T = tenantId.parse(ulid());

    await new ControlPlaneClient({ baseUrl: 'http://cp.local', actor, fetch: capture }).getTenant(T);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.get(DEV_ACTOR_HEADER)).toBe(actor);
    expect(seen[0]!.get(SERVICE_TOKEN_HEADER)).toBeNull();

    await new ControlPlaneClient({ baseUrl: 'http://cp.local', actor, serviceToken: 'svc-token', fetch: capture }).getTenant(T);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.get(SERVICE_TOKEN_HEADER)).toBe('svc-token');
    expect(seen[1]!.get(DEV_ACTOR_HEADER)).toBeNull();
  });

  it('narrows both denial reads through the shared encoder (#971)', async () => {
    // The URL the client builds is the whole of what this method contributes, and it
    // had no test — which is how its copy of the filter encoder could have drifted
    // from the route's decoder without anything going red.
    const seen: string[] = [];
    const capture = (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init).url);
      return Promise.resolve(new Response('[]', { headers: { 'content-type': 'application/json' } }));
    };
    const client = new ControlPlaneClient({
      baseUrl: 'http://cp.local',
      actor: platformActorId.parse(ulid()),
      fetch: capture,
    });
    const T = tenantId.parse(ulid());
    const S = scopeId.parse(ulid());

    await client.listDenials(T, S, { permission: 'perm:use', limit: 5 });
    expect(seen[0]).toBe(`http://cp.local/tenants/${T}/scopes/${S}/denials?permission=perm%3Ause&limit=5`);

    // No filter → no query string at all. The `?` the client used to append
    // unconditionally was harmless but meant the unnarrowed URL was never the one
    // the route tests exercise.
    await client.summarizeDenials(T, S);
    expect(seen[1]).toBe(`http://cp.local/tenants/${T}/scopes/${S}/denials/summary`);
  });

  it('fails closed when the control plane is unreachable', async () => {
    const client = new ControlPlaneClient({
      baseUrl: 'http://cp.local',
      actor: platformActorId.parse(ulid()),
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(
      client.assertScopeActive(tenantId.parse(ulid()), scopeId.parse(ulid())),
    ).rejects.toThrow(/control plane unreachable/);
  });
});

/**
 * The studio's membership read (#971): the one client method whose answer is PARSED, because
 * a cast made every field optimistic — a plane that renamed `entitled`, or answered an
 * `{ error }` body with a 200, handed the gate `entitled: undefined`, falsy, and the studio
 * locked the tenant out with the ordinary "not enabled" page while nothing said the
 * directory had changed shape.
 */
describe('ControlPlaneClient.identityTenants', () => {
  // Real ULIDs: the schema parses the id with the same `tenantId` the `tenant` record
  // publishes, so a placeholder that merely looks id-shaped is refused.
  const TEN1 = '01J8ZQ4T9XK2V7NH3M5PBRWY6C';
  const TEN2 = '01J8ZQ4T9XK2V7NH3M5PBRWY7D';
  const GOOD = {
    tenants: [
      { id: TEN1, slug: 'acme', name: 'Acme', entitled: true },
      { id: TEN2, slug: 'tenant-a', name: 'Tenant A', entitled: false },
    ],
  };

  /** A client whose fetch answers `body` (a string is sent as-is) and records the request. */
  function clientAnswering(body: unknown, status = 200) {
    const seen: { url: string; method: string; headers: Headers; body: string }[] = [];
    const client = new ControlPlaneClient({
      baseUrl: 'https://control-plane/',
      actor: platformActorId.parse(ulid()),
      serviceToken: 'svc-token',
      fetch: async (input, init) => {
        const req = new Request(input, init);
        seen.push({ url: req.url, method: req.method, headers: req.headers, body: await req.text() });
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    return { client, seen };
  }

  it('posts the subject with the service token and parses the answer', async () => {
    const { client, seen } = clientAnswering(GOOD);

    expect(await client.identityTenants('sub-1')).toEqual(GOOD.tenants);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://control-plane/internal/builder/identity-tenants');
    expect(seen[0]!.method).toBe('POST');
    expect(JSON.parse(seen[0]!.body)).toEqual({ externalId: 'sub-1' });
    expect(seen[0]!.headers.get(SERVICE_TOKEN_HEADER)).toBe('svc-token');
    expect(seen[0]!.headers.get(DEV_ACTOR_HEADER)).toBeNull();
  });

  it('answers an empty membership — a login that has not signed up yet', async () => {
    const { client } = clientAnswering({ tenants: [] });
    expect(await client.identityTenants('sub-1')).toEqual([]);
  });

  it("raises the plane's problem document as a ControlPlaneError, detail first", async () => {
    const { client } = clientAnswering(
      {
        type: 'https://substrat.net/problems/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: 'a service token is required for this route',
        error: 'service token required',
      },
      403,
    );

    const err = await client.identityTenants('sub-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).status).toBe(403);
    // The RFC 9457 `detail`, not the deprecated `error` duplicate and not the status line
    // the hand-rolled read used to throw.
    expect((err as ControlPlaneError).message).toBe('a service token is required for this route');
  });

  it('still reads the pre-problem-document { error } refusal', async () => {
    const { client } = clientAnswering({ error: 'service token required' }, 403);
    await expect(client.identityTenants('sub-1')).rejects.toMatchObject({
      name: 'ControlPlaneError',
      status: 403,
      message: 'service token required',
    });
  });

  it('falls back to the status line when a refusal says nothing readable', async () => {
    const { client } = clientAnswering('<html>bad gateway</html>', 502);
    await expect(client.identityTenants('sub-1')).rejects.toMatchObject({
      name: 'ControlPlaneError',
      status: 502,
    });
  });

  it.each([
    ['a renamed collection', { teams: GOOD.tenants }],
    ['an error document answered 200', { error: 'service token required' }],
    ['a missing entitlement flag', { tenants: [{ id: TEN1, slug: 'acme', name: 'Acme' }] }],
    ['a retyped flag', { tenants: [{ ...GOOD.tenants[0], entitled: 'yes' }] }],
    ['a tenant with no id', { tenants: [{ ...GOOD.tenants[0], id: '' }] }],
    ['a bare array', GOOD.tenants],
    ['a non-JSON body', 'not json at all'],
    // The three the `tenant` record's own schemas catch and a generic
    // `z.string().min(1)` would not — each is non-empty and still wrong.
    ['an id that is not a ULID', { tenants: [{ ...GOOD.tenants[0], id: 'tenant-acme' }] }],
    ['a slug with a capital and a space', { tenants: [{ ...GOOD.tenants[0], slug: 'Acme Inc' }] }],
    ['an empty name', { tenants: [{ ...GOOD.tenants[0], name: '' }] }],
  ])('refuses %s with a ControlPlaneError that never names the body', async (_label, body) => {
    const { client } = clientAnswering(body);
    const err = await client.identityTenants('sub-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).message).toMatch(/unexpected shape/);
    // Directory facts about a person's tenants stay out of the message.
    expect((err as ControlPlaneError).message).not.toContain('Acme');
    expect((err as ControlPlaneError).message).not.toContain(TEN1);
  });

  it('fails closed when the control plane is unreachable', async () => {
    const client = new ControlPlaneClient({
      baseUrl: 'https://control-plane',
      actor: platformActorId.parse(ulid()),
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(client.identityTenants('sub-1')).rejects.toMatchObject({
      name: 'ControlPlaneError',
      status: 0,
    });
  });

  it('drops fields the studio does not declare', () => {
    const parsed = identityTenantsResponse.parse({ tenants: [{ ...GOOD.tenants[0], plan: 'enterprise' }] });
    expect(parsed.tenants[0]).toEqual(GOOD.tenants[0]);
  });
});
