import { describe, expect, it } from 'vitest';
import type { HostnameBinding, Scope, Tenant } from '@substrat-run/contracts';
import { requestFailed, requestLoading, requestOk, settleFailure } from '@substrat-run/ui';
import { sidebarCounts, type Fleet } from '../src/lib/fleet';

/**
 * The sidebar's Tenants / Scopes / Domains badges are a claim about the directory (#3244):
 * no answer is no badge, never `0`. The shell passes these straight to `SideNav`, which draws
 * a badge only for a defined `count`.
 */
const fleet = (n: number): Fleet => ({
  tenants: Array.from({ length: n }, () => ({}) as Tenant),
  scopes: Array.from({ length: n + 1 }, () => ({}) as Scope),
  hostnames: Array.from({ length: n + 2 }, () => ({}) as HostnameBinding),
  entitlements: new Map(),
});

describe('sidebar counts', () => {
  it('count only an answer: none while loading or after a failed first read, kept through a failed re-read', () => {
    expect(sidebarCounts(requestLoading())).toEqual({});
    expect(sidebarCounts(requestFailed(new Error('down')))).toEqual({});
    // An answered empty fleet is a real zero.
    expect(sidebarCounts(requestOk(fleet(0)))).toEqual({ tenantCount: 0, scopeCount: 1, hostnameCount: 2 });
    const answered = requestOk(fleet(3));
    expect(sidebarCounts(settleFailure<Fleet>(new Error('poll missed'))(answered))).toEqual({ tenantCount: 3, scopeCount: 4, hostnameCount: 5 });
  });
});
