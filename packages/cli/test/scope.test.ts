import { describe, it, expect, afterEach, vi } from 'vitest';
import { bindScopeVersion } from '../src/scope.js';

describe('bindScopeVersion — the per-scope rollout primitive (#509 (c))', () => {
  const orig = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = orig;
    vi.restoreAllMocks();
  });

  it('POSTs versionId to the scope version route and reports the new version', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ verticalVersionId: 'v-9', vertical: 'crm', servingRef: 's1' }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await bindScopeVersion({
      controlPlaneUrl: 'http://cp',
      header: { authorization: 'Bearer t' },
      tenantId: 'acme',
      scopeId: 's-1',
      versionId: 'v-9',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://cp/tenants/acme/scopes/s-1/version');
    expect(calls[0]!.init.method).toBe('POST');
    // `snapshot` omitted (not opted in) — never sent as an explicit false.
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ versionId: 'v-9' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('now runs version v-9'));
  });

  it('sends snapshot:true when --snapshot is passed', async () => {
    let sent: unknown;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ verticalVersionId: 'v-9', vertical: 'crm' }), { status: 200 });
    }) as unknown as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await bindScopeVersion({
      controlPlaneUrl: 'http://cp', header: {}, tenantId: 'acme', scopeId: 's-1', versionId: 'v-9', snapshot: true,
    });
    expect(sent).toEqual({ versionId: 'v-9', snapshot: true });
  });

  it('surfaces the control plane refusal (e.g. a pending version on a serving scope)', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'version v-9 is pending, not admitted — it cannot be bound to a scope' }), {
        status: 409,
      })) as unknown as typeof fetch;

    await expect(
      bindScopeVersion({ controlPlaneUrl: 'http://cp', header: {}, tenantId: 'acme', scopeId: 's-1', versionId: 'v-9' }),
    ).rejects.toThrow(/pending, not admitted/);
  });
});
