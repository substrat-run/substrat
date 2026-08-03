import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPermissionRegistry,
  definePermissions,
  runtimeNeeds,
  RUNTIME_BASELINE,
  type PermissionRegistry,
} from '@substrat-run/contracts';
import { wranglerConfigFor, readRuntimeNeeds, resolveWranglerConfig, deriveRegistry, permissionDigest, readVerticalMeta } from '../src/push.js';

const scratch = (pkg?: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-cli-test-'));
  if (pkg !== undefined) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
};

describe('wranglerConfigFor — the Substrat→Cloudflare mapping (D-38)', () => {
  it('maps a full runtimeNeeds to the wrangler shape push extraction reads', () => {
    const cfg = wranglerConfigFor(
      runtimeNeeds.parse({
        entry: 'src/worker.ts',
        needsNodeCompat: true,
        build: 'pnpm --dir app build',
        stores: [
          { binding: 'SCOPE', class: 'ScopeDO' },
          { binding: 'AUTH', class: 'IdentityDO' },
        ],
      }),
    );
    expect(cfg).toEqual({
      name: 'substrat-vertical',
      main: 'src/worker.ts',
      compatibility_date: RUNTIME_BASELINE,
      compatibility_flags: ['nodejs_compat'],
      workers_dev: false,
      build: { command: 'pnpm --dir app build' },
      durable_objects: {
        bindings: [
          { name: 'SCOPE', class_name: 'ScopeDO' },
          { name: 'AUTH', class_name: 'IdentityDO' },
        ],
      },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['ScopeDO', 'IdentityDO'] }],
    });
  });

  it('a minimal vertical gets the platform baseline and nothing it did not ask for', () => {
    const cfg = wranglerConfigFor(runtimeNeeds.parse({ entry: 'src/worker.ts' }));
    expect(cfg).toEqual({
      name: 'substrat-vertical',
      main: 'src/worker.ts',
      compatibility_date: RUNTIME_BASELINE,
      compatibility_flags: [],
      workers_dev: false,
    });
  });

  it('the builder never picks the compatibility date — it is always the baseline', () => {
    const cfg = wranglerConfigFor(runtimeNeeds.parse({ entry: 'a.ts' }));
    expect(cfg.compatibility_date).toBe(RUNTIME_BASELINE);
  });
});

describe('readRuntimeNeeds', () => {
  it('parses package.json substrat.runtimeNeeds with defaults applied', () => {
    const dir = scratch({ substrat: { runtimeNeeds: { entry: 'src/worker.ts' } } });
    expect(readRuntimeNeeds(dir)).toEqual({
      entry: 'src/worker.ts',
      needsNodeCompat: false,
      stores: [],
      tenantStores: [],
      blobStores: [],
    });
  });

  it('is undefined when the block (or package.json) is absent — the wrangler.jsonc path', () => {
    expect(readRuntimeNeeds(scratch({ substrat: { slug: 'x' } }))).toBeUndefined();
    expect(readRuntimeNeeds(scratch())).toBeUndefined();
  });

  it('rejects an invalid declaration instead of pushing something else', () => {
    const dir = scratch({
      substrat: { runtimeNeeds: { entry: 'a.ts', stores: [{ binding: 'lower', class: 'X' }] } },
    });
    expect(() => readRuntimeNeeds(dir)).toThrow();
  });
});

describe('deriveRegistry — the declared permission surface, derived at push (D-41)', () => {
  // The guard paths (absence is never a silent empty surface). The esbuild-bundle-and-import
  // happy path can't run under vitest's module runner (it won't load a runtime temp file); it is
  // covered end-to-end against real verticals in the build's node integration + the push dry-run,
  // and the pure derivation it delegates to (`buildPermissionRegistry`) is unit-tested in contracts.
  it('throws when package.json declares no substrat.permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-cli-noptr-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    await expect(deriveRegistry(dir)).rejects.toThrow(/declares no permission surface/);
  });

  it('throws when the declared entry does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-cli-noent-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ substrat: { permissions: 'missing.mjs' } }));
    await expect(deriveRegistry(dir)).rejects.toThrow(/does not exist/);
  });
});

describe('buildPermissionRegistry — the pure derivation deriveRegistry delegates to (D-41)', () => {
  const mod = (id: string, perms: [string, string][]) => ({
    manifest: { id, permissions: perms.map(([key, description]) => ({ key, description })) },
  });

  it('derives declaredBy, sorts every array, and is order-independent', () => {
    const surface = definePermissions({
      // Deliberately unsorted; the output must be canonical regardless.
      modules: [
        mod('@substrat-run/engine-b', [['b:write', 'Write'], ['b:read', 'Read']]),
        mod('@substrat-run/engine-a', [['a:read', 'Read']]),
      ] as never,
      roles: [
        { key: 'staff', permissions: ['b:write', 'a:read'] as never, source: 'vertical' },
        { key: 'admin', permissions: ['a:read'] as never, source: 'vertical' },
      ],
      entityGrants: [{ entityType: 'order', permissions: ['a:read'] as never }],
    });
    expect(buildPermissionRegistry(surface)).toEqual({
      permissions: [
        { key: 'a:read', description: 'Read', declaredBy: ['@substrat-run/engine-a'] },
        { key: 'b:read', description: 'Read', declaredBy: ['@substrat-run/engine-b'] },
        { key: 'b:write', description: 'Write', declaredBy: ['@substrat-run/engine-b'] },
      ],
      roles: [
        { key: 'admin', permissions: ['a:read'], source: 'vertical' },
        { key: 'staff', permissions: ['a:read', 'b:write'], source: 'vertical' },
      ],
      entityGrants: [{ entityType: 'order', permissions: ['a:read'] }],
    });
  });

  it('folds a key declared by two modules into one entry carrying both', () => {
    const reg = buildPermissionRegistry({
      modules: [
        mod('@substrat-run/engine-b', [['shared:key', 'Shared']]),
        mod('@substrat-run/engine-a', [['shared:key', 'Shared']]),
      ] as never,
      roles: [],
    });
    expect(reg.permissions).toEqual([
      { key: 'shared:key', description: 'Shared', declaredBy: ['@substrat-run/engine-a', '@substrat-run/engine-b'] },
    ]);
  });

  it('yields an explicit empty registry for a surface that declares nothing', () => {
    expect(buildPermissionRegistry({ modules: [], roles: [] })).toEqual({
      permissions: [],
      roles: [],
      entityGrants: [],
    });
  });
});

describe('permissionDigest — the promotion "permissions changed" signal (D-39)', () => {
  const reg = (permissions: unknown[]): PermissionRegistry =>
    ({ permissions, roles: [], entityGrants: [] }) as PermissionRegistry;

  it('is a pure function of content — key/array order does not change it', async () => {
    const a = reg([
      { key: 'a:read', description: 'Read', declaredBy: ['@substrat-run/engine-a'] },
      { key: 'b:read', description: 'Read', declaredBy: ['@substrat-run/engine-b'] },
    ]);
    // Same content, keys in a different insertion order.
    const b: PermissionRegistry = {
      entityGrants: [],
      roles: [],
      permissions: [
        { declaredBy: ['@substrat-run/engine-a'] as never, key: 'a:read' as never, description: 'Read' },
        { description: 'Read', key: 'b:read' as never, declaredBy: ['@substrat-run/engine-b'] as never },
      ],
    };
    expect(await permissionDigest(a)).toBe(await permissionDigest(b));
  });

  it('moves when the declared surface changes', async () => {
    const before = reg([{ key: 'a:read', description: 'Read', declaredBy: ['@substrat-run/engine-a'] }]);
    const after = reg([{ key: 'a:read', description: 'Read invoices', declaredBy: ['@substrat-run/engine-a'] }]);
    expect(await permissionDigest(before)).not.toBe(await permissionDigest(after));
  });

  it('hashes an explicit empty surface deterministically (there is no absent-registry path — D-41)', async () => {
    // A vertical exposing nothing ships an explicit empty registry; its digest is content-only,
    // never the worker bindings (the old placeholder bug).
    expect(await permissionDigest(reg([]))).toBe(
      await permissionDigest({ permissions: [], roles: [], entityGrants: [] } as PermissionRegistry),
    );
  });
});

/**
 * Push identity (#388/#399): where a push lands is decided by `substrat.slug` (pinned)
 * or the package name (derived). The distinction is load-bearing — a DERIVED slug
 * silently follows a package rename, forking the lineage — so `readVerticalMeta`
 * reports which one it was and the CLI nags until the project pins it.
 */
describe('readVerticalMeta — slug identity', () => {
  it('derives the slug from the package name, flagged as NOT explicit', () => {
    const meta = readVerticalMeta(scratch({ name: '@substrat-run/demo-meridian', version: '1.2.3' }));
    expect(meta.slug).toBe('meridian');
    expect(meta.slugExplicit).toBe(false);
    expect(meta.versionSeed).toBe('1.2.3');
  });

  it('prefers an explicit substrat.slug pin, flagged as explicit', () => {
    const meta = readVerticalMeta(scratch({ name: 'egeryds-crm', substrat: { slug: 'egeryds-substrat' } }));
    expect(meta.slug).toBe('egeryds-substrat');
    expect(meta.slugExplicit).toBe(true);
  });

  it('reports no slug (and not-explicit) when there is no package.json', () => {
    const meta = readVerticalMeta(scratch());
    expect(meta.slug).toBe('');
    expect(meta.slugExplicit).toBe(false);
  });
});

describe('resolveWranglerConfig — the push preflight', () => {
  it('derives the config from substrat.runtimeNeeds (no wrangler.jsonc needed)', () => {
    const dir = scratch({
      name: 'x',
      substrat: { runtimeNeeds: { entry: 'src/worker.ts', stores: [{ binding: 'SCOPE', class: 'ScopeDO' }] } },
    });
    const { cfg, needs } = resolveWranglerConfig(dir);
    expect(needs?.entry).toBe('src/worker.ts');
    expect(cfg.main).toBe('src/worker.ts');
  });

  it('falls back to a hand-authored wrangler.jsonc', () => {
    const dir = scratch({ name: 'x' });
    writeFileSync(join(dir, 'wrangler.jsonc'), '{ "main": "src/worker.ts" /* authored */ }');
    const { cfg, needs } = resolveWranglerConfig(dir);
    expect(needs).toBeUndefined();
    expect(cfg.main).toBe('src/worker.ts');
  });

  it('NEITHER present refuses with the runtimeNeeds recipe, not an ENOENT trace', () => {
    const dir = scratch({ name: 'x' });
    expect(() => resolveWranglerConfig(dir)).toThrow(/substrat\.runtimeNeeds/);
    expect(() => resolveWranglerConfig(dir)).toThrow(/"entry": "src\/worker\.ts"/);
    expect(() => resolveWranglerConfig(dir)).not.toThrow(/ENOENT/);
  });
});
