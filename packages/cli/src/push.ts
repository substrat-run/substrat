import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, extname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import {
  ASSET_PART_PREFIX,
  assetHash,
  assetsNeed,
  buildPermissionRegistry,
  deployManifest,
  runtimeNeeds,
  RUNTIME_BASELINE,
  type AssetEntry,
  type AssetsNeed,
  type DeclaredBinding,
  type PermissionRegistry,
  type PermissionsInput,
  type RuntimeNeeds,
  type VersionOrigin,
} from '@substrat-run/contracts';
import { warnIfStale } from './version.js';
import { explainPlatformFault, parseJsonBody, readAllEntries } from './http.js';

/**
 * Where this push runs: the generated deploy workflow runs THIS SAME CLI inside GitHub
 * Actions, so the runner's env is what tells a git-driven release apart from a person's
 * terminal — and carries which repo/commit the code was built from.
 */
function pushOrigin(): VersionOrigin {
  if (process.env.GITHUB_ACTIONS !== 'true') return { source: 'cli' };
  return {
    source: 'git',
    ...(process.env.GITHUB_REPOSITORY ? { gitRepo: process.env.GITHUB_REPOSITORY } : {}),
    ...(process.env.GITHUB_SHA ? { gitCommit: process.env.GITHUB_SHA } : {}),
    ...(process.env.GITHUB_REF_NAME ? { gitRef: process.env.GITHUB_REF_NAME } : {}),
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('hex').slice(0, 32);
}

/** Deterministic JSON: object keys sorted recursively, array order preserved. Makes the
 *  permission digest a pure function of registry CONTENT — independent of the artifact's
 *  on-disk key order or formatting. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Derive the vertical's permission registry (D-39/D-41) from its declared TypeScript surface —
 * the single typed source. `package.json` `substrat.permissions` points at the module that
 * exports a `definePermissions(...)` result; we bundle it (all packages left EXTERNAL, so a
 * node-ful entry still resolves its own `node_modules` — including native addons — at import)
 * into a temp module *inside* the vertical dir, then import it to read the surface as data and
 * derive the registry with the same `buildPermissionRegistry` the permission checkpoint uses.
 *
 * The control plane never does this — it re-parses the wire manifest at the trust boundary
 * (self-serve-deploy.md §4). `push` runs on the builder's own machine, so importing the
 * builder's own entry is not a new trust boundary. A missing pointer, a missing entry, or an
 * entry that exports no `permissions` is a hard error: a deployable vertical must declare its
 * surface — absence is never silently an empty surface (D-41).
 */
export async function deriveRegistry(dir: string): Promise<PermissionRegistry> {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    substrat?: { permissions?: string };
  };
  const entry = pkg.substrat?.permissions;
  if (!entry) {
    throw new Error(
      `${basename(dir)} declares no permission surface. Add \`"substrat": { "permissions": "src/…" }\` ` +
        `to package.json, pointing at the module that exports \`definePermissions(...)\`.`,
    );
  }
  const entryPath = join(dir, entry);
  if (!existsSync(entryPath)) {
    throw new Error(`substrat.permissions points at "${entry}", which does not exist under ${dir}.`);
  }
  // Written INTO the vertical dir so Node resolves the externalised imports (@substrat-run/*,
  // and any node addon a node-ful entry pulls) from the vertical's own node_modules. Removed
  // immediately after import. The unique name avoids the ESM import cache across pushes.
  const out = join(dir, `.substrat.permissions.${Date.now()}.mjs`);
  try {
    await build({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      outfile: out,
      logLevel: 'silent',
    });
    // @vite-ignore: this is a real filesystem path imported at runtime, never a bundler input —
    // the comment keeps vitest/vite from trying to resolve it through their transform pipeline.
    const mod = (await import(/* @vite-ignore */ pathToFileURL(out).href)) as { permissions?: PermissionsInput };
    if (!mod.permissions) {
      throw new Error(
        `${entry} exports no \`permissions\`. Export ` +
          `\`const permissions = definePermissions({ modules, roles, entityGrants })\`.`,
      );
    }
    return buildPermissionRegistry(mod.permissions);
  } finally {
    rmSync(out, { force: true });
  }
}

/**
 * The permission digest (D-39): a content hash of the vertical's declared permission surface —
 * what the promotion checkpoint compares to fire "permissions changed". A pure function of the
 * registry CONTENT (formatting-independent), so it moves iff a key, description, role, or grant
 * shape moves.
 */
export async function permissionDigest(registry: PermissionRegistry): Promise<string> {
  return sha256(Buffer.from(stableStringify(registry)));
}

/**
 * The MIME type a static file is SERVED as (#340). Cloudflare attaches the `Content-Type` of
 * each uploaded part and replays it on every request, so this table is the vertical's served
 * content types — not a guess the runtime re-derives. Unknown extensions fall back to
 * `application/octet-stream`, which browsers download rather than mis-execute.
 */
const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export function assetContentType(path: string): string {
  return ASSET_CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Every regular file under `dir`, recursively, as absolute paths (sorted for determinism). */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    // `statSync` (not lstat) so a symlinked build output is followed like any other file;
    // a symlink loop surfaces as an ELOOP from the walk rather than silently expanding.
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

/** A collected static file: its manifest row and the bytes that ride the upload. */
export interface CollectedAsset {
  entry: AssetEntry;
  content: Buffer;
}

/**
 * Read the vertical's built static files and content-address them (#340) — the substrate
 * side of Cloudflare's asset manifest. Runs AFTER the build (the directory is build output),
 * on the builder's own machine, so reading it is not a trust boundary; the control plane
 * re-derives every hash from the bytes it receives regardless.
 *
 * Paths are `/`-rooted and `/`-separated on every OS: the manifest key is a URL path, not a
 * filesystem path, and a Windows push must produce the same manifest as a Linux one or the
 * two would not dedup against each other.
 */
export async function collectAssets(root: string, need: AssetsNeed): Promise<CollectedAsset[]> {
  const dir = join(root, need.directory);
  if (!existsSync(dir)) {
    throw new Error(
      `substrat.runtimeNeeds.assets.directory points at "${need.directory}", which does not exist under ${root}. ` +
        `It is BUILD output — make sure runtimeNeeds.build (or the wrangler build command) produces it.`,
    );
  }
  const files = walkFiles(dir);
  const collected: CollectedAsset[] = [];
  for (const file of files) {
    const path = '/' + relative(dir, file).split('\\').join('/');
    const content = readFileSync(file);
    collected.push({
      entry: {
        path,
        hash: await assetHash(new Uint8Array(content), path),
        size: content.length,
        contentType: assetContentType(path),
      },
      content,
    });
  }
  return collected;
}

/** A tiny JSONC reader: strip // and block comments, then JSON.parse. */
function readJsonc(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * The Substrat→Cloudflare mapping (D-38): derive the wrangler config a `runtimeNeeds`
 * vertical never authors. The result feeds BOTH the bundler (written to disk, passed via
 * `--config`) and the manifest extraction below — one object, so what we bundle and what
 * we declare cannot drift. The compatibility date is the platform's RUNTIME_BASELINE;
 * a builder states needs, not substrate config.
 *
 * `assets` is deliberately NOT emitted here (#340) even though `runtimeNeeds.assets` exists:
 * wrangler's job in a push is to bundle the worker, and the static files are read straight
 * from the declared directory by `collectAssets` afterwards. Handing wrangler an assets block
 * it would only re-walk buys nothing and puts a second, differently-implemented manifest on
 * the path to the same upload.
 */
export function wranglerConfigFor(needs: RuntimeNeeds): Record<string, unknown> {
  return {
    // wrangler requires a name; the real identity is the platform's deploymentRef.
    name: 'substrat-vertical',
    main: needs.entry,
    compatibility_date: RUNTIME_BASELINE,
    compatibility_flags: needs.needsNodeCompat ? ['nodejs_compat'] : [],
    workers_dev: false,
    ...(needs.build ? { build: { command: needs.build } } : {}),
    ...(needs.stores.length
      ? {
          durable_objects: {
            bindings: needs.stores.map((s) => ({ name: s.binding, class_name: s.class })),
          },
          migrations: [{ tag: 'v1', new_sqlite_classes: needs.stores.map((s) => s.class) }],
        }
      : {}),
  };
}

/**
 * The static-assets need for this push (#340), from EITHER vocabulary: `runtimeNeeds.assets`
 * (D-38, the substrate form) or a hand-authored wrangler.jsonc `assets` block, whose keys are
 * Cloudflare's snake_case. One function so both paths land on the same parsed shape and the
 * manifest cannot depend on which config style the vertical uses.
 *
 * An `assets.binding` (programmatic `env.ASSETS.fetch(...)` from worker code) is REFUSED
 * rather than dropped: it is a real binding, it is not on the §4 allowlist, and silently
 * ignoring it would ship a worker whose `env.ASSETS` is undefined at runtime — a deploy that
 * looks successful and 500s on first request. Serving files needs no binding.
 */
export function readAssetsNeed(
  cfg: Record<string, unknown>,
  needs: RuntimeNeeds | undefined,
): AssetsNeed | undefined {
  if (needs) return needs.assets;
  const raw = cfg.assets as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  if (raw.binding) {
    throw new Error(
      `wrangler.jsonc declares assets.binding "${String(raw.binding)}" — a hosted vertical serves its ` +
        `static files from the edge and cannot bind them for programmatic reads (self-serve-deploy.md §4.1). ` +
        `Drop the binding; \`directory\` alone is what serves the files.`,
    );
  }
  return assetsNeed.parse({
    directory: raw.directory,
    ...(raw.html_handling !== undefined ? { htmlHandling: raw.html_handling } : {}),
    ...(raw.not_found_handling !== undefined ? { notFoundHandling: raw.not_found_handling } : {}),
    ...(raw.run_worker_first !== undefined ? { runWorkerFirst: raw.run_worker_first } : {}),
  });
}

/** The vertical's `substrat.runtimeNeeds` block, parsed — or undefined for the wrangler.jsonc path. */
export function readRuntimeNeeds(dir: string): RuntimeNeeds | undefined {
  let raw: unknown;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      substrat?: { runtimeNeeds?: unknown };
    };
    raw = pkg.substrat?.runtimeNeeds;
  } catch {
    return undefined;
  }
  return raw === undefined ? undefined : runtimeNeeds.parse(raw);
}

export interface PushOptions {
  dir: string;
  slug: string;
  version: string;
  name?: string;
  /**
   * The workspace this push is FOR (the project pin — cli.ts resolves --tenant →
   * SUBSTRAT_TENANT → package.json `substrat.tenant`). Sent with the bundle so the
   * control plane can HONOR it regardless of who is authenticated: a builder session
   * with a different workspace is refused (not silently redirected), and a staff
   * session's claim lands as the pinned tenant's — prefixed and owned like the
   * equivalent builder push — instead of platform-owned with the pin dropped.
   */
  tenant?: string;
  /** The vertical's declared env-spec (from package.json `substrat.envSpec`), carried to the
   *  registry so the platform can render a config form for it. Validated control-plane-side. */
  envSpec?: readonly unknown[];
  /** Registry-driven install fields (marketplace-publish.md §3), from package.json `substrat.*`. */
  ownerGrants?: readonly unknown[];
  entitlements?: readonly unknown[];
  provides?: readonly unknown[];
  requires?: readonly unknown[];
  /** Declared provisioner intent (#455), from package.json `substrat.provisions`: the target
   *  verticals this manager provisions tenants of. A request the console reviews — the
   *  tenant-provisioner capability itself stays a staff-flipped registry flag. */
  provisions?: readonly unknown[];
  /** Declared email-sender intent (#303), from package.json `substrat.sendsEmail`: this vertical
   *  wants to send transactional mail. A request the console reviews — the `emailSender`
   *  capability itself stays a staff-flipped registry flag. */
  sendsEmail?: boolean;
  /** The surfaces the vertical serves (K-26), from package.json `substrat.surfaces` —
   *  labels only; buys the dashboard a hostname-binding picker + a push-time warning. */
  surfaces?: readonly unknown[];
  /** Declared outbound hosts (#303, D-46), from package.json `substrat.outbound`: the
   *  third-party hosts the worker fetches directly, enforced by the egress worker.
   *  Undefined is still SENT as `[]` — a new-CLI push always declares its outbound
   *  surface, and "no third-party egress" is the least-privilege default. */
  outbound?: readonly unknown[];
  /**
   * Acknowledge a lineage fork (#388): a first push of a NEW registry id whose name
   * matches an existing lineage under a different owner is refused by the control plane
   * (it is almost always a mis-identified project, and installs of the existing lineage
   * would never see the push). This flag — the CLI's --allow-fork — makes running a
   * separate same-named lineage a deliberate choice.
   */
  allowFork?: boolean;
  controlPlaneUrl: string;
  /** The auth header to send — a bearer session or an x-service-token (see config.resolveAuth). */
  authHeader: Record<string, string>;
}

/**
 * Build a vertical and push its bundle to the platform's deploy endpoint
 * (self-serve-deploy.md). The worker is built with `wrangler --dry-run --outdir` — the
 * control plane holds the Cloudflare credential, this never does (D-34). The version
 * lands PENDING; admission still gates serving. Authenticated with the caller's own
 * credential (`opts.authHeader` — a browser session or a service token), never a
 * hand-picked `--actor`.
 */
/**
 * The deploy config for a push: `substrat.runtimeNeeds` (D-38, derived) wins, a
 * hand-authored wrangler.jsonc is the fallback — and NEITHER is a refusal with the
 * remedy in it, not an ENOENT stack trace. The remedy leads with runtimeNeeds
 * because that is the substrate-vocabulary path; wrangler.jsonc stays legal but
 * is not what a refusal should teach.
 */
export function resolveWranglerConfig(
  dir: string,
): { cfg: Record<string, unknown>; needs: RuntimeNeeds | undefined } {
  const needs = readRuntimeNeeds(dir);
  const hasWranglerFile = existsSync(join(dir, 'wrangler.jsonc'));
  if (needs && hasWranglerFile) {
    console.log('note: substrat.runtimeNeeds is set — wrangler.jsonc is ignored for this push');
  }
  if (!needs && !hasWranglerFile) {
    throw new Error(
      [
        'nothing to build: no `substrat.runtimeNeeds` in package.json and no wrangler.jsonc.',
        '',
        '  A pushable vertical declares what it needs at runtime — the CLI derives the',
        '  deploy config from it (you never author wrangler config):',
        '',
        '    "substrat": {',
        '      "runtimeNeeds": {',
        '        "entry": "src/worker.ts",',
        '        "needsNodeCompat": true,',
        '        "stores": [',
        '          { "binding": "SCOPE", "class": "ScopeDO" },',
        '          { "binding": "AUTH", "class": "IdentityDO" }',
        '        ]',
        '      }',
        '    }',
        '',
        '  `entry` is the Cloudflare worker entrypoint (the sandbox-clean shape —',
        '  demos/meridian/src/worker.ts is the reference); `stores` are the DO classes',
        '  it exports. A hand-authored wrangler.jsonc also works, but is not required.',
      ].join('\n'),
    );
  }
  return needs
    ? { cfg: wranglerConfigFor(needs), needs }
    : { cfg: readJsonc(join(dir, 'wrangler.jsonc')), needs: undefined };
}

export async function push(
  opts: PushOptions,
): Promise<{ id: string; admission: string; deploymentRef: string; verticalSlug: string; warnings?: string[] }> {
  // Substrate-vocabulary path (D-38): when `substrat.runtimeNeeds` is present the builder
  // authored no wrangler config, so none is read — the CLI derives it. The generated file
  // lands next to the vertical (a relative `main` and the build command's cwd both resolve
  // against the config's directory) and is removed after the build.
  const { cfg, needs } = resolveWranglerConfig(opts.dir);

  // A vertical's OWN stores travel with the bundle: its DO classes, and its D1 databases
  // (e.g. a Better-Auth AUTH_DB). The control plane re-checks these against the §4 sandbox
  // contract before the upload reaches the namespace.
  const doBindings = (cfg.durable_objects as { bindings?: { name: string; class_name: string; script_name?: string }[] } | undefined)?.bindings ?? [];
  const d1 = (cfg.d1_databases as { binding: string; database_id: string }[] | undefined) ?? [];
  const bindings: DeclaredBinding[] = [
    ...doBindings.map((b) => ({
      type: 'durable_object_namespace',
      name: b.name,
      class_name: b.class_name,
      ...(b.script_name ? { script_name: b.script_name } : {}),
    })),
    ...d1.map((b) => ({ type: 'd1', name: b.binding, id: b.database_id })),
  ];
  const migrations = (cfg.migrations as { new_sqlite_classes?: string[] }[] | undefined) ?? [];
  const doClasses = migrations.flatMap((m) => m.new_sqlite_classes ?? []);
  const compatibilityDate = (cfg.compatibility_date as string | undefined) ?? '2025-01-01';
  // Flags travel with the bundle: a vertical needing `nodejs_compat` (Better Auth, node
  // built-ins) can't start without them, and the runtime rejects the upload.
  const compatibilityFlags = (cfg.compatibility_flags as string[] | undefined) ?? [];
  const mainPath = cfg.main as string;

  // Build the bundle (runs the vertical's own build command first).
  const out = mkdtempSync(join(tmpdir(), 'substrat-build-'));
  console.log(`building ${opts.slug}@${opts.version} …`);
  const generated = needs ? join(opts.dir, '.wrangler.substrat.json') : undefined;
  if (generated) writeFileSync(generated, JSON.stringify(cfg, null, 2) + '\n');
  try {
    execFileSync(
      'npx',
      ['wrangler', 'deploy', '--dry-run', '--outdir', out, ...(generated ? ['--config', generated] : [])],
      { cwd: opts.dir, stdio: 'inherit' },
    );
  } finally {
    if (generated) rmSync(generated, { force: true });
  }

  // Collect the built modules; the entry is the bundled basename of `main`.
  const mainBase = basename(mainPath).replace(/\.[cm]?ts$|\.[cm]?js$/, '');
  const files = readdirSync(out).filter((f) => /\.(m?js)$/.test(f) && !f.endsWith('.map'));
  const entry = files.find((f) => f.replace(/\.[cm]?js$/, '') === mainBase) ?? files[0];
  if (!entry) throw new Error(`no built module found in ${out}`);

  const modules = files.map((f) => ({ name: f, content: readFileSync(join(out, f)) }));
  const concat = Buffer.concat(modules.map((m) => m.content));

  // Static files (#340), read from the build output the vertical declared. Collected AFTER
  // the wrangler build above, because the directory is that build's product. A vertical
  // declaring none collects nothing and its push is byte-for-byte what it was before.
  const assetsNeeded = readAssetsNeed(cfg, needs);
  const assets = assetsNeeded ? await collectAssets(opts.dir, assetsNeeded) : [];
  if (assetsNeeded) {
    const bytes = assets.reduce((n, a) => n + a.entry.size, 0);
    console.log(
      `collected ${assets.length} static asset(s) from ${assetsNeeded.directory} (${(bytes / 1_048_576).toFixed(1)} MB)`,
    );
  }

  // The declared permission surface (D-39/D-41), DERIVED from the vertical's typed
  // `definePermissions(...)` entry — shipped in the manifest and hashed into digests.permission
  // below. Throws if the vertical declares no surface: absence is never a silent empty registry.
  const registry = await deriveRegistry(opts.dir);

  // Parsed with the SAME schema the control plane applies at the trust boundary
  // (contracts' deployManifest, re-parsed server-side in control-plane-api). Drift
  // between what the CLI builds and what the server accepts fails here, before the
  // upload, instead of as a 4xx from the deploy endpoint.
  const parseManifest = (input: unknown) => {
    try {
      return deployManifest.parse(input);
    } catch (e) {
      // #386: the CLI assembled this manifest itself, so a schema refusal here is a
      // CLI/contract mismatch — in a workspace checkout, almost always a stale dist
      // running against newer contracts. Name that, instead of a bare Zod issue list.
      throw new Error(
        `the manifest this CLI assembled fails the current deploy contract — if you run the CLI from a ` +
          `workspace checkout, its build is likely stale (pnpm --filter @substrat-run/cli build); ` +
          `otherwise upgrade it (npm i -g @substrat-run/cli).\n${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  const manifest = parseManifest({
    version: opts.version,
    name: opts.name ?? opts.slug,
    entry,
    compatibilityDate,
    compatibilityFlags,
    doClasses,
    bindings,
    // Per-tenant relational stores (#301) travel as a NEED, not a binding: there is no
    // static database id to declare (the platform mints one per tenant), so they never
    // appear in `bindings`/wrangler — only here, for admission + the tenant lifecycle.
    ...(needs?.tenantStores?.length ? { tenantStores: needs.tenantStores } : {}),
    // Per-tenant blob stores (#473) travel the same way — a NEED, never a static
    // r2_bucket binding: the platform mints one bucket per tenant, so there is no id to
    // declare. Carried here for admission + the tenant lifecycle.
    ...(needs?.blobStores?.length ? { blobStores: needs.blobStores } : {}),
    // Static files (#340): the routing config plus the full content-addressed manifest.
    // Sent even when the directory came out EMPTY — an empty `files` list is a vertical
    // that declared assets and built none, which the control plane should see as such
    // rather than as a vertical that declared nothing.
    ...(assetsNeeded
      ? {
          assets: {
            ...(assetsNeeded.htmlHandling ? { htmlHandling: assetsNeeded.htmlHandling } : {}),
            ...(assetsNeeded.notFoundHandling ? { notFoundHandling: assetsNeeded.notFoundHandling } : {}),
            ...(assetsNeeded.runWorkerFirst !== undefined ? { runWorkerFirst: assetsNeeded.runWorkerFirst } : {}),
            files: assets.map((a) => a.entry),
          },
        }
      : {}),
    // The vertical's declared config surface, carried to the registry (control-plane-side
    // validated) so the platform renders a settings form for it. Not part of any admission
    // digest — it's metadata, not code.
    ...(opts.envSpec ? { envSpec: opts.envSpec } : {}),
    // Registry-driven install metadata (marketplace-publish.md §3) — carried so the dashboard
    // installs without a hardcoded catalog entry. Metadata, not code; not in any digest.
    ...(opts.ownerGrants ? { ownerGrants: opts.ownerGrants } : {}),
    ...(opts.entitlements ? { entitlements: opts.entitlements } : {}),
    ...(opts.provides ? { provides: opts.provides } : {}),
    ...(opts.requires ? { requires: opts.requires } : {}),
    ...(opts.provisions ? { provisions: opts.provisions } : {}),
    ...(opts.sendsEmail ? { sendsEmail: true } : {}),
    ...(opts.surfaces ? { surfaces: opts.surfaces } : {}),
    // The declared outbound surface (#303, D-46) — ALWAYS sent, `[]` when undeclared,
    // because absence means "pre-#303 push" to the egress worker (unenforced, metered
    // only) and a new-CLI push must not read as that. Unlike the metadata above it is
    // enforcement input, versioned with the code it ships beside.
    outbound: opts.outbound ?? [],
    // The declared permission surface travels with the bundle (D-39/D-41): keys+descriptions,
    // role templates, entity-grant shapes. Required — its content hash is digests.permission.
    registry,
    digests: {
      manifest: await sha256(concat),
      permission: await permissionDigest(registry),
      migration: await sha256(Buffer.from(JSON.stringify(doClasses))),
    },
  });

  const form = new FormData();
  form.set('manifest', JSON.stringify(manifest));
  // The workspace pin rides WITH the push (not in the manifest — it is addressing, not
  // code, so it stays out of every digest). The control plane honors or refuses it.
  if (opts.tenant) form.set('tenant', opts.tenant);
  if (opts.allowFork) form.set('allowFork', '1');
  // Provenance rides beside the pin for the same reason: it describes THIS push, not the
  // code, so it stays out of every digest. Self-reported — a label, never authority.
  form.set('origin', JSON.stringify(pushOrigin()));
  for (const m of modules) {
    form.set(m.name, new Blob([m.content], { type: 'application/javascript+module' }), m.name);
  }
  // Static files ride the SAME multipart body under a distinct part namespace (#340). The
  // `asset:` prefix is what keeps the two kinds apart at the far end: a module part is
  // whatever is not prefixed, so an asset named `worker.js` cannot be mistaken for one —
  // and the served path (which may contain any URL character) never has to be legal as a
  // module name.
  for (const a of assets) {
    const part = `${ASSET_PART_PREFIX}${a.entry.path}`;
    form.set(part, new Blob([a.content], { type: a.entry.contentType }), part);
  }

  const url = `${opts.controlPlaneUrl}/verticals/${encodeURIComponent(opts.slug)}/deploy`;
  console.log(
    `uploading ${entry} (+${modules.length - 1} modules${assets.length ? `, ${assets.length} assets` : ''}) → ${url}`,
  );
  const res = await fetch(url, {
    method: 'POST',
    headers: opts.authHeader,
    body: form,
  });
  warnIfStale(res.headers);
  const body = await res.text();
  if (!res.ok) {
    // Surface the control plane's own `error` line when the body is its JSON shape —
    // e.g. the #388 fork refusal reads as guidance, not as a wall of escaped JSON.
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (typeof parsed.error === 'string') detail = parsed.error;
    } catch {
      // not JSON — keep the raw body
    }
    throw new Error(`push failed (${res.status}): ${detail}${explainPlatformFault(res.status, detail)}`);
  }
  return parseJsonBody<{ id: string; admission: string; deploymentRef: string; verticalSlug: string; warnings?: string[] }>(body, url);
}

/** Push defaults read from a vertical's package.json, so `substrat push` needs no flags. */
export interface VerticalMeta {
  /** Registry slug: an explicit `substrat.slug`, else the package name with scope + a leading `demo-` stripped. */
  slug: string;
  /**
   * Whether the slug came from an explicit `substrat.slug` pin rather than being derived
   * from the package name. A derived slug silently FOLLOWS a package rename — the #399
   * lineage fork — so push prints a pin-it hint while this is false.
   */
  slugExplicit: boolean;
  /** Display name: an explicit `substrat.name`, else the slug title-cased. */
  name: string;
  /**
   * The workspace this project pushes to — `substrat.tenant`. Repo-scoped and reviewable,
   * because which tenant owns a vertical is a property of the project, not the machine:
   * the first push of a slug CLAIMS `<tenant>/<slug>`, so a machine-wide default silently
   * pointing at the wrong workspace would claim it for the wrong owner. Undefined → the
   * CLI prompts (interactive) or refuses (non-TTY); it never guesses.
   */
  tenant: string | undefined;
  /** package.json `version` — only a seed for the FIRST push of a brand-new slug. */
  versionSeed: string | undefined;
  /** The vertical's declared env-spec, from package.json `substrat.envSpec` — the static,
   *  code-free source the CLI can read at push time (like slug/name). Undefined if none. */
  envSpec: readonly unknown[] | undefined;
  /** Registry-driven install fields, from package.json `substrat.{ownerGrants,entitlements,provides,requires}`. */
  ownerGrants: readonly unknown[] | undefined;
  entitlements: readonly unknown[] | undefined;
  provides: readonly unknown[] | undefined;
  requires: readonly unknown[] | undefined;
  /** Declared provisioner intent (#455), from package.json `substrat.provisions`. */
  provisions: readonly unknown[] | undefined;
  /** Declared email-sender intent (#303), from package.json `substrat.sendsEmail`. */
  sendsEmail: boolean | undefined;
  /** Declared surfaces (K-26), from package.json `substrat.surfaces`: `[{ name, label }]`. */
  surfaces: readonly unknown[] | undefined;
  /** Declared outbound hosts (#303, D-46), from package.json `substrat.outbound`. Undefined
   *  = the key is absent, which the push STILL sends as `[]` — a new-CLI push always
   *  declares its outbound surface, and no third-party egress is the default. */
  outbound: readonly unknown[] | undefined;
}

/**
 * Derive push defaults from the vertical directory's package.json (the "it's already in
 * package.json" the CLI shouldn't make you retype). An explicit `"substrat": { slug, name }`
 * block wins; otherwise the slug is the package name's last segment with a `demo-` prefix
 * stripped (`@substrat-run/demo-meridian` → `meridian`) and the name is that title-cased.
 * Returns empty strings when there is no package.json — the caller then requires flags.
 */
export function readVerticalMeta(dir: string): VerticalMeta {
  let pkg: {
    name?: string;
    version?: string;
    substrat?: { slug?: string; name?: string; tenant?: string; envSpec?: unknown[]; ownerGrants?: unknown[]; entitlements?: unknown[]; provides?: unknown[]; requires?: unknown[]; provisions?: unknown[]; sendsEmail?: boolean; surfaces?: unknown[]; outbound?: unknown[] };
  } = {};
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    // No package.json (or unreadable) — slug/name stay empty and the CLI asks for --slug.
  }
  const bare = (pkg.name ?? '').split('/').pop()?.replace(/^demo-/, '') ?? '';
  const slug = pkg.substrat?.slug ?? bare;
  const title = slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const s = pkg.substrat;
  return {
    slug,
    slugExplicit: s?.slug !== undefined,
    name: s?.name ?? title,
    tenant: s?.tenant,
    versionSeed: pkg.version,
    envSpec: s?.envSpec,
    ownerGrants: s?.ownerGrants,
    entitlements: s?.entitlements,
    provides: s?.provides,
    requires: s?.requires,
    provisions: s?.provisions,
    sendsEmail: s?.sendsEmail,
    surfaces: s?.surfaces,
    outbound: s?.outbound,
  };
}

/**
 * Pin the pushed-to workspace into the project's package.json (`substrat.tenant`) so every
 * later push — any teammate, any machine, CI — lands in the same workspace without asking.
 * Preserves the file's indentation style (best-effort sniff); throws if there is no
 * parseable package.json — the caller only offers pinning when meta came from one.
 */
export function pinTenant(dir: string, tenant: string): void {
  const path = join(dir, 'package.json');
  const raw = readFileSync(path, 'utf8');
  const pkg = JSON.parse(raw) as Record<string, unknown> & { substrat?: Record<string, unknown> };
  pkg.substrat = { ...pkg.substrat, tenant };
  const indent = /^(\s+)"/m.exec(raw)?.[1] ?? '  ';
  writeFileSync(path, JSON.stringify(pkg, null, indent) + '\n');
}

function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function isNewer(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
}

/**
 * The next version to push for a slug: the registry's highest semver, patch-bumped — so a
 * builder never hand-tracks the number. Falls back to the package.json seed (or `0.0.1`) for
 * the first push of a slug the registry has never seen. A non-semver latest is bumped as-is
 * would be wrong, so those are skipped when finding the max.
 *
 * Takes CANDIDATE slugs because the caller may not know the registry id its push will
 * land on: a pinned push claims `<tenantSlug>/<slug>` in general but a legacy bare row
 * owned by the pin stays bare — so cli.ts asks for both and the max across them wins
 * (they are the same lineage; at most one exists in practice).
 */
export async function nextVersion(
  controlPlaneUrl: string,
  header: Record<string, string>,
  slugs: readonly string[],
  seed: string | undefined,
): Promise<string> {
  const base = controlPlaneUrl.replace(/\/$/, '');
  let best: [number, number, number] | null = null;
  for (const slug of slugs) {
    // The max semver must see EVERY version, so walk the paged list to the end.
    const versions = await readAllEntries<{ version: string }>(
      `${base}/verticals/${encodeURIComponent(slug)}/versions`,
      async (pageUrl) => {
        const r = await fetch(pageUrl, { headers: header });
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<{ entries: { version: string }[]; nextCursor: string | null }>;
      },
    ).catch(() => [] as { version: string }[]);
    for (const v of versions) {
      const t = parseSemver(v.version);
      if (t && (!best || isNewer(t, best))) best = t;
    }
  }
  if (best) return `${best[0]}.${best[1]}.${best[2] + 1}`;
  return seed && parseSemver(seed) ? seed : '0.0.1';
}

/**
 * A preview's version LABEL — a semver PRERELEASE (`<base>-<tag>.<n>`), never a release
 * coordinate. `parseSemver` is anchored `^\d+\.\d+\.\d+$`, so a prerelease is skipped when
 * the registry max is computed (`nextVersion` above): a preview push is legible — it names
 * the release it rehearses — yet FREE, unable to collide with or advance the coordinate the
 * repo owns. Auto-bumping to a real coordinate is what put holes in our registry (issue #509,
 * ask (e)). `<n>` disambiguates successive pushes to the same tag on the same base.
 */
export async function previewVersion(
  controlPlaneUrl: string,
  header: Record<string, string>,
  slugs: readonly string[],
  seed: string | undefined,
  tag: string,
): Promise<string> {
  const base = controlPlaneUrl.replace(/\/$/, '');
  const all: string[] = [];
  for (const slug of slugs) {
    const versions = await readAllEntries<{ version: string }>(
      `${base}/verticals/${encodeURIComponent(slug)}/versions`,
      async (pageUrl) => {
        const r = await fetch(pageUrl, { headers: header });
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<{ entries: { version: string }[]; nextCursor: string | null }>;
      },
    ).catch(() => [] as { version: string }[]);
    for (const v of versions) all.push(v.version);
  }
  // The release this preview rehearses: max stable coordinate + 1 (prereleases skipped).
  let release: [number, number, number] | null = null;
  for (const v of all) {
    const t = parseSemver(v);
    if (t && (!release || isNewer(t, release))) release = t;
  }
  const baseVer = release ? `${release[0]}.${release[1]}.${release[2] + 1}` : seed && parseSemver(seed) ? seed : '0.0.1';
  // Climb `<n>` past any existing `<base>-<tag>.<n>` so a re-push never reuses a label.
  const prefix = `${baseVer}-${tag}.`;
  let maxN = 0;
  for (const v of all) {
    if (v.startsWith(prefix)) {
      const n = Number(v.slice(prefix.length));
      if (Number.isInteger(n) && n > maxN) maxN = n;
    }
  }
  return `${prefix}${maxN + 1}`;
}
