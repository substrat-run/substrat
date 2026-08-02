import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import {
  buildPermissionRegistry,
  deployManifest,
  runtimeNeeds,
  RUNTIME_BASELINE,
  type DeclaredBinding,
  type PermissionRegistry,
  type PermissionsInput,
  type RuntimeNeeds,
} from '@substrat-run/contracts';
import { warnIfStale } from './version.js';

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
  /** The surfaces the vertical serves (K-26), from package.json `substrat.surfaces` —
   *  labels only; buys the dashboard a hostname-binding picker + a push-time warning. */
  surfaces?: readonly unknown[];
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
export async function push(
  opts: PushOptions,
): Promise<{ id: string; admission: string; deploymentRef: string; verticalSlug: string; warnings?: string[] }> {
  // Substrate-vocabulary path (D-38): when `substrat.runtimeNeeds` is present the builder
  // authored no wrangler config, so none is read — the CLI derives it. The generated file
  // lands next to the vertical (a relative `main` and the build command's cwd both resolve
  // against the config's directory) and is removed after the build.
  const needs = readRuntimeNeeds(opts.dir);
  if (needs && existsSync(join(opts.dir, 'wrangler.jsonc'))) {
    console.log('note: substrat.runtimeNeeds is set — wrangler.jsonc is ignored for this push');
  }
  const cfg = needs ? wranglerConfigFor(needs) : readJsonc(join(opts.dir, 'wrangler.jsonc'));

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
    ...(opts.surfaces ? { surfaces: opts.surfaces } : {}),
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
  for (const m of modules) {
    form.set(m.name, new Blob([m.content], { type: 'application/javascript+module' }), m.name);
  }

  const url = `${opts.controlPlaneUrl}/verticals/${encodeURIComponent(opts.slug)}/deploy`;
  console.log(`uploading ${entry} (+${modules.length - 1} modules) → ${url}`);
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
    throw new Error(`push failed (${res.status}): ${detail}`);
  }
  return JSON.parse(body) as { id: string; admission: string; deploymentRef: string; verticalSlug: string; warnings?: string[] };
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
  /** Declared surfaces (K-26), from package.json `substrat.surfaces`: `[{ name, label }]`. */
  surfaces: readonly unknown[] | undefined;
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
    substrat?: { slug?: string; name?: string; tenant?: string; envSpec?: unknown[]; ownerGrants?: unknown[]; entitlements?: unknown[]; provides?: unknown[]; requires?: unknown[]; surfaces?: unknown[] };
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
    surfaces: s?.surfaces,
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
    const versions = await fetch(`${base}/verticals/${encodeURIComponent(slug)}/versions`, { headers: header })
      .then((r) => (r.ok ? (r.json() as Promise<{ version: string }[]>) : []))
      .catch(() => [] as { version: string }[]);
    for (const v of versions) {
      const t = parseSemver(v.version);
      if (t && (!best || isNewer(t, best))) best = t;
    }
  }
  if (best) return `${best[0]}.${best[1]}.${best[2] + 1}`;
  return seed && parseSemver(seed) ? seed : '0.0.1';
}
