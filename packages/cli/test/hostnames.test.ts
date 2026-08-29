import { describe, it, expect, afterEach, vi } from 'vitest';
import { bindScopeHostname } from '../src/hostnames.js';

describe('bindScopeHostname — a custom domain on any owned scope (#509 (a))', () => {
  const orig = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = orig;
    vi.restoreAllMocks();
  });

  it('POSTs the domain to /hostnames with the explicit scopeId, non-canonical by default', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ hostname: 'crm-test.ahero.se', scopeId: 's-1', surface: 'app', status: 'verifying', validationRecords: [] }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;

    const row = await bindScopeHostname({
      controlPlaneUrl: 'http://cp',
      header: { authorization: 'Bearer t' },
      tenantId: 'acme',
      scopeId: 's-1',
      surface: 'app',
      domain: 'CRM-Test.Ahero.se',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://cp/hostnames');
    expect(calls[0]!.init.method).toBe('POST');
    // Domain lower-cased; scope addressed directly; canonical defaults false (additive alias).
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      hostname: 'crm-test.ahero.se',
      tenantId: 'acme',
      scopeId: 's-1',
      surface: 'app',
      canonical: false,
    });
    expect(row.status).toBe('verifying');
  });

  it('sends canonical:true when opted in', async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ hostname: 'crm-test.ahero.se', status: 'verifying' }), { status: 201 });
    }) as unknown as typeof fetch;

    await bindScopeHostname({
      controlPlaneUrl: 'http://cp', header: {}, tenantId: 'acme', scopeId: 's-1', surface: 'app',
      domain: 'crm-test.ahero.se', canonical: true,
    });
    expect(sent.canonical).toBe(true);
  });

  it('surfaces a control-plane refusal (e.g. a bare public suffix)', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "'ahero.se' is a registrable suffix — bind a subdomain" }), {
        status: 422,
      })) as unknown as typeof fetch;

    await expect(
      bindScopeHostname({
        controlPlaneUrl: 'http://cp', header: {}, tenantId: 'acme', scopeId: 's-1', surface: 'app', domain: 'ahero.se',
      }),
    ).rejects.toThrow(/registrable suffix/);
  });
});
