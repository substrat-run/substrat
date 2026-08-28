import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import {
  ControlPlaneClient,
  createControlPlaneApi,
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
