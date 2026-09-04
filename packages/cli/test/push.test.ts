import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import {
  buildPermissionRegistry,
  definePermissions,
  runtimeNeeds,
  RUNTIME_BASELINE,
  outboundHost,
  matchesOutboundHost,
  type PermissionRegistry,
} from '@substrat-run/contracts';
import { wranglerConfigFor, readRuntimeNeeds, resolveWranglerConfig, deriveRegistry, permissionDigest, checkPermissionSurface, formatPermissionSurface, readVerticalMeta, resolveDeclaredEnvSpec, previewVersion, collectAssets, readAssetsNeed, assertUiIsServed, generatedConfigPath } from '../src/push.js';

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
 * The UI-reachability preflight (#881). The bug it exists to catch is invisible to every
 * other gate — a vertical whose `app/` is real and tested deploys clean and 404s at its
 * own hostname — so what matters here is the pair: it fires on the dead UI, and it stays
 * silent on every shape where the absence of an `assets` block is correct.
 */
describe('assertUiIsServed — a UI nothing would serve (#881)', () => {
  const needs = (extra: Record<string, unknown> = {}) =>
    runtimeNeeds.parse({ entry: 'src/worker.ts', ...extra });

  /** A vertical with a scaffolded Vite app under app/. */
  const withUi = (): string => {
    const dir = scratch({ name: 'x' });
    mkdirSync(join(dir, 'app'), { recursive: true });
    writeFileSync(join(dir, 'app', 'index.html'), '<!doctype html><div id="root"></div>');
    return dir;
  };

  it('REFUSES an app/ that no assets block declares, with the recipe', () => {
    const dir = withUi();
    expect(() => assertUiIsServed(dir, needs(), undefined)).toThrow(/app\/index\.html/);
    expect(() => assertUiIsServed(dir, needs(), undefined)).toThrow(/"directory": "app\/dist"/);
    // The second silent failure, stated where the first one is fixed.
    expect(() => assertUiIsServed(dir, needs(), undefined)).toThrow(/runWorkerFirst/);
    expect(() => assertUiIsServed(dir, needs(), undefined)).toThrow(/--allow-unserved-ui/);
  });

  it('a declared build is NOT enough — built output nobody uploads is still a 404', () => {
    const dir = withUi();
    expect(() =>
      assertUiIsServed(dir, needs({ build: 'npm --prefix app run build' }), undefined),
    ).toThrow(/nothing in the push would serve/);
  });

  it('passes once assets are declared', () => {
    const dir = withUi();
    const declared = needs({ assets: { directory: 'app/dist' } });
    expect(() => assertUiIsServed(dir, declared, declared.assets)).not.toThrow();
  });

  it('passes for a vertical with no UI at all — the API-only push stays legal', () => {
    expect(() => assertUiIsServed(scratch({ name: 'x' }), needs(), undefined)).not.toThrow();
  });

  it('passes for the pre-#340 inline pattern, which serves its files from the worker', () => {
    const dir = withUi();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'assets.generated.ts'), 'export const ASSETS = {};');
    expect(() => assertUiIsServed(dir, needs(), undefined)).not.toThrow();
  });

  it('--allow-unserved-ui is the override for an app/ this cannot see the truth about', () => {
    expect(() => assertUiIsServed(withUi(), needs(), undefined, true)).not.toThrow();
  });

  /**
   * The exemption's evidence used to be an artifact of the step this check PRECEDES (#1209).
   * `assets.generated.*` is written by the declared build and gitignored, so it exists on a
   * developer's machine (left over from an earlier build) and never on a fresh checkout —
   * which is every CI run. The push was refused for a UI it would in fact have served, on
   * exactly the path where nothing local reproduces it.
   */
  it('passes the inline pattern BEFORE its module is built — the import is the evidence', () => {
    const dir = withUi();
    mkdirSync(join(dir, 'src'), { recursive: true });
    // What a fresh clone holds: the worker that serves the app, and no build output.
    writeFileSync(
      join(dir, 'src', 'assets.ts'),
      "import { ASSETS } from './assets.generated.js';\nexport const serve = () => ASSETS;\n",
    );
    expect(existsSync(join(dir, 'src', 'assets.generated.ts'))).toBe(false);
    expect(() => assertUiIsServed(dir, needs(), undefined)).not.toThrow();
  });

  it('reads the specifier in every import form, extension or not', () => {
    for (const source of [
      "import './assets.generated.js';",
      "export * from './assets.generated';",
      "const a = await import('./generated/assets.generated.mjs');",
      "const a = require('./assets.generated.cjs');",
    ]) {
      const dir = withUi();
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'worker.ts'), source);
      expect(() => assertUiIsServed(dir, needs(), undefined)).not.toThrow();
    }
  });

  /**
   * The evidence is an import the language would have PARSED, not the text of one. A
   * raw-text regex would take a commented-out import or a string that quotes one and
   * exempt a UI that really is unserved — the exact failure the check exists to catch,
   * reintroduced by the fix for #1209.
   */
  it.each([
    ['a passing mention', '// we could inline assets.generated.ts one day\n'],
    ['a commented-out import', "// import { ASSETS } from './assets.generated.js';\nexport const x = 1;\n"],
    [
      'a block comment holding the example',
      "/**\n * import { ASSETS } from './assets.generated.js';\n */\nexport const x = 1;\n",
    ],
    ['a string that quotes an import', `export const help = "import { A } from './assets.generated.js'";\n`],
    ['a specifier that only ends similarly', "import { x } from './my-assets.generated-helpers.js';\n"],
    // Ordinary calls that merely reuse the words. `from` in an import takes no parenthesis
    // and `require` in an import is never a method, so neither of these is an import.
    ['a call to a function named from', "export const rows = from('./assets.generated.js');\n"],
    ['a method call named require', "export const a = loader.require('./assets.generated.js');\n"],
    // TypeScript erases these: the emitted worker has no reference to the module at all,
    // so naming it in a type position serves nothing.
    ['an import type declaration', "import type { AssetMap } from './assets.generated.js';\nexport const x = 1;\n"],
    ['an export type declaration', "export type { AssetMap } from './assets.generated.js';\n"],
    [
      'a named clause whose every binding is a type',
      "import { type AssetMap, type Asset } from './assets.generated.js';\nexport const x = 1;\n",
    ],
    // A regex literal after a keyword. `return` ends in a word character but is not a value,
    // so the `/` opens a regex — read as division instead, its body parses as code with a
    // string in it and the whole thing reads as an import.
    [
      'an import quoted inside a regex literal',
      "export const f = () => { return /import '\\.\\/assets\\.generated\\.js'/; };\n",
    ],
  ])('still REFUSES when the only evidence is %s', (_what, source) => {
    const dir = withUi();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'worker.ts'), source);
    expect(() => assertUiIsServed(dir, needs(), undefined)).toThrow(/nothing in the push would serve/);
  });

  it('accepts a value import that follows a type-only one — the clause read is per statement', () => {
    // The type-only skip must not swallow the real import two lines down: the clause scanned
    // is the one belonging to THIS `from`, not the file's first import keyword.
    const dir = withUi();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'worker.ts'),
      "import type { AssetMap } from './types.js';\nimport { ASSETS } from './assets.generated.js';\nexport const x: AssetMap = ASSETS;\n",
    );
    expect(() => assertUiIsServed(dir, needs(), undefined)).not.toThrow();
  });

  it('accepts a mixed clause — one runtime binding beside the types is a real import', () => {
    const dir = withUi();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'worker.ts'),
      "import { type AssetMap, ASSETS } from './assets.generated.js';\nexport const x: AssetMap = ASSETS;\n",
    );
    expect(() => assertUiIsServed(dir, needs(), undefined)).not.toThrow();
  });

  it('is not fooled by a quote inside a regex literal into missing a real import', () => {
    // The scanner has to skip regex literals whole: a `['"]` class left mid-string would
    // swallow the import below and refuse a vertical that serves its UI perfectly well.
    const dir = withUi();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'worker.ts'),
      "const quoted = /['\"]/;\nimport { ASSETS } from './assets.generated.js';\nexport const x = [quoted, ASSETS];\n",
    );
    expect(() => assertUiIsServed(dir, needs(), undefined)).not.toThrow();
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

describe('generatedConfigPath — the derived config wrangler is pointed at', () => {
  /**
   * The bug this pins: `wrangler` is spawned with `cwd` set to the push directory, so a
   * RELATIVE `--config` is resolved against it a second time. `substrat push demos/ticket0`
   * from a repo root asked wrangler for `demos/ticket0/demos/ticket0/.wrangler.substrat.json`
   * and the CI build died on ENOENT, while every local push — run from inside the package,
   * where the directory is '.' — was fine.
   */
  it('is absolute, so a cwd-relative second resolve cannot double it', () => {
    const generated = generatedConfigPath('demos/ticket0');
    expect(isAbsolute(generated)).toBe(true);
    // The doubling, stated as the thing that must not happen.
    expect(resolve('demos/ticket0', generated)).toBe(generated);
    expect(generated.endsWith(join('demos', 'ticket0', '.wrangler.substrat.json'))).toBe(true);
  });

  it('names the same file whether the push addressed the directory or ran inside it', () => {
    expect(generatedConfigPath(resolve('demos/ticket0'))).toBe(generatedConfigPath('demos/ticket0'));
  });
});

/**
 * Every DECLARED field `readVerticalMeta` reads must actually reach `push()`.
 *
 * The gap this closes is not a wrong value but an absent one: `substrat.usesModels`
 * (#1054) was read from package.json, typed on the push options, sent by `push()` and
 * honoured by the control plane — and `cli.ts` never passed it, so the `ai` binding it
 * requests was never injected for ANY vertical, on any push, from #1072 until this fix.
 * Nothing was red, because every link in the chain was individually correct.
 *
 * So the assertion is on the JOIN, and it is written over the field LIST rather than
 * over one field: the next declared surface added to `readVerticalMeta` and forgotten at
 * a call site fails here instead of shipping as a capability that silently never arrives.
 * Read from source deliberately — the two call sites build an object literal inline, and
 * a test that imported them would be asserting against the very thing it is checking.
 */
describe('cli.ts — every declared field readVerticalMeta reads reaches push()', () => {
  /** What the meta carries ABOUT THE DEPLOY, as opposed to what identifies it. */
  const IDENTITY = new Set(['slug', 'slugExplicit', 'name', 'tenant', 'versionSeed']);

  it('threads each one at both the push and the preview-create call site', () => {
    // Derived at RUNTIME from a package.json declaring everything, so a field added to
    // `readVerticalMeta` joins this test by existing rather than by being listed here.
    const meta = readVerticalMeta(
      scratch({
        name: '@substrat-run/demo-probe',
        version: '1.0.0',
        substrat: {
          slug: 'probe',
          envSpec: [],
          ownerGrants: [],
          entitlements: [],
          provides: [],
          requires: [],
          provisions: [],
          sendsEmail: true,
          usesModels: true,
          surfaces: [],
          outbound: [],
        },
      }),
    );
    const declared = Object.keys(meta).filter((k) => !IDENTITY.has(k));
    // Guard the guard: an empty list would make every assertion below vacuous.
    expect(declared).toContain('usesModels');

    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const missing = declared.filter((key) => {
      const sites = src.match(new RegExp(`^\\s*${key}: meta\\.${key},$`, 'gm')) ?? [];
      return sites.length < 2;
    });
    expect(missing).toEqual([]);
  });
});

/**
 * `substrat push --check` — the permission preflight, reachable (#1205).
 *
 * The derivation was always here; what was missing was a way to RUN it that is not a deep
 * import of `dist/push.js`, which no `exports` map declares and any file move breaks. So the
 * assertions below are about reachability and refusal, not about the derivation itself
 * (`buildPermissionRegistry` above owns that): the command exists, it needs no credential and
 * no network, it prints the surface it would ship, and every one of the failure modes that
 * used to stay silent until deploy exits non-zero with a diagnostic naming the pointer.
 *
 * The end-to-end cases drive the REAL binary in a child process, because that is the only
 * place the bundle-and-import step runs — vitest's module runner cannot load the runtime temp
 * file `deriveRegistry` writes, which is why the guard-path tests above stop short of it.
 * CI builds (`pnpm -r build`) before it tests, so `dist/cli.js` is always there; an unbuilt
 * local checkout skips rather than reddening on something the change did not break.
 */
describe('substrat push --check — the permission preflight as a command (#1205)', () => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const built = existsSync(cli);

  /** A vertical tree whose only content is a permission entry — no engines to resolve, no
   *  imports to externalise, so the bundle step exercises the path and nothing else. */
  function verticalWith(entry: string, pkg: Record<string, unknown> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-cli-check-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: '@acme/helpdesk', version: '1.0.0', substrat: { permissions: 'perms.mjs' }, ...pkg }),
    );
    writeFileSync(join(dir, 'perms.mjs'), entry);
    return dir;
  }

  const SURFACE = `
export const permissions = {
  modules: [
    { manifest: { id: '@substrat-run/engine-workorder', permissions: [
      { key: 'workorder:read', description: 'Read work orders' },
      { key: 'workorder:create', description: 'Create a work order' },
    ] } },
  ],
  roles: [{ key: 'dispatcher', permissions: ['workorder:create', 'workorder:read'], source: 'vertical' }],
  entityGrants: [{ entityType: 'work-order', permissions: ['workorder:read'] }],
};
`;

  /** Run the built CLI with NO stored credential and no control-plane URL: a check that
   *  needed either would fail here rather than in somebody's CI. */
  function runCheck(dir: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
    const home = mkdtempSync(join(tmpdir(), 'substrat-cli-home-'));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.SUBSTRAT_CP_URL;
    delete env.SUBSTRAT_SERVICE_TOKEN;
    delete env.SUBSTRAT_TENANT;
    const r = spawnSync(process.execPath, [cli, 'push', dir, '--check', ...args], { env, encoding: 'utf8' });
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it.runIf(built)('prints the surface a push would ship, with no login and no network', () => {
    const r = runCheck(verticalWith(SURFACE));
    expect(r.status).toBe(0);
    // Every key, with the module that declares it and its description — the readable half
    // of the permission checkpoint.
    expect(r.stdout).toMatch(/workorder:create\s+\[@substrat-run\/engine-workorder]\s+Create a work order/);
    expect(r.stdout).toMatch(/workorder:read\s+\[@substrat-run\/engine-workorder]\s+Read work orders/);
    expect(r.stdout).toMatch(/dispatcher\s+\(vertical, 2 key\(s\)\)/);
    expect(r.stdout).toContain('work-order: workorder:read');
    expect(r.stdout).toMatch(/digest: [0-9a-f]{32}/);
    // It stopped before the push: nothing authenticated, nothing uploaded.
    expect(r.stdout).not.toContain('authenticating with');
    expect(r.stdout).not.toContain('uploading');
  });

  it.runIf(built)('--json prints the same surface as data, digest and all', async () => {
    const r = runCheck(verticalWith(SURFACE), '--json');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { registry: PermissionRegistry; digest: string };
    expect(out.registry.permissions.map((p) => p.key)).toEqual(['workorder:create', 'workorder:read']);
    expect(out.registry.roles).toEqual([
      { key: 'dispatcher', permissions: ['workorder:create', 'workorder:read'], source: 'vertical' },
    ]);
    expect(out.registry.entityGrants).toEqual([{ entityType: 'work-order', permissions: ['workorder:read'] }]);
    // The digest is `digests.permission` itself — the value promotion compares — not a
    // second hash of the printed text.
    expect(out.digest).toBe(await permissionDigest(out.registry));
  });

  it.runIf(built)('refuses an entry that stops exporting `permissions`', () => {
    const r = runCheck(verticalWith(`export const roles = [];\n`));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/exports no `permissions`/);
  });

  it.runIf(built)('refuses an entry that cannot be imported outside the vertical’s runtime', () => {
    // The third failure mode: it exports the right name, but reading it needs a live host.
    const r = runCheck(verticalWith(`throw new Error('needs a live host');\nexport const permissions = {};\n`));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/could not be bundled and imported as data/);
    expect(r.stderr).toContain('perms.mjs');
  });

  it('refuses a missing pointer and a pointer naming a file that has moved', async () => {
    // Both fail before the bundle step, so they hold with or without a built CLI.
    await expect(checkPermissionSurface(scratch({ name: 'x' }))).rejects.toThrow(/declares no permission surface/);
    await expect(
      checkPermissionSurface(scratch({ substrat: { permissions: 'src/moved.ts' } })),
    ).rejects.toThrow(/points at "src\/moved.ts", which does not exist/);
  });

  it('names the directory when there is no package.json at all, not an ENOENT trace', async () => {
    // The likeliest mistake for a command a CI job runs from wherever it happens to stand.
    await expect(checkPermissionSurface(scratch())).rejects.toThrow(/no package.json under .+ — run this from/);
  });

  it('formats a surface identically on every run, so a diff is a real change', async () => {
    const registry = buildPermissionRegistry({
      modules: [
        { manifest: { id: '@substrat-run/engine-a', permissions: [{ key: 'a:read', description: 'Read' }] } },
      ] as never,
      roles: [{ key: 'admin', permissions: ['a:read'] as never, source: 'vertical' }],
      entityGrants: [{ entityType: 'order', permissions: ['a:read'] as never }],
    });
    const surface = { registry, digest: await permissionDigest(registry) };
    const text = formatPermissionSurface(surface, 'helpdesk');
    expect(text).toBe(formatPermissionSurface(surface, 'helpdesk'));
    expect(text).toContain('permission surface — helpdesk: 1 key(s), 1 role(s), 1 entity-grant shape(s)');
    expect(text).toContain('a:read  [@substrat-run/engine-a]  Read');
    expect(text).toContain('order: a:read');
    expect(text.trimEnd().endsWith(surface.digest + '  (digests.permission — the promotion checkpoint compares this)')).toBe(true);
  });

  it('says "none declared" rather than printing nothing for an empty surface', async () => {
    const registry = buildPermissionRegistry({ modules: [], roles: [] });
    const text = formatPermissionSurface({ registry, digest: await permissionDigest(registry) });
    expect(text).toContain('0 key(s), 0 role(s), 0 entity-grant shape(s)');
    expect(text.match(/\(none declared\)/g)).toHaveLength(2);
  });

  it.runIf(built)('reports the code-declared envSpec, so the config surface is in the check artifact', () => {
    const r = runCheck(
      verticalWith(
        SURFACE +
          `export const envSpec = [{ key: 'SHOP_NAME', description: 'The shop name', required: true }];\n`,
      ),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('env keys (code-declared, #1206): 1');
    expect(r.stdout).toContain('SHOP_NAME  (required)');
  });

  it.runIf(built)('refuses when a leftover package.json envSpec copy has drifted from the export (#1206)', () => {
    const dir = verticalWith(
      SURFACE + `export const envSpec = [{ key: 'SHOP_NAME', description: 'The shop name' }];\n`,
      { substrat: { permissions: 'perms.mjs', envSpec: [{ key: 'OLD_KEY', description: 'Stale copy' }] } },
    );
    const r = runCheck(dir);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/envSpec is declared twice and the copies disagree/);
    expect(r.stderr).toContain('only in the code declaration: SHOP_NAME');
    expect(r.stderr).toContain('only in package.json: OLD_KEY');
  });

  it.runIf(built)('refuses an envSpec export that is not a valid env-var spec list', () => {
    const r = runCheck(verticalWith(SURFACE + `export const envSpec = [{ key: 'lowercase' }];\n`));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/`envSpec` that is not a valid env-var spec list/);
  });
});

/**
 * Which envSpec a push ships (#1206) — the pure decision, unit-tested because the
 * bundle-and-import that produces `derived` cannot run under vitest (see above). The
 * property that matters: adopting the code-side export can never silently lose a key —
 * a drifted duplicate REFUSES, and only an identical or absent package.json copy passes.
 */
describe('resolveDeclaredEnvSpec — the code declaration wins, drift refuses (#1206)', () => {
  const spec = (key: string, description = 'A key') => ({
    key,
    description,
    required: false,
    secret: false,
  });

  it('falls back to the package.json copy when the entry exports none (pre-#1206 verticals)', () => {
    const pkgCopy = [{ key: 'A_KEY', description: 'A key' }];
    expect(resolveDeclaredEnvSpec(undefined, pkgCopy, () => {})).toBe(pkgCopy);
    expect(resolveDeclaredEnvSpec(undefined, undefined, () => {})).toBeUndefined();
  });

  it('ships the code declaration when it is the only copy', () => {
    const derived = [spec('A_KEY')];
    expect(resolveDeclaredEnvSpec(derived, undefined, () => {})).toBe(derived);
  });

  it('tolerates an identical leftover copy, with a note — adoption is a two-step', () => {
    const derived = [spec('A_KEY')];
    // The copy omits the defaulted fields; parsing normalises it, so it still counts as equal.
    const pkgCopy = [{ key: 'A_KEY', description: 'A key' }];
    const notes: string[] = [];
    expect(resolveDeclaredEnvSpec(derived, pkgCopy, (m) => notes.push(m))).toBe(derived);
    expect(notes.join('\n')).toContain('can be deleted');
  });

  it('refuses a drifted copy, naming the keys on each side', () => {
    const derived = [spec('NEW_KEY'), spec('SHARED')];
    const pkgCopy = [spec('OLD_KEY'), spec('SHARED')];
    expect(() => resolveDeclaredEnvSpec(derived, pkgCopy, () => {})).toThrow(
      /only in the code declaration: NEW_KEY.*only in package.json: OLD_KEY/,
    );
  });

  it('refuses same keys with differing content — a changed default is drift too', () => {
    const derived = [{ ...spec('A_KEY'), default: 'new' }];
    const pkgCopy = [{ ...spec('A_KEY'), default: 'old' }];
    expect(() => resolveDeclaredEnvSpec(derived, pkgCopy, () => {})).toThrow(/same keys, differing content/);
  });

  it('refuses a copy that no longer even parses — stale junk is drift, not a pass', () => {
    const derived = [spec('A_KEY')];
    expect(() => resolveDeclaredEnvSpec(derived, [{ key: 'lowercase' }], () => {})).toThrow(
      /declared twice and the copies disagree/,
    );
  });
});

/**
 * `preview create` forwards push's own overrides (#1209).
 *
 * The gap this pins was invisible to every unit test because it is not in `push()` at all —
 * `assertUiIsServed` was correct, `cmdPush` passed the flag, and `cmdPreview` called the same
 * `push()` without it. So `--allow-unserved-ui` was accepted on the command line, silently
 * dropped, and the refusal went on naming the flag as the remedy. Previews are per-PR and run
 * on every push, which makes this the path most likely to meet the check.
 *
 * It has to drive the real binary: `cli.ts` runs `main()` on import, so the only place the
 * flag→option wiring exists is a child process. Nothing is uploaded — the run stops at the UI
 * preflight (without the flag) or at the build (with it), both before any network call, and
 * `--version` skips the one registry read `preview create` would otherwise do first.
 */
describe('substrat preview create — push overrides reach the same push (#1209)', () => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const built = existsSync(cli);

  /** A vertical with a scaffolded app/ that nothing declares — what the preflight refuses. */
  function verticalWithUnservedUi(): string {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-cli-preview-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@acme/helpdesk',
        version: '1.0.0',
        substrat: { runtimeNeeds: { entry: 'src/worker.ts' } },
      }),
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'worker.ts'), 'export default { fetch: () => new Response("ok") };\n');
    mkdirSync(join(dir, 'app'), { recursive: true });
    writeFileSync(join(dir, 'app', 'index.html'), '<!doctype html><div id="root"></div>');
    return dir;
  }

  /** An `npx` that fails instantly, so the case which gets PAST the preflight stops at the
   *  build instead of fetching and running wrangler for a bundle no assertion looks at. */
  function stubNpx(): string {
    const bin = mkdtempSync(join(tmpdir(), 'substrat-cli-bin-'));
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\necho "stub wrangler" >&2\nexit 9\n', { mode: 0o755 });
    return bin;
  }

  function runPreview(dir: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
    const home = mkdtempSync(join(tmpdir(), 'substrat-cli-home-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: `${stubNpx()}:${process.env.PATH ?? ''}`,
      // Enough for `resolveAuth` to answer without a stored login and without a request:
      // the run never gets far enough to send one (the port is deliberately unusable).
      SUBSTRAT_CP_URL: 'http://127.0.0.1:1/api',
      SUBSTRAT_SERVICE_TOKEN: 'test-token',
      SUBSTRAT_TENANT: 'acme',
    };
    const r = spawnSync(
      process.execPath,
      [cli, 'preview', 'create', dir, '--tag', 'pr-1', '--version', '0.0.1-pr-1.1', '--skip-lint', ...args],
      { env, encoding: 'utf8' },
    );
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it.runIf(built)('refuses an unserved UI, exactly as `push` does', () => {
    const r = runPreview(verticalWithUnservedUi());
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/nothing in the push would serve/);
    expect(r.stderr).toMatch(/--allow-unserved-ui/);
  });

  it.runIf(built)('and --allow-unserved-ui is honoured rather than silently dropped', () => {
    const r = runPreview(verticalWithUnservedUi(), '--allow-unserved-ui');
    // Past the preflight: it reached the build (the stubbed npx), so the flag arrived.
    expect(r.stderr).not.toMatch(/nothing in the push would serve/);
    expect(r.stdout).toMatch(/building helpdesk@0\.0\.1-pr-1\.1/);
  });
});
