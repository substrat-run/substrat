import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  buildPermissionRegistry,
  definePermissions,
  runtimeNeeds,
  RUNTIME_BASELINE,
  outboundHost,
  matchesOutboundHost,
  type PermissionRegistry,
} from '@substrat-run/contracts';
import { wranglerConfigFor, readRuntimeNeeds, resolveWranglerConfig, deriveRegistry, permissionDigest, readVerticalMeta, previewVersion, collectAssets, readAssetsNeed } from '../src/push.js';

describe('previewVersion — a FREE prerelease label, never a registry coordinate (#509 (e))', () => {
  const orig = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = orig;
  });
  const withVersions = (versions: string[]) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ entries: versions.map((version) => ({ version })), nextCursor: null }), {
        status: 200,
      })) as typeof fetch;
  };

  it('labels as <max-release+1>-<tag>.<n>, ignoring prereleases and climbing n', async () => {
    // 0.3.0 is the max RELEASE; the prereleases must not advance it (anchored parseSemver),
    // but n must climb past the highest existing <base>-<tag>.<n> so a re-push never collides.
    withVersions(['0.3.0', '0.3.1-pr-9.1', '0.3.1-pr-9.2', 'not-semver']);
    expect(await previewVersion('http://cp', {}, ['acme/crm'], undefined, 'pr-9')).toBe('0.3.1-pr-9.3');
  });

  it('starts n at 1 for a fresh tag on the current base', async () => {
    withVersions(['1.4.2', '1.4.3-pr-9.7']);
    expect(await previewVersion('http://cp', {}, ['x'], undefined, 'dev')).toBe('1.4.3-dev.1');
  });

  it('falls back to the seed when the registry is empty', async () => {
    withVersions([]);
    expect(await previewVersion('http://cp', {}, ['x'], '2.0.0', 'dev')).toBe('2.0.0-dev.1');
  });
});

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

  it('the baseline is MAINTAINED (#636): red once it falls ~6 months behind today', () => {
    // Deliberately a time-triggered failure, not a warning: a stale baseline silently
    // downgrades every wrangler-path vertical that migrates to runtimeNeeds, and a
    // warning in CI logs is exactly the "no diff surfaced anywhere" this exists to end.
    // Remedy: advance RUNTIME_BASELINE in @substrat-run/contracts (a platform release —
    // verticals pick it up on their next push), keeping it a few weeks behind today.
    const ageDays = (Date.now() - Date.parse(RUNTIME_BASELINE)) / 86_400_000;
    expect(
      ageDays,
      `RUNTIME_BASELINE (${RUNTIME_BASELINE}) is ${Math.floor(ageDays)} days old — advance it (#636)`,
    ).toBeLessThan(180);
    // …and never ahead of today: builders' installed wrangler/workerd must know the date.
    expect(ageDays).toBeGreaterThan(14);
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

  it('reads the declared outbound surface (#303), and reports absence as undefined', () => {
    // Absence must stay distinguishable from `[]` HERE, because push turns undefined into
    // `[]` on the wire (a new-CLI push always declares) — collapsing the two at the read
    // would make "declared nothing" and "an old package.json" the same fact.
    const declared = readVerticalMeta(
      scratch({ name: 'crm', substrat: { outbound: ['api.scrive.com', '*.googleapis.com'] } }),
    );
    expect(declared.outbound).toEqual(['api.scrive.com', '*.googleapis.com']);
    expect(readVerticalMeta(scratch({ name: 'crm' })).outbound).toBeUndefined();
  });
});

/**
 * The outbound surface (#303, D-46) is enforcement input, not metadata: the egress worker
 * reads `null` as "pre-#303, unenforced". So the schema has to refuse the shapes that
 * would silently widen it, and the matcher has to agree with the worker that enforces it.
 */
describe('outboundHost — the declared egress surface (#303)', () => {
  it('accepts a hostname and a *. wildcard', () => {
    expect(outboundHost.parse('api.scrive.com')).toBe('api.scrive.com');
    expect(outboundHost.parse('*.googleapis.com')).toBe('*.googleapis.com');
  });

  it('refuses a scheme, a port, a path, a bare label, and an embedded wildcard', () => {
    for (const bad of [
      'https://api.scrive.com',
      'api.scrive.com:443',
      'api.scrive.com/v2',
      'localhost',
      'api.*.com',
      '*',
      'API.SCRIVE.COM', // uppercase: the runtime sees lowercase, so declare lowercase
    ]) {
      expect(() => outboundHost.parse(bad)).toThrow();
    }
  });

  it('matches the way the egress worker enforces: wildcards at depth, never the apex', () => {
    expect(matchesOutboundHost('api.scrive.com', ['api.scrive.com'])).toBe(true);
    expect(matchesOutboundHost('API.Scrive.com', ['api.scrive.com'])).toBe(true); // DNS is case-insensitive
    expect(matchesOutboundHost('oauth2.googleapis.com', ['*.googleapis.com'])).toBe(true);
    expect(matchesOutboundHost('a.b.googleapis.com', ['*.googleapis.com'])).toBe(true);
    expect(matchesOutboundHost('googleapis.com', ['*.googleapis.com'])).toBe(false);
    expect(matchesOutboundHost('evil-googleapis.com', ['*.googleapis.com'])).toBe(false);
    expect(matchesOutboundHost('api.scrive.com', [])).toBe(false);
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

  it('REFUSES a runtimeNeeds push whose ignored wrangler.jsonc pins a NEWER date (#636)', () => {
    // The D-38 migration trap: deriving from the baseline would move a live worker's
    // compatibility date backwards, switching off runtime defaults with no diff anywhere.
    const dir = scratch({ name: 'x', substrat: { runtimeNeeds: { entry: 'src/worker.ts' } } });
    writeFileSync(join(dir, 'wrangler.jsonc'), '{ "main": "src/worker.ts", "compatibility_date": "2099-01-01" }');
    expect(() => resolveWranglerConfig(dir)).toThrow(/BACKWARDS/);
    expect(() => resolveWranglerConfig(dir)).toThrow(/2099-01-01/);
    expect(() => resolveWranglerConfig(dir)).toThrow(new RegExp(RUNTIME_BASELINE));
  });

  it('a wrangler.jsonc at or behind the baseline stays an ignored no-op beside runtimeNeeds', () => {
    const dir = scratch({ name: 'x', substrat: { runtimeNeeds: { entry: 'src/worker.ts' } } });
    writeFileSync(join(dir, 'wrangler.jsonc'), '{ "main": "old.ts", "compatibility_date": "2025-06-01" }');
    const { cfg, needs } = resolveWranglerConfig(dir);
    expect(needs?.entry).toBe('src/worker.ts');
    expect(cfg.compatibility_date).toBe(RUNTIME_BASELINE);
  });
});

/**
 * Static assets (#340). Two things are worth pinning here, and only two: the manifest is
 * Cloudflare's recipe (a divergence dedups against nothing, and stores bytes under a key
 * that is not theirs), and the two config vocabularies — `runtimeNeeds.assets` and a
 * hand-authored wrangler `assets` block — land on ONE parsed shape.
 */
describe('collectAssets — the content-addressed manifest (#340)', () => {
  const withAssets = (files: Record<string, string>): string => {
    const dir = scratch({ name: 'x' });
    for (const [rel, body] of Object.entries(files)) {
      const full = join(dir, 'dist', rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
    return dir;
  };

  it('hashes with Cloudflare’s own recipe: sha256(base64(content) + extension), 32 hex', async () => {
    const dir = withAssets({ 'index.html': '<!doctype html>' });
    const [asset] = await collectAssets(dir, { directory: 'dist' });
    // Computed independently here with node crypto — the SAME expression Cloudflare's
    // direct-upload docs specify. If contracts' assetHash ever drifts from this, dedup
    // silently stops matching every asset the runtime already holds.
    const expected = createHash('sha256')
      .update(Buffer.from('<!doctype html>').toString('base64') + 'html')
      .digest('hex')
      .slice(0, 32);
    expect(asset!.entry.hash).toBe(expected);
    expect(asset!.entry.hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('keys by URL path (leading slash, / separators) and types by extension', async () => {
    const dir = withAssets({ 'index.html': 'x', 'assets/app.js': 'y', 'img/logo.png': 'z' });
    const collected = await collectAssets(dir, { directory: 'dist' });
    const byPath = Object.fromEntries(collected.map((a) => [a.entry.path, a.entry]));
    expect(Object.keys(byPath).sort()).toEqual(['/assets/app.js', '/img/logo.png', '/index.html']);
    expect(byPath['/index.html']!.contentType).toBe('text/html; charset=utf-8');
    expect(byPath['/assets/app.js']!.contentType).toBe('text/javascript; charset=utf-8');
    expect(byPath['/img/logo.png']!.contentType).toBe('image/png');
    expect(byPath['/index.html']!.size).toBe(1);
  });

  it('an unknown extension downloads rather than mis-executes', async () => {
    const dir = withAssets({ 'data.bin': 'q' });
    const [asset] = await collectAssets(dir, { directory: 'dist' });
    expect(asset!.entry.contentType).toBe('application/octet-stream');
  });

  it('a missing directory refuses by naming it as BUILD output, not as ENOENT', async () => {
    const dir = scratch({ name: 'x' });
    await expect(collectAssets(dir, { directory: 'app/dist' })).rejects.toThrow(/BUILD output/);
  });
});

describe('readAssetsNeed — one shape from either vocabulary (#340)', () => {
  it('reads runtimeNeeds.assets as-is', () => {
    const needs = runtimeNeeds.parse({
      entry: 'src/worker.ts',
      assets: { directory: 'app/dist', notFoundHandling: 'single-page-application' },
    });
    expect(readAssetsNeed({}, needs)).toEqual({
      directory: 'app/dist',
      notFoundHandling: 'single-page-application',
    });
  });

  it('maps a wrangler.jsonc assets block’s snake_case onto the same shape', () => {
    expect(
      readAssetsNeed(
        {
          assets: {
            directory: './app/dist',
            not_found_handling: 'single-page-application',
            run_worker_first: ['/api/*', '/internal/*'],
            html_handling: 'auto-trailing-slash',
          },
        },
        undefined,
      ),
    ).toEqual({
      directory: './app/dist',
      notFoundHandling: 'single-page-application',
      runWorkerFirst: ['/api/*', '/internal/*'],
      htmlHandling: 'auto-trailing-slash',
    });
  });

  it('REFUSES an assets binding rather than shipping a worker whose env.ASSETS is undefined', () => {
    expect(() => readAssetsNeed({ assets: { directory: 'dist', binding: 'ASSETS' } }, undefined)).toThrow(
      /cannot bind them/,
    );
  });

  it('a vertical declaring no assets is undefined on both paths', () => {
    expect(readAssetsNeed({}, undefined)).toBeUndefined();
    expect(readAssetsNeed({}, runtimeNeeds.parse({ entry: 'src/worker.ts' }))).toBeUndefined();
  });
});
