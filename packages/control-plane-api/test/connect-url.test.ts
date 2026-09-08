import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, verifyConnectState, webCryptoSecretBox } from '@substrat-run/kernel';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { relayConnectUrl, ConnectUrlRelayError } from '../src/index.js';

/**
 * The connect-url relay (connections.md §3.5.3) — a vertical starts a provider consent
 * round for its own user, who has no dashboard account. The properties under test are
 * the relay's: the vertical is re-derived from the directory rather than taken from the
 * caller, the authorizing principal is carried into the state (never a platform actor),
 * the return URL cannot leave the scope's own hostnames, and a deployment that cannot
 * run a round says so rather than minting a URL that dead-ends.
 */
describe('relayConnectUrl — /internal/connections/connect-url logic', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const relayActor = platformActorId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const bare = scopeId.parse(ulid()); // provisioned with no vertical
  const t2 = tenantId.parse(ulid());
  const s2 = scopeId.parse(ulid());
  const admin = principalId.parse(ulid()); // the bureau's own admin, not a dashboard member

  const PLATFORM_SECRET = 'platform-secret-value-32-bytes-min';
  const options = {
    connectOrigin: 'https://app.substrat.net',
    platformSecret: PLATFORM_SECRET,
    flows: { fortnox: { startPath: '/api/integrations/fortnox/connect' } },
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-connect-url-'));
    host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k1', new Uint8Array(32).fill(7)),
    });
    await host.admin.createTenant(staff, { id: t1, slug: 'bureau', name: 'Bureau' });
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'bureau-books' });
    await host.provisionScope(staff, { tenantId: t1, scopeId: bare });
    await host.admin.createTenant(staff, { id: t2, slug: 'other', name: 'Other' });
    await host.provisionScope(staff, { tenantId: t2, scopeId: s2, vertical: 'other-vert' });
    await host.admin.bindHostname(staff, {
      hostname: 'books.bureau.example',
      tenantId: t1,
      scopeId: s1,
      surface: 'app',
      region: null,
      canonical: true,
    });
    // The other tenant's surface — a hostname that exists, but not on s1.
    await host.admin.bindHostname(staff, {
      hostname: 'other.example',
      tenantId: t2,
      scopeId: s2,
      surface: 'app',
      region: null,
      canonical: true,
    });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const request = (over: Record<string, unknown> = {}) => ({
    tenantId: t1,
    scopeId: s1,
    provider: 'fortnox',
    createdBy: admin,
    ...over,
  });

  const stateOf = async (url: string) =>
    verifyConnectState(PLATFORM_SECRET, new URL(url).searchParams.get('token') ?? '', Date.now());

  it('mints a URL on the platform connect origin, carrying a state only the platform could sign', async () => {
    const result = await relayConnectUrl(host, relayActor, request(), options);
    const url = new URL(result.url);
    expect(url.origin).toBe('https://app.substrat.net');
    expect(url.pathname).toBe('/api/integrations/fortnox/connect');
    expect(await stateOf(result.url)).toMatchObject({
      tenantId: t1,
      scopeId: s1,
      provider: 'fortnox',
      // Re-derived from the scope record — the request never named it.
      vertical: 'bureau-books',
      // §3.5.1: the authorizing tenant principal, never the platform actor.
      principal: admin,
    });
    expect(result.vertical).toBe('bureau-books');
  });

  it('carries the vertical\'s own subject reference through untouched', async () => {
    const result = await relayConnectUrl(host, relayActor, request({ subjectRef: 'client-42' }), options);
    expect(await stateOf(result.url)).toMatchObject({ subjectRef: 'client-42' });
  });

  it('answers an expiry, and clamps the round to fifteen minutes', async () => {
    const before = Date.now();
    const result = await relayConnectUrl(host, relayActor, request(), options);
    const ms = Date.parse(result.expiresAt) - before;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(900_000 + 1_000);
    // The schema is what refuses a wider window, so a caller cannot buy itself a
    // consent URL that outlives the click it was minted for.
    await expect(relayConnectUrl(host, relayActor, request({ ttlSeconds: 86_400 }), options)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('refuses a scope with no vertical bound', async () => {
    await expect(relayConnectUrl(host, relayActor, request({ scopeId: bare }), options)).rejects.toMatchObject({
      status: 404,
    });
  });

  // The whole trust posture: PLATFORM_SECRET is shared across every dispatch script, so a
  // caller naming another tenant's scope must not thereby borrow that tenant's vertical.
  it('derives the vertical from the named scope, so a caller cannot mint for a foreign one', async () => {
    const result = await relayConnectUrl(host, relayActor, request({ tenantId: t2, scopeId: s2 }), options);
    expect(await stateOf(result.url)).toMatchObject({ vertical: 'other-vert', tenantId: t2 });
    // …and naming a scope that is not in the tenant it claims resolves to nothing at all.
    await expect(relayConnectUrl(host, relayActor, request({ tenantId: t1, scopeId: s2 }), options)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses a provider with no platform-hosted consent round, naming the paste door', async () => {
    await expect(relayConnectUrl(host, relayActor, request({ provider: 'scrive' }), options)).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining('/internal/connections/upsert'),
    });
  });

  describe('returnUrl — the consent may only return to a surface this scope answers on', () => {
    it('accepts a hostname bound to this scope', async () => {
      const result = await relayConnectUrl(
        host,
        relayActor,
        request({ returnUrl: 'https://books.bureau.example/clients/42' }),
        options,
      );
      expect(await stateOf(result.url)).toMatchObject({ returnUrl: 'https://books.bureau.example/clients/42' });
    });

    // Without this the platform's own consent origin becomes an open redirect — and it is
    // the origin the dashboard's session cookie lives on.
    it('refuses a hostname bound to nothing', async () => {
      await expect(
        relayConnectUrl(host, relayActor, request({ returnUrl: 'https://evil.example/steal' }), options),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('refuses another scope\'s hostname, even inside the same platform', async () => {
      await expect(
        relayConnectUrl(host, relayActor, request({ returnUrl: 'https://other.example/' }), options),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('refuses plaintext and credential-bearing URLs', async () => {
      await expect(
        relayConnectUrl(host, relayActor, request({ returnUrl: 'http://books.bureau.example/' }), options),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        relayConnectUrl(host, relayActor, request({ returnUrl: 'https://u:p@books.bureau.example/' }), options),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('a deployment that cannot run a round says so', () => {
    it('503s with no connect origin configured', async () => {
      await expect(
        relayConnectUrl(host, relayActor, request(), { ...options, connectOrigin: undefined }),
      ).rejects.toMatchObject({ status: 503, message: expect.stringContaining('PLATFORM_CONNECT_URL') });
    });

    it('503s with no platform secret to sign with', async () => {
      await expect(
        relayConnectUrl(host, relayActor, request(), { ...options, platformSecret: undefined }),
      ).rejects.toMatchObject({ status: 503, message: expect.stringContaining('PLATFORM_SECRET') });
    });

    // Ahead of the directory read: both are knowable at boot, and an operator reading
    // "scope has no vertical" would go looking in the wrong place entirely.
    it('reports the deployment fault before the request fault', async () => {
      await expect(
        relayConnectUrl(host, relayActor, request({ scopeId: bare }), { ...options, connectOrigin: undefined }),
      ).rejects.toMatchObject({ status: 503 });
    });
  });

  it('rejects a malformed body with a message naming the field', async () => {
    const err = await relayConnectUrl(host, relayActor, { tenantId: t1 }, options).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectUrlRelayError);
    expect(err.status).toBe(400);
  });
});
