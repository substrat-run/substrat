import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox, type ScopeHost } from '@substrat-run/kernel';
import { connectionId, platformActorId, tenantId, type PlatformRequestBacklog } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  firstBuilderAuth,
  mintPushToken,
  pushActorFor,
  pushTokenBuilderAuth,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';
import { CONNECTOR_DEAD_LETTER_CAP } from '../src/api.js';

/**
 * `GET /platform-requests/backlog` (#1690 §2) — the console's Services tile for "is the
 * platform's own intent drain keeping up". Same three-property shape as
 * `connection-health.test.ts`: it counts what `platform-drain.ts` already records, bounded
 * per kind and honest when the bound is hit, and it is staff/service only.
 */
const TENANT_SECRET = 'test-tenant-token-secret';
const PUSH_SECRET = 'test-push-token-secret';

describe('GET /platform-requests/backlog (#1690)', () => {
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const acme = tenantId.parse(ulid());
  const scrive = connectionId.parse(ulid());
  const asStaff = { [DEV_ACTOR_HEADER]: staff };
  let asTenant: Record<string, string>;
  let asBuilder: Record<string, string>;
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  const apiFor = (h: ScopeHost) =>
    createControlPlaneApi({
      host: h,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, serviceActor),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
      tenantTokenSecret: TENANT_SECRET,
      pushTokenSecret: PUSH_SECRET,
    });

  const read = async () => {
    const res = await app.request('/platform-requests/backlog', { headers: asStaff });
    expect(res.status).toBe(200);
    return (await res.json()) as PlatformRequestBacklog;
  };

  const gaveUp = (kind: string) =>
    host.admin.recordOpsFailure({
      actor: staff,
      operation: `intent.${kind}`,
      stage: 'terminal',
      tenantId: acme,
      scopeId: null,
      vertical: 'callout',
      status: 422,
      message: 'platform intent x failed: refused',
      reference: null,
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-platform-request-backlog-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k1', new Uint8Array(32).fill(7)) });
    app = apiFor(host);
    await host.admin.createTenant(staff, { id: acme, slug: 'acme', name: 'Acme' });
    // A `connector:<provider>` kind only exists for a provider some connection names —
    // this is what the route derives the provider half of its kind list from.
    await host.admin.createConnection(staff, {
      id: scrive,
      tenantId: acme,
      vertical: 'callout',
      provider: 'scrive',
      label: 'acme scrive',
      externalAccountRef: 'a1',
      scopes: ['doc:send'],
      secret: { apiToken: 'tok' },
    });

    const minted = await app.request('/tenant-tokens', {
      method: 'POST',
      headers: { ...asStaff, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: acme }),
    });
    expect(minted.status).toBe(201);
    asTenant = { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token };
    const push = await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(acme), tenantId: acme, tenantSlug: 'acme' });
    asBuilder = { [SERVICE_TOKEN_HEADER]: push };
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is zero and uncapped with nothing recorded — its positive twin for the capped case below', async () => {
    const body = await read();
    expect(body.total).toBe(0);
    expect(body.capped).toBe(false);
    expect(body.windowDays).toBeGreaterThan(0);
    expect(Date.parse(body.since)).toBeLessThan(Date.now());
  });

  describe('counting terminal give-ups', () => {
    beforeAll(async () => {
      await gaveUp('provision-sibling');
      await gaveUp('connector:scrive');
      await gaveUp('connector:scrive');
      // Not counted: a non-intent operation, and a status a human already read (never
      // recorded here in the first place — nothing to filter, this just documents it).
      await host.admin.recordOpsFailure({
        actor: staff, operation: 'promote', tenantId: acme,
        scopeId: null, vertical: 'callout', status: 409, message: 'digest changed', reference: null,
      });
    });

    it('sums terminal intent failures across every known kind', async () => {
      const body = await read();
      expect(body.total).toBe(3);
      expect(body.capped).toBe(false);
    });

    it('keeps recent failures after the last live connection is revoked', async () => {
      expect((await read()).total).toBe(3);
      await host.admin.revokeConnection(staff, scrive);
      expect(await host.admin.listConnections(staff)).toEqual([]);
      const body = await read();
      expect(body.total).toBe(3);
      expect(body.capped).toBe(false);
    });

    it('says when a kind hit its bound — the count becomes a floor', async () => {
      for (let i = 0; i < CONNECTOR_DEAD_LETTER_CAP + 1; i++) await gaveUp('connector:scrive');
      const body = await read();
      expect(body.capped).toBe(true);
      // 1 provision-sibling + (2 + CAP+1) scrive give-ups, the scrive kind capped at CAP.
      expect(body.total).toBe(1 + CONNECTOR_DEAD_LETTER_CAP);
    });
  });

  describe('authority — staff/service only', () => {
    it('staff reads it (the positive twin)', async () => {
      expect((await app.request('/platform-requests/backlog', { headers: asStaff })).status).toBe(200);
    });

    it('a tenant token is refused', async () => {
      expect((await app.request('/platform-requests/backlog', { headers: asTenant })).status).toBe(403);
      // …while the same token still reaches a route on its allowlist, so the 403 is this route's.
      expect((await app.request(`/tenants/${acme}/connections`, { headers: asTenant })).status).toBe(200);
    });

    it('a builder token is refused', async () => {
      expect((await app.request('/platform-requests/backlog', { headers: asBuilder })).status).toBe(403);
      // …while the same token still reaches a builder route, so the 403 is this route's.
      expect((await app.request('/sweep-runs', { headers: asBuilder })).status).toBe(200);
    });

    it('no credential at all is 401', async () => {
      expect((await app.request('/platform-requests/backlog')).status).toBe(401);
    });
  });
});
