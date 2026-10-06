import { describe, it, expect } from 'vitest';
import { PLATFORM_SECRET_HEADER } from '@substrat-run/contracts';
import { ConnectLinkRequestError, listConnectLinks, mintConnectLink, revokeConnectLink } from '../src/index.js';

/**
 * The harness half of a vertical's mailed connect link (connections.md §3.5.4). These helpers
 * decide nothing — the operation checked the permission, the control plane re-derives the
 * vertical — so what is pinned is the wire: which route, the platform secret header, a body
 * that names this scope and only what was asked, and a refusal that keeps its status.
 */
describe('connect-link helpers — the harness effects, the operation decides', () => {
  const access = {
    controlPlaneUrl: 'https://cp.example/',
    platformSecret: 'platform-secret',
    tenantId: '01J000000000000000000TEN',
    scopeId: '01J00000000000000000APP',
  };
  const view = {
    id: '01J0000000000000000000LNK',
    provider: 'fortnox',
    status: 'outstanding',
    createdBy: '01J000000000000000ADMIN',
    subjectRef: 'client-42',
    createdAt: '2026-10-01T09:00:00.000Z',
    expiresAt: '2026-10-08T09:00:00.000Z',
    usedAt: null,
    accountRef: null,
    accountLabel: null,
  };

  /** A fetch that records what it was asked and answers `status` with `body`. */
  const seam = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { calls, fetchImpl, sent: () => JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown> };
  };

  it('mints through /internal/connections/connect-links under the platform secret', async () => {
    const s = seam(200, { url: 'https://app.substrat.net/api/integrations/fortnox/connect?token=t', link: view, vertical: 'bureau-books' });
    const result = await mintConnectLink({
      ...access,
      provider: 'fortnox',
      createdBy: view.createdBy,
      subjectRef: 'client-42',
      ttlSeconds: 3 * 86_400,
      fetchImpl: s.fetchImpl,
    });
    expect(result.link.id).toBe(view.id);
    expect(s.calls[0]!.url).toBe('https://cp.example/internal/connections/connect-links');
    expect(new Headers(s.calls[0]!.init.headers).get(PLATFORM_SECRET_HEADER)).toBe('platform-secret');
    expect(s.sent()).toEqual({
      tenantId: access.tenantId,
      scopeId: access.scopeId,
      provider: 'fortnox',
      createdBy: view.createdBy,
      subjectRef: 'client-42',
      ttlSeconds: 3 * 86_400,
    });
  });

  it('sends no return URL it was not given — a mailed link ends on the platform page', async () => {
    const s = seam(200, { url: 'https://app.substrat.net/x?token=t', link: view, vertical: 'bureau-books' });
    await mintConnectLink({ ...access, provider: 'fortnox', createdBy: view.createdBy, fetchImpl: s.fetchImpl });
    expect(s.sent()).not.toHaveProperty('returnUrl');
    expect(s.sent()).not.toHaveProperty('ttlSeconds');
  });

  it('lists and revokes this scope\'s links through their own routes', async () => {
    const list = seam(200, { links: [view] });
    expect((await listConnectLinks({ ...access, outstanding: true, fetchImpl: list.fetchImpl })).links).toHaveLength(1);
    expect(list.calls[0]!.url).toBe('https://cp.example/internal/connections/connect-links/list');
    expect(list.sent()).toEqual({ tenantId: access.tenantId, scopeId: access.scopeId, outstanding: true });

    const revoke = seam(200, { link: { ...view, status: 'revoked' } });
    expect((await revokeConnectLink({ ...access, linkId: view.id, fetchImpl: revoke.fetchImpl })).link.status).toBe('revoked');
    expect(revoke.calls[0]!.url).toBe('https://cp.example/internal/connections/connect-links/revoke');
    expect(revoke.sent()).toEqual({ tenantId: access.tenantId, scopeId: access.scopeId, linkId: view.id });
  });

  it('throws the relay\'s status and words on a refusal, for each verb', async () => {
    const cases: [() => Promise<unknown>, number][] = [
      [() => mintConnectLink({ ...access, provider: 'fortnox', createdBy: 'x', fetchImpl: seam(403, { error: 'preview' }).fetchImpl }), 403],
      [() => listConnectLinks({ ...access, fetchImpl: seam(503, { error: 'down' }).fetchImpl }), 503],
      [() => revokeConnectLink({ ...access, linkId: view.id, fetchImpl: seam(404, { error: 'unknown connect link' }).fetchImpl }), 404],
    ];
    for (const [run, status] of cases) {
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectLinkRequestError);
      expect((err as ConnectLinkRequestError).status).toBe(status);
    }
    const err = await revokeConnectLink({ ...access, linkId: view.id, fetchImpl: seam(404, { error: 'unknown connect link' }).fetchImpl }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('unknown connect link');
  });

  it('treats a 2xx without the answer it promised as a refusal, not a success', async () => {
    const err = await mintConnectLink({
      ...access,
      provider: 'fortnox',
      createdBy: 'x',
      fetchImpl: seam(200, {}).fetchImpl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectLinkRequestError);
  });
});
