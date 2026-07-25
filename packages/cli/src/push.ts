import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { webcrypto } from 'node:crypto';

interface DeclaredBinding {
  type: string;
  name: string;
  class_name?: string;
  script_name?: string;
  id?: string;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return Buffer.from(digest).toString('hex').slice(0, 32);
}

/** A tiny JSONC reader: strip // and block comments, then JSON.parse. */
function readJsonc(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return JSON.parse(raw) as Record<string, unknown>;
}

export interface PushOptions {
  dir: string;
  slug: string;
  version: string;
  name?: string;
  /** The vertical's declared env-spec (from package.json `substrat.envSpec`), carried to the
   *  registry so the platform can render a config form for it. Validated control-plane-side. */
  envSpec?: readonly unknown[];
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
export async function push(opts: PushOptions): Promise<{ id: string; admission: string; deploymentRef: string }> {
  const cfg = readJsonc(join(opts.dir, 'wrangler.jsonc'));

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

  // Build the bundle (runs the vertical's own wrangler `build.command` first).
  const out = mkdtempSync(join(tmpdir(), 'substrat-build-'));
  console.log(`building ${opts.slug}@${opts.version} …`);
  execFileSync('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', out], {
    cwd: opts.dir,
    stdio: 'inherit',
  });

  // Collect the built modules; the entry is the bundled basename of `main`.
  const mainBase = basename(mainPath).replace(/\.[cm]?ts$|\.[cm]?js$/, '');
  const files = readdirSync(out).filter((f) => /\.(m?js)$/.test(f) && !f.endsWith('.map'));
  const entry = files.find((f) => f.replace(/\.[cm]?js$/, '') === mainBase) ?? files[0];
  if (!entry) throw new Error(`no built module found in ${out}`);

  const modules = files.map((f) => ({ name: f, content: readFileSync(join(out, f)) }));
  const concat = Buffer.concat(modules.map((m) => m.content));

  const manifest = {
    version: opts.version,
    name: opts.name ?? opts.slug,
    entry,
    compatibilityDate,
    compatibilityFlags,
    doClasses,
    bindings,
    // The vertical's declared config surface, carried to the registry (control-plane-side
    // validated) so the platform renders a settings form for it. Not part of any admission
    // digest — it's metadata, not code.
    ...(opts.envSpec ? { envSpec: opts.envSpec } : {}),
    digests: {
      manifest: await sha256(concat),
      permission: await sha256(Buffer.from(JSON.stringify(bindings))),
      migration: await sha256(Buffer.from(JSON.stringify(doClasses))),
    },
  };

  const form = new FormData();
  form.set('manifest', JSON.stringify(manifest));
  for (const m of modules) {
    form.set(m.name, new Blob([m.content], { type: 'application/javascript+module' }), m.name);
  }

  const url = `${opts.controlPlaneUrl}/verticals/${opts.slug}/deploy`;
  console.log(`uploading ${entry} (+${modules.length - 1} modules) → ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: opts.authHeader,
    body: form,
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`push failed (${res.status}): ${body}`);
  }
  return JSON.parse(body) as { id: string; admission: string; deploymentRef: string };
}

/** Push defaults read from a vertical's package.json, so `substrat push` needs no flags. */
export interface VerticalMeta {
  /** Registry slug: an explicit `substrat.slug`, else the package name with scope + a leading `demo-` stripped. */
  slug: string;
  /** Display name: an explicit `substrat.name`, else the slug title-cased. */
  name: string;
  /** package.json `version` — only a seed for the FIRST push of a brand-new slug. */
  versionSeed: string | undefined;
  /** The vertical's declared env-spec, from package.json `substrat.envSpec` — the static,
   *  code-free source the CLI can read at push time (like slug/name). Undefined if none. */
  envSpec: readonly unknown[] | undefined;
}

/**
 * Derive push defaults from the vertical directory's package.json (the "it's already in
 * package.json" the CLI shouldn't make you retype). An explicit `"substrat": { slug, name }`
 * block wins; otherwise the slug is the package name's last segment with a `demo-` prefix
 * stripped (`@substrat-run/demo-meridian` → `meridian`) and the name is that title-cased.
 * Returns empty strings when there is no package.json — the caller then requires flags.
 */
export function readVerticalMeta(dir: string): VerticalMeta {
  let pkg: { name?: string; version?: string; substrat?: { slug?: string; name?: string; envSpec?: unknown[] } } = {};
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    // No package.json (or unreadable) — slug/name stay empty and the CLI asks for --slug.
  }
  const bare = (pkg.name ?? '').split('/').pop()?.replace(/^demo-/, '') ?? '';
  const slug = pkg.substrat?.slug ?? bare;
  const title = slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { slug, name: pkg.substrat?.name ?? title, versionSeed: pkg.version, envSpec: pkg.substrat?.envSpec };
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
 */
export async function nextVersion(
  controlPlaneUrl: string,
  header: Record<string, string>,
  slug: string,
  seed: string | undefined,
): Promise<string> {
  const base = controlPlaneUrl.replace(/\/$/, '');
  const versions = await fetch(`${base}/verticals/${encodeURIComponent(slug)}/versions`, { headers: header })
    .then((r) => (r.ok ? (r.json() as Promise<{ version: string }[]>) : []))
    .catch(() => [] as { version: string }[]);
  let best: [number, number, number] | null = null;
  for (const v of versions) {
    const t = parseSemver(v.version);
    if (t && (!best || isNewer(t, best))) best = t;
  }
  if (best) return `${best[0]}.${best[1]}.${best[2] + 1}`;
  return seed && parseSemver(seed) ? seed : '0.0.1';
}
