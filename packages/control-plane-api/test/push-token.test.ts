import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, tenantId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  firstBuilderAuth,
  mintPushToken,
  pushActorFor,
  pushTokenBuilderAuth,
  verifyPushToken,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';

/**
 * Push tokens (push-token.ts): the tenant-scoped CI credential. The properties that
 * matter: a minted token round-trips to exactly its claim; any tampering fails
 * closed; the reader ignores non-`spt1.` values (so the platform service token falls
 * through untouched); and over the API a push token IS a builder — confined to the
 * builder allowlist and its own tenant's namespace, never staff.
 */
describe('push tokens', () => {
  const SECRET = 'test-push-token-secret';
  const t1 = tenantId.parse(ulid());

  it('mints, verifies, and round-trips the claim', async () => {
    const actor = await pushActorFor(t1);
    const token = await mintPushToken(SECRET, { actor, tenantId: t1, tenantSlug: 'acme' });
    expect(token.startsWith('spt1.')).toBe(true);
    const claim = await verifyPushToken(SECRET, token);
    expect(claim).not.toBeNull();
    expect(claim!.tenantId).toBe(t1);
    expect(claim!.tenantSlug).toBe('acme');
    expect(claim!.actor).toBe(actor);
  });

  it('is deterministic per tenant for the audited actor', async () => {
    expect(await pushActorFor(t1)).toBe(await pushActorFor(t1));
    expect(await pushActorFor(t1)).not.toBe(await pushActorFor(tenantId.parse(ulid())));
  });

  it('refuses a tampered payload, a wrong secret, and a foreign prefix', async () => {
    const actor = await pushActorFor(t1);
    const token = await mintPushToken(SECRET, { actor, tenantId: t1, tenantSlug: 'acme' });
    const [prefix, payload, sig] = token.split('.') as [string, string, string];

    // Payload swapped for another tenant's, signature kept: must not verify.
    const other = await mintPushToken(SECRET, {
      actor,
      tenantId: tenantId.parse(ulid()),
      tenantSlug: 'evil',
    });
    const otherPayload = other.split('.')[1]!;
    expect(await verifyPushToken(SECRET, `${prefix}.${otherPayload}.${sig}`)).toBeNull();

    expect(await verifyPushToken('some-other-secret', token)).toBeNull();
    expect(await verifyPushToken(SECRET, `spt2.${payload}.${sig}`)).toBeNull();
    expect(await verifyPushToken(SECRET, 'not-even-a-token')).toBeNull();
  });

  it('the reader handles only spt1 values in x-service-token, else declines', async () => {
    const auth = pushTokenBuilderAuth(SECRET);
    const actor = await pushActorFor(t1);
    const token = await mintPushToken(SECRET, { actor, tenantId: t1, tenantSlug: 'acme' });

    const withHeader = (v?: string) =>
      new Request('http://cp/verticals', { headers: v ? { [SERVICE_TOKEN_HEADER]: v } : {} });

    const identity = await auth(withHeader(token));
    expect(identity).toEqual({ actor, tenantId: t1, tenantSlug: 'acme' });
    // A random-hex platform service token is not ours to judge — fall through (null).
    expect(await auth(withHeader('a'.repeat(64)))).toBeNull();
    expect(await auth(withHeader())).toBeNull();
  });

  describe('over the API', () => {
    let dir: string;
    let host: SqliteScopeHost;
    let app: ReturnType<typeof createControlPlaneApi>;

    const staff = platformActorId.parse(ulid());
    const staffHeaders = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'cp-push-token-'));
      host = new SqliteScopeHost({ dir });
      app = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(SECRET)),
        pushTokenSecret: SECRET,
      });
      await host.admin.createTenant(staff, { id: t1, slug: 'acme', name: 'Acme' });
    });

    afterAll(async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const mint = () =>
      app.request('/push-tokens', {
        method: 'POST',
        headers: staffHeaders,
        body: JSON.stringify({ tenantId: t1 }),
      });

    it('staff mint a token for a known tenant; unknown tenants 404', async () => {
      const res = await mint();
      expect(res.status).toBe(201);
      const { token, tenantSlug } = (await res.json()) as { token: string; tenantSlug: string };
      expect(token.startsWith('spt1.')).toBe(true);
      expect(tenantSlug).toBe('acme');

      const unknown = await app.request('/push-tokens', {
        method: 'POST',
        headers: staffHeaders,
        body: JSON.stringify({ tenantId: tenantId.parse(ulid()) }),
      });
      expect(unknown.status).toBe(404);
    });

    it('a push token acts as a BUILDER: allowlisted routes only, own namespace only', async () => {
      const { token } = (await (await mint()).json()) as { token: string };
      const asCi = { [SERVICE_TOKEN_HEADER]: token, 'content-type': 'application/json' };

      // In: the builder surface (its own — empty — vertical list).
      const list = await app.request('/verticals', { headers: asCi });
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({ entries: [], nextCursor: null });

      // Out: everything off the allowlist — staff registry reads, minting more tokens.
      expect((await app.request('/tenants', { headers: asCi })).status).toBe(403);
      const selfMint = await app.request('/push-tokens', {
        method: 'POST',
        headers: asCi,
        body: JSON.stringify({ tenantId: t1 }),
      });
      expect(selfMint.status).toBe(403);

      // Out: prod promotion stays staff-only for ANY builder, push tokens included.
      const promote = await app.request('/verticals/some-app/channels/prod/promote', {
        method: 'POST',
        headers: asCi,
        body: JSON.stringify({ versionId: ulid() }),
      });
      expect(promote.status).toBe(403);
    });

    it('501s the mint when no secret is configured', async () => {
      const bare = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
      const res = await bare.request('/push-tokens', {
        method: 'POST',
        headers: staffHeaders,
        body: JSON.stringify({ tenantId: t1 }),
      });
      expect(res.status).toBe(501);
    });
  });
});
