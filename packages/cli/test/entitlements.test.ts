import { afterEach, describe, expect, it } from 'vitest';
import { formatEntitlements, grantEntitlement, planOf, revokeEntitlement } from '../src/entitlements.js';

const target = { controlPlaneUrl: 'http://cp', header: { authorization: 'Bearer t' }, tenantId: 'T1' };
const row = { entitlementKey: 'drive-vertical', plan: 'pro', quota: 5, expiresAt: null, grantedAt: null, grantedBy: null };

describe('substrat entitlements', () => {
  const orig = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = orig;
  });

  it('grant PUTs the plan to the path-encoded key and prints the resulting list', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json([row]);
    }) as unknown as typeof fetch;

    const rows = await grantEntitlement(target, 't-01/drive', planOf({ plan: 'pro', quota: '5' }));

    expect(calls[0]!.url).toBe('http://cp/tenants/T1/entitlements/t-01%2Fdrive');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ plan: 'pro', quota: 5 });
    expect(formatEntitlements(rows)).toBe('drive-vertical  pro         5       perpetual');
  });

  it("revoke shows the plane's refusal of a tenant credential", async () => {
    globalThis.fetch = (async () =>
      Response.json({ error: 'staff only', title: 'Forbidden', status: 403, detail: 'revoking an entitlement is staff-only', code: 'permission_denied' }, { status: 403 })) as unknown as typeof fetch;

    await expect(revokeEntitlement(target, 'drive')).rejects.toThrow(/entitlements revoke refused \(403 permission_denied\): revoking an entitlement is staff-only/);
  });

  it('a quota that is not a positive integer is refused before the wire', () => {
    expect(() => planOf({ quota: 'many' })).toThrow('--quota must be a positive integer');
    expect(planOf({})).toBeUndefined();
  });
});
