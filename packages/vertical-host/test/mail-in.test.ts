import { describe, it, expect } from 'vitest';
import { PLATFORM_SECRET_HEADER } from '@substrat-run/contracts';
import { MailInAddressError, mailInAddress } from '../src/index.js';

/**
 * The harness half of a scope's mail-in address (#2611). It decides nothing — the operation
 * checked the permission, the control plane re-derives the landing — so what is pinned is the
 * wire: the route, the platform secret header, a body naming this scope and only what was asked,
 * and a refusal that keeps its status.
 */
describe('mailInAddress — the harness effects, the operation decides', () => {
  const access = {
    controlPlaneUrl: 'https://cp.example/',
    platformSecret: 'platform-secret',
    tenantId: '01J0000000000000000000TENA',
    scopeId: '01J0000000000000000000APPA',
  };
  const address = {
    address: 'docs-abcdefghijklmnop@in.example',
    connectionId: '01J0000000000000000000C0NN',
    tenantId: access.tenantId,
    scopeId: access.scopeId,
    vertical: 'docs',
    operation: 'docs/receive-mail',
    permission: 'docs:receive-mail',
    allowlist: ['me@example.com'],
    createdAt: '2026-10-26T09:00:00.000Z',
    createdBy: '01J000000000000000ADMIN',
    stats: { received: 0, delivered: 0, rejected: 0, deadLettered: 0, pending: 0, lastReceivedAt: null, lastRejectedAt: null, lastRejectReason: null },
  };
  const seam = (status: number, body: unknown) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { calls, fetchImpl, sent: () => JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown> };
  };

  it('posts the action for this scope to the relay, with the platform secret', async () => {
    const s = seam(200, { address });
    const got = await mailInAddress({ ...access, action: 'request', createdBy: '01J000000000000000ADMIN', allowlist: ['me@example.com'], fetchImpl: s.fetchImpl });
    expect(got?.address).toBe(address.address);
    expect(s.calls[0]!.url).toBe('https://cp.example/internal/mail-in/address');
    expect((s.calls[0]!.init.headers as Record<string, string>)[PLATFORM_SECRET_HEADER]).toBe('platform-secret');
    expect(s.sent()).toEqual({ tenantId: access.tenantId, scopeId: access.scopeId, action: 'request', createdBy: '01J000000000000000ADMIN', allowlist: ['me@example.com'] });
  });

  it('answers null for a scope with no address, and sends nothing it was not given', async () => {
    const s = seam(200, { address: null });
    expect(await mailInAddress({ ...access, action: 'get', fetchImpl: s.fetchImpl })).toBeNull();
    expect(s.sent()).toEqual({ tenantId: access.tenantId, scopeId: access.scopeId, action: 'get' });
  });

  it("keeps the platform's refusal and its status", async () => {
    const s = seam(409, { error: "vertical 'docs' declares no mail-in landing" });
    const err = await mailInAddress({ ...access, action: 'request', createdBy: 'p', fetchImpl: s.fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailInAddressError);
    expect(err).toMatchObject({ status: 409, message: expect.stringContaining('declares no mail-in landing') });
  });
});
