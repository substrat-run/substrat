import { describe, expect, it } from 'vitest';
import type { BlobStoreRecord, TenantStoreRecord } from '@substrat-run/kernel';
import {
  d1DatabaseUrl,
  dispatchScriptUrl,
  doNamespaceUrl,
  durableObjectsUrl,
  r2BucketUrl,
  scopeDoName,
  storesForScope,
  workerServiceUrl,
  type PlatformRuntime,
} from '../src/lib/cf-links';

/**
 * The dashboard-link builders. The property under test is not the URL text — Cloudflare
 * owns that and may reshuffle it — but the rule that protects the operator: a link is
 * built ONLY from coordinates we actually have. Anything missing degrades to `null`,
 * which the views render as the plain identifier they showed before, never as a link
 * that lands on someone else's account or a 404.
 */

const RUNTIME: PlatformRuntime = {
  provider: 'cloudflare',
  accountId: 'acct-123',
  dispatchNamespace: 'substrat-verticals',
};

describe('cf-links', () => {
  it('builds account-scoped links for every resource kind', () => {
    // Shapes verified against the dashboard 2026-08-07 (a real account's D1, R2, WfP script,
    // Worker and DO namespace URLs). This test is where a dashboard reshuffle gets caught.
    expect(dispatchScriptUrl(RUNTIME, 'crm-serving')).toBe(
      'https://dash.cloudflare.com/acct-123/workers-for-platforms/namespaces/substrat-verticals/scripts/crm-serving',
    );
    expect(doNamespaceUrl(RUNTIME, '32841fe27d0f4fe8ab47d8b06fb0e016')).toBe(
      'https://dash.cloudflare.com/acct-123/workers/durable-objects/view/32841fe27d0f4fe8ab47d8b06fb0e016',
    );
    expect(d1DatabaseUrl(RUNTIME, 'db-uuid')).toBe(
      'https://dash.cloudflare.com/acct-123/workers/d1/databases/db-uuid',
    );
    expect(r2BucketUrl(RUNTIME, 'tenant-files')).toBe(
      'https://dash.cloudflare.com/acct-123/r2/default/buckets/tenant-files',
    );
    expect(workerServiceUrl(RUNTIME, 'substrat-control-plane')).toBe(
      'https://dash.cloudflare.com/acct-123/workers/services/view/substrat-control-plane/production',
    );
    expect(durableObjectsUrl(RUNTIME)).toBe(
      'https://dash.cloudflare.com/acct-123/workers/durable-objects',
    );
  });

  it('returns null with no runtime — a self-host console shows ids, not links', () => {
    expect(dispatchScriptUrl(null, 'crm-serving')).toBeNull();
    expect(d1DatabaseUrl(null, 'db-uuid')).toBeNull();
    expect(r2BucketUrl(null, 'tenant-files')).toBeNull();
    expect(durableObjectsUrl(null)).toBeNull();
  });

  it('falls back to the namespace LIST when no namespace id resolved', () => {
    // The scope-detail card renders `doNamespaceUrl(…) ?? durableObjectsUrl(…)`: an
    // unconfigured lookup or a failed read costs precision, never the link itself.
    expect(doNamespaceUrl(RUNTIME, null)).toBeNull();
    expect(doNamespaceUrl(RUNTIME, null) ?? durableObjectsUrl(RUNTIME)).toBe(
      'https://dash.cloudflare.com/acct-123/workers/durable-objects',
    );
  });

  it('returns null for a missing ref rather than a link to the account root', () => {
    // A scope that never adopted a serving script, a ledger row not yet minted: the
    // absence is the fact, and half a URL would send staff somewhere arbitrary.
    expect(dispatchScriptUrl(RUNTIME, null)).toBeNull();
    expect(dispatchScriptUrl(RUNTIME, '')).toBeNull();
    expect(d1DatabaseUrl(RUNTIME, undefined)).toBeNull();
    expect(r2BucketUrl(RUNTIME, '')).toBeNull();
  });

  it('refuses to guess a dashboard shape for a substrate it does not know', () => {
    const elsewhere = { ...RUNTIME, provider: 'fly' as unknown as 'cloudflare' };
    expect(dispatchScriptUrl(elsewhere, 'crm-serving')).toBeNull();
    expect(d1DatabaseUrl(elsewhere, 'db-uuid')).toBeNull();
  });

  it('escapes refs that would otherwise break out of the path', () => {
    // A bucket name or script name is provider-shaped, not free text — but it reaches
    // this module through an API response, so it is encoded rather than trusted.
    expect(r2BucketUrl(RUNTIME, 'weird/name')).toBe(
      'https://dash.cloudflare.com/acct-123/r2/default/buckets/weird%2Fname',
    );
    expect(dispatchScriptUrl(RUNTIME, 'a/b')).toContain('/namespaces/substrat-verticals/scripts/a%2Fb');
  });

  it('names a scope’s Durable Object by the scope id — the only handle a human can carry', () => {
    // `SCOPE.idFromName(scopeId)` in the adapter: the hex object id is a hash we cannot
    // compute here, so the NAME is what makes the dashboard's DO list navigable.
    expect(scopeDoName('01JZSCOPE')).toBe('01JZSCOPE');
  });

  describe('storesForScope', () => {
    const row = (vertical: string, binding: string, ref: string): TenantStoreRecord => ({
      tenantId: 't1' as TenantStoreRecord['tenantId'],
      vertical,
      binding,
      kind: 'relational',
      ref,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    const blob = (vertical: string, binding: string, ref: string): BlobStoreRecord => ({
      tenantId: 't1' as BlobStoreRecord['tenantId'],
      vertical,
      binding,
      kind: 'blob',
      ref,
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    const stores = {
      tenantStores: [row('crm', 'AUTH_DB', 'db-crm'), row('shop', 'AUTH_DB', 'db-shop')],
      blobStores: [blob('crm', 'FILES', 'bucket-crm'), blob('shop', 'FILES', 'bucket-shop')],
    };

    it('narrows the tenant-wide ledgers to the vertical the scope runs', () => {
      // The ledger is per (tenant, vertical, binding): a scope must never be shown the
      // database of a DIFFERENT vertical the same tenant happens to also run.
      const mine = storesForScope(stores, 'crm');
      expect(mine.tenantStores.map((s) => s.ref)).toEqual(['db-crm']);
      expect(mine.blobStores.map((s) => s.ref)).toEqual(['bucket-crm']);
    });

    it('shows nothing for a scope with no vertical bound, or before the read lands', () => {
      expect(storesForScope(stores, null)).toEqual({ tenantStores: [], blobStores: [] });
      expect(storesForScope(null, 'crm')).toEqual({ tenantStores: [], blobStores: [] });
    });
  });
});
