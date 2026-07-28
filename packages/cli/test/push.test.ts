import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeNeeds, RUNTIME_BASELINE, type PermissionRegistry } from '@substrat-run/contracts';
import { wranglerConfigFor, readRuntimeNeeds, readRegistry, permissionDigest } from '../src/push.js';

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

describe('readRegistry — the declared permission surface shipped in the manifest (D-39)', () => {
  const A = '@substrat-run/engine-a';
  const registryFile = (registry: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-cli-reg-'));
    writeFileSync(join(dir, 'permissions.json'), JSON.stringify(registry));
    return dir;
  };
  const sample = {
    permissions: [{ key: 'a:read', description: 'Read', declaredBy: [A] }],
    roles: [{ key: 'staff', permissions: ['a:read'], source: 'vertical' }],
    entityGrants: [{ entityType: 'order', permissions: ['a:read'] }],
  };

  it('reads and validates a checked-in permissions.json', () => {
    expect(readRegistry(registryFile(sample))).toEqual(sample);
  });

  it('is undefined when the vertical ships no registry', () => {
    expect(readRegistry(mkdtempSync(join(tmpdir(), 'substrat-cli-noreg-')))).toBeUndefined();
  });

  it('rejects a malformed registry instead of shipping it', () => {
    expect(() => readRegistry(registryFile({ permissions: [{ key: 'bad key' }] }))).toThrow();
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

  it('an absent registry hashes the empty surface, not the worker bindings', async () => {
    // Deterministic and independent of any binding/module content — the old placeholder bug.
    expect(await permissionDigest(undefined)).toBe(await permissionDigest(reg([])));
  });
});
