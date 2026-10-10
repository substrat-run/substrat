import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, verifyConnectState } from '@substrat-run/kernel';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import {
  relayConnectLinkMint,
  relayConnectLinkList,
  relayConnectLinkRevoke,
  ConnectUrlRelayError,
  PREVIEW_CONNECTIONS_REFUSAL,
} from '../src/index.js';

/**
 * The connect-LINK relays (connections.md §3.5.4) — a vertical mints a link to MAIL, lists
 * the ones it minted, and withdraws one. What is under test is the relay's half: the row is
 * written with the vertical the directory has (never the caller's word), the signed state
 * names the row and dies with it, the link is a week by default and a month at most — a
 * different authority from the 15-minute connect URL, not a wider one — and list and revoke
 * reach only links the caller names by id, and only the named scope's. The row's own
 * lifecycle is the contract suite's.
 */
describe('connect-link relays — /internal/connections/connect-links{,/list,/revoke}', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const relayActor = platformActorId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const s1b = scopeId.parse(ulid()); // a second install of the same tenant
  const preview = scopeId.parse(ulid());
  const bare = scopeId.parse(ulid());
  const t2 = tenantId.parse(ulid());
  const s2 = scopeId.parse(ulid());
  const admin = principalId.parse(ulid());

  const PLATFORM_SECRET = 'platform-secret-value-32-bytes-min';
  const options = {
    connectOrigin: 'https://app.substrat.net',
    platformSecret: PLATFORM_SECRET,
    flows: { fortnox: { startPath: '/api/integrations/fortnox/connect' } },
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-connect-links-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: t1, slug: 'bureau', name: 'Bureau' });
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'bureau-books' });
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1b, vertical: 'bureau-books' });
    await host.provisionScope(staff, { tenantId: t1, scopeId: preview, vertical: 'bureau-books', kind: 'preview' });
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

  it('writes a row and answers a URL whose state names it, on the platform connect origin', async () => {
    const before = Date.now();
    const result = await relayConnectLinkMint(host, relayActor, request({ subjectRef: 'client-42' }), options);
    const url = new URL(result.url);
    expect(url.origin + url.pathname).toBe('https://app.substrat.net/api/integrations/fortnox/connect');
    expect(result.vertical).toBe('bureau-books');
    expect(result.link).toMatchObject({ provider: 'fortnox', status: 'outstanding', createdBy: admin, subjectRef: 'client-42' });
    // A week by default — the mailed case — and the state lives exactly as long as the row.
    const life = Date.parse(result.link.expiresAt) - before;
    expect(life).toBeGreaterThan(7 * 86_400_000 - 5_000);
    expect(life).toBeLessThanOrEqual(7 * 86_400_000 + 5_000);
    const state = await stateOf(result.url);
    expect(state).toMatchObject({
      tenantId: t1,
      scopeId: s1,
      vertical: 'bureau-books',
      principal: admin,
      subjectRef: 'client-42',
      linkId: result.link.id,
      exp: Date.parse(result.link.expiresAt),
    });
    // The row is the platform's, in the directory, under the vertical the directory has.
    expect(await host.admin.getConnectLink(staff, { tenantId: t1, scopeId: s1, id: result.link.id })).toMatchObject({
      vertical: 'bureau-books',
      status: 'outstanding',
    });
    // The view a vertical gets back echoes no tenant, scope or return URL.
    expect(Object.keys(result.link)).not.toEqual(expect.arrayContaining(['tenantId', 'scopeId', 'returnUrl']));
  });

  it('allows up to thirty days and refuses more — the URL relay keeps its fifteen minutes', async () => {
    const month = await relayConnectLinkMint(host, relayActor, request({ ttlSeconds: 30 * 86_400 }), options);
    expect(Date.parse(month.link.expiresAt) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    await expect(
      relayConnectLinkMint(host, relayActor, request({ ttlSeconds: 30 * 86_400 + 1 }), options),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('derives the vertical from the directory and refuses a scope outside the named tenant', async () => {
    const other = await relayConnectLinkMint(host, relayActor, request({ tenantId: t2, scopeId: s2 }), options);
    expect(other.vertical).toBe('other-vert');
    await expect(
      relayConnectLinkMint(host, relayActor, request({ tenantId: t1, scopeId: s2 }), options),
    ).rejects.toMatchObject({ status: 404 });
    await expect(relayConnectLinkMint(host, relayActor, request({ scopeId: bare }), options)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses a preview: no link is minted for a scope with no connections of its own (#2005)', async () => {
    await expect(relayConnectLinkMint(host, relayActor, request({ scopeId: preview }), options)).rejects.toMatchObject({
      status: 403,
      message: PREVIEW_CONNECTIONS_REFUSAL,
    });
    expect(await host.admin.listConnectLinks(staff, { tenantId: t1, scopeId: preview })).toEqual([]);
  });

  it('holds returnUrl to the scope\'s own hostnames, and writes no row when it is refused', async () => {
    const ok = await relayConnectLinkMint(
      host,
      relayActor,
      request({ returnUrl: 'https://books.bureau.example/clients/42' }),
      options,
    );
    expect(await stateOf(ok.url)).toMatchObject({ returnUrl: 'https://books.bureau.example/clients/42' });
    const before = (await host.admin.listConnectLinks(staff, { tenantId: t1, scopeId: s1 })).length;
    await expect(
      relayConnectLinkMint(host, relayActor, request({ returnUrl: 'https://evil.example/' }), options),
    ).rejects.toMatchObject({ status: 400 });
    expect(await host.admin.listConnectLinks(staff, { tenantId: t1, scopeId: s1 })).toHaveLength(before);
  });

  it('says so when the deployment cannot run a round, before touching the directory', async () => {
    await expect(
      relayConnectLinkMint(host, relayActor, request({ scopeId: bare }), { ...options, connectOrigin: undefined }),
    ).rejects.toMatchObject({ status: 503, message: expect.stringContaining('PLATFORM_CONNECT_URL') });
    await expect(
      relayConnectLinkMint(host, relayActor, request(), { ...options, platformSecret: undefined }),
    ).rejects.toMatchObject({ status: 503, message: expect.stringContaining('PLATFORM_SECRET') });
    await expect(relayConnectLinkMint(host, relayActor, request({ provider: 'scrive' }), options)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('lists only the links it is named, newest first, and narrows to the ones that still open', async () => {
    const a = await relayConnectLinkMint(host, relayActor, request({ scopeId: s1b }), options);
    const b = await relayConnectLinkMint(host, relayActor, request({ scopeId: s1b }), options);
    const unnamed = await relayConnectLinkMint(host, relayActor, request({ scopeId: s1b }), options);
    await relayConnectLinkRevoke(host, relayActor, { tenantId: t1, scopeId: s1b, linkId: a.link.id });
    const linkIds = [a.link.id, b.link.id];
    const all = await relayConnectLinkList(host, relayActor, { tenantId: t1, scopeId: s1b, linkIds });
    expect(all.links.map((l) => l.id)).toEqual([b.link.id, a.link.id]);
    expect(all.links.map((l) => l.id)).not.toContain(unnamed.link.id);
    const open = await relayConnectLinkList(host, relayActor, { tenantId: t1, scopeId: s1b, linkIds, outstanding: true });
    expect(open.links.map((l) => l.id)).toEqual([b.link.id]);
  });

  it('omits a named id that is not the named scope\'s — another install, another tenant, or none', async () => {
    const mine = await relayConnectLinkMint(host, relayActor, request(), options);
    const sibling = await relayConnectLinkMint(host, relayActor, request({ scopeId: s1b }), options);
    const foreign = await relayConnectLinkMint(host, relayActor, request({ tenantId: t2, scopeId: s2 }), options);
    const listed = await relayConnectLinkList(host, relayActor, {
      tenantId: t1,
      scopeId: s1,
      linkIds: [mine.link.id, sibling.link.id, foreign.link.id, ulid()],
    });
    expect(listed.links.map((l) => l.id)).toEqual([mine.link.id]);
    // The foreign tenant's own scope, named with the bureau's id, finds nothing either.
    const reversed = await relayConnectLinkList(host, relayActor, { tenantId: t2, scopeId: s2, linkIds: [mine.link.id] });
    expect(reversed.links).toEqual([]);
  });

  it('refuses a list that names no link: there is no browse of a scope', async () => {
    for (const body of [
      { tenantId: t1, scopeId: s1 },
      { tenantId: t1, scopeId: s1, linkIds: [] },
      { tenantId: t1, scopeId: s1, linkIds: Array.from({ length: 101 }, () => ulid()) },
      { tenantId: t1, scopeId: s1, linkIds: ['not-a-ulid'] },
    ]) {
      await expect(relayConnectLinkList(host, relayActor, body)).rejects.toMatchObject({ status: 400 });
    }
    const hundred = Array.from({ length: 100 }, () => ulid());
    expect((await relayConnectLinkList(host, relayActor, { tenantId: t1, scopeId: s1, linkIds: hundred })).links).toEqual([]);
  });

  it('revokes idempotently, and another scope naming the id gets a 404', async () => {
    const minted = await relayConnectLinkMint(host, relayActor, request(), options);
    const key = { tenantId: t1, scopeId: s1, linkId: minted.link.id };
    for (const foreign of [
      { ...key, scopeId: s1b },
      { ...key, tenantId: t2, scopeId: s2 },
    ]) {
      await expect(relayConnectLinkRevoke(host, relayActor, foreign)).rejects.toMatchObject({ status: 404 });
    }
    expect((await relayConnectLinkRevoke(host, relayActor, key)).link.status).toBe('revoked');
    expect((await relayConnectLinkRevoke(host, relayActor, key)).link.status).toBe('revoked');
    await expect(
      relayConnectLinkRevoke(host, relayActor, { ...key, linkId: ulid() }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses list and revoke from a preview, as it refuses the mint', async () => {
    await expect(
      relayConnectLinkList(host, relayActor, { tenantId: t1, scopeId: preview, linkIds: [ulid()] }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      relayConnectLinkRevoke(host, relayActor, { tenantId: t1, scopeId: preview, linkId: ulid() }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects malformed bodies as a 400 naming the field', async () => {
    for (const run of [
      () => relayConnectLinkMint(host, relayActor, { tenantId: t1 }, options),
      () => relayConnectLinkList(host, relayActor, { tenantId: t1 }),
      () => relayConnectLinkRevoke(host, relayActor, { tenantId: t1, scopeId: s1, linkId: 'not-a-ulid' }),
    ]) {
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectUrlRelayError);
      expect((err as ConnectUrlRelayError).status).toBe(400);
    }
  });
});
