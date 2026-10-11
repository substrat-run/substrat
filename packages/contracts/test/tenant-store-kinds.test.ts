import { describe, expect, it } from 'vitest';
import { deployManifest, manifestStoresOf, runtimeNeeds } from '../src/index.js';

const baseManifest = {
  version: '1.0.0',
  entry: 'index.js',
  compatibilityDate: '2026-07-01',
  registry: { permissions: [], roles: [], entityGrants: [] },
  digests: { manifest: 'm', permission: 'p', migration: 'g' },
};

describe('a per-tenant store is one declaration, two spellings (#2221)', () => {
  it('defaults a tenant store to relational and keeps it on the relational list', () => {
    const needs = runtimeNeeds.parse({ entry: 'src/worker.ts', tenantStores: [{ binding: 'DB' }] });
    expect(manifestStoresOf(needs, false)).toEqual({
      tenantStores: [{ binding: 'DB', kind: 'relational' }],
      blobStores: [],
    });
  });

  it('carries a blob declared on tenantStores in the manifest blob list', () => {
    const needs = runtimeNeeds.parse({
      entry: 'src/worker.ts',
      tenantStores: [{ binding: 'FILES', kind: 'blob' }],
    });
    expect(manifestStoresOf(needs, false)).toEqual({
      tenantStores: [],
      blobStores: [{ binding: 'FILES', kind: 'blob' }],
    });
  });

  it('still accepts the older blobStores spelling', () => {
    const needs = runtimeNeeds.parse({ entry: 'src/worker.ts', blobStores: [{ binding: 'FILES' }] });
    expect(manifestStoresOf(needs, false).blobStores).toEqual([{ binding: 'FILES', kind: 'blob' }]);
  });

  it('refuses a binding named twice across the two spellings', () => {
    const needs = runtimeNeeds.parse({
      entry: 'src/worker.ts',
      tenantStores: [{ binding: 'FILES', kind: 'relational' }],
      blobStores: [{ binding: 'FILES' }],
    });
    expect(() => manifestStoresOf(needs, false)).toThrow(/declares the per-tenant binding 'FILES' twice/);
  });

  it('refuses a binding named twice inside tenantStores', () => {
    const needs = runtimeNeeds.parse({
      entry: 'src/worker.ts',
      tenantStores: [
        { binding: 'FILES', kind: 'blob' },
        { binding: 'FILES', kind: 'relational' },
      ],
    });
    expect(() => manifestStoresOf(needs, false)).toThrow(/twice/);
  });

  it('refuses a kind the declaration does not have', () => {
    expect(() =>
      runtimeNeeds.parse({ entry: 'src/worker.ts', tenantStores: [{ binding: 'DB', kind: 'graph' }] }),
    ).toThrow();
  });

  it('refuses a lowercase binding before it can be bound', () => {
    expect(() =>
      runtimeNeeds.parse({ entry: 'src/worker.ts', tenantStores: [{ binding: 'files', kind: 'blob' }] }),
    ).toThrow();
  });

  it('keeps a blob out of the manifest tenantStores a pre-change control plane parses', () => {
    const refused = deployManifest.safeParse({
      ...baseManifest,
      tenantStores: [{ binding: 'FILES', kind: 'blob' }],
    });
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.issues.map((issue) => issue.path.join('.'))).toContain('tenantStores.0.kind');
    }
    const parsed = deployManifest.parse({
      ...baseManifest,
      blobStores: [{ binding: 'FILES' }],
    });
    expect(parsed.blobStores).toEqual([{ binding: 'FILES', kind: 'blob' }]);
    expect(parsed.tenantStores).toEqual([]);
  });

  it('parses a manifest that predates both lists', () => {
    const parsed = deployManifest.parse(baseManifest);
    expect(parsed.tenantStores).toEqual([]);
    expect(parsed.blobStores).toEqual([]);
  });

  it('treats a blob named ATTACHMENTS as the attachment store, once', () => {
    const needs = runtimeNeeds.parse({
      entry: 'src/worker.ts',
      tenantStores: [{ binding: 'ATTACHMENTS', kind: 'blob' }],
    });
    expect(manifestStoresOf(needs, true).blobStores).toEqual([{ binding: 'ATTACHMENTS', kind: 'blob' }]);
  });

  it('still refuses a relational store named ATTACHMENTS', () => {
    const needs = runtimeNeeds.parse({
      entry: 'src/worker.ts',
      tenantStores: [{ binding: 'ATTACHMENTS' }],
    });
    expect(() => manifestStoresOf(needs, true)).toThrow(/ATTACHMENTS/);
  });
});
