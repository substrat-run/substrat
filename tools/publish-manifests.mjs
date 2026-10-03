#!/usr/bin/env node
/**
 * The package.json a published package actually carries resolves from npm.
 *
 * A workspace manifest is not the manifest that ships. `pnpm publish` rewrites it at pack
 * time — `workspace:^` becomes `^<version>`, `catalog:` becomes the catalog's range — and
 * only that rewritten copy reaches the registry. So the source file proves nothing, and the
 * question has to be asked of the artifact. Two ways in:
 *
 *   node tools/publish-manifests.mjs             pack every public workspace member with
 *                                                `pnpm pack` and check the packed package.json
 *   node tools/publish-manifests.mjs --registry  check each public member's CURRENT version
 *                                                as npm serves it, where it is published
 *
 * The first runs in CI and in front of `pnpm publish -r`: it is what this repo's own
 * publish would ship. It cannot see a version that reached npm some other way, and
 * `pnpm publish -r` skips a version npm already has — so a broken copy published by hand
 * is never replaced, and every packed manifest still reads clean. The second is that
 * other half, run after a release.
 *
 * Both are the same check (`manifestProblems`): no dependency specifier npm cannot
 * resolve (`workspace:`, `catalog:`, `link:`, `file:`, `portal:`), and no runtime
 * dependency on a workspace member that is private, which npm has never been given.
 *
 * Why it exists: `@substrat-run/control-plane-client@0.1.0` reached npm with
 * `"@substrat-run/contracts": "workspace:^"` in `dependencies`. It carries no provenance
 * attestation, which every version `release.yml` publishes does — so it was not published
 * by `pnpm publish -r`, and `npx @substrat-run/cli` failed for everyone with
 * EUNSUPPORTEDPROTOCOL. A package's FIRST version is published by hand (npm's trusted
 * publisher is configured on a package that already exists), so this is the path to hold:
 * publish that first version with `pnpm publish` from the package directory, never
 * `npm publish`, and run `--registry` afterwards.
 */
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

/** Specifier protocols that mean something inside a workspace and nothing on npm. */
export const UNPUBLISHABLE_PROTOCOLS = ['workspace:', 'catalog:', 'link:', 'file:', 'portal:'];
/** The fields npm installs for a consumer — a private member named here can never resolve. */
export const RUNTIME_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
/**
 * Every field `pnpm publish` rewrites. npm ignores a dependency's devDependencies, so an
 * unresolvable one there breaks no install — but it means the manifest was never rewritten,
 * which is the defect, and it is free to refuse.
 */
export const DEP_FIELDS = [...RUNTIME_FIELDS, 'devDependencies'];

/**
 * What is wrong with one manifest as a consumer of the registry would receive it.
 * `members` maps each workspace package name to `{ private }`.
 */
export function manifestProblems(manifest, members) {
  const id = `${manifest.name}@${manifest.version}`;
  const problems = [];
  for (const field of DEP_FIELDS) {
    for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
      const protocol = UNPUBLISHABLE_PROTOCOLS.find((p) => String(spec).startsWith(p));
      if (protocol) {
        problems.push(`${id}: ${field}['${dep}'] is '${spec}' — npm cannot resolve the ${protocol} protocol`);
        continue;
      }
      if (RUNTIME_FIELDS.includes(field) && members.get(dep)?.private) {
        problems.push(`${id}: ${field}['${dep}'] is a private workspace member — it is never published`);
      }
    }
  }
  return problems;
}

/**
 * `package/package.json` out of an npm tarball (gzip + tar). Parsed here rather than by
 * shelling out to `tar`, so the test drives the same reader the gate uses.
 */
export function readPackedManifest(tgz) {
  const tar = gunzipSync(tgz);
  const field = (start, length) => {
    const raw = tar.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end === -1 ? length : end).toString('utf8');
  };
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = field(offset, 100);
    if (name === '') break; // the two zero blocks that end an archive
    const prefix = field(offset + 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(field(offset + 124, 12).trim() || '0', 8);
    const body = offset + 512;
    if (path === 'package/package.json') {
      return JSON.parse(tar.subarray(body, body + size).toString('utf8'));
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  throw new Error('no package/package.json in the tarball');
}

/**
 * Every workspace member, as pnpm itself enumerates them — minus the gitignored builder
 * studio scratch projects, which are members locally and never published (#769).
 */
export function workspaceMembers(root = process.cwd()) {
  const listed = JSON.parse(
    execFileSync('pnpm', ['-r', 'ls', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' }),
  );
  const members = new Map();
  for (const { path } of listed) {
    if (relative(root, path).startsWith('.builder')) continue;
    const pj = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    if (!pj.name) continue;
    members.set(pj.name, { path, version: pj.version, private: pj.private === true });
  }
  return members;
}

const run = promisify(execFile);

/** Pack one member into `dest` and return its packed manifest. */
async function packedManifest(path, dest) {
  const before = new Set(readdirSync(dest));
  await run('pnpm', ['pack', '--pack-destination', dest], { cwd: path });
  const tgz = readdirSync(dest).find((f) => !before.has(f) && f.endsWith('.tgz'));
  if (!tgz) throw new Error(`pnpm pack wrote no tarball for ${path}`);
  return readPackedManifest(readFileSync(join(dest, tgz)));
}

/** The manifest npm serves for `name@version`, or `null` when that version is not published. */
async function registryManifest(name, version, registry) {
  const res = await fetch(`${registry}/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${name}@${version}: the registry answered ${res.status}`);
  return res.json();
}

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function main() {
  const registryMode = process.argv.includes('--registry');
  const root = resolve(import.meta.dirname, '..');
  const members = workspaceMembers(root);
  const published = [...members].filter(([, m]) => !m.private);
  const problems = [];
  const notes = [];

  if (registryMode) {
    const registry = (process.env.npm_config_registry ?? 'https://registry.npmjs.org').replace(/\/$/, '');
    await pool(published, 8, async ([name, { version }]) => {
      const manifest = await registryManifest(name, version, registry);
      if (!manifest) return notes.push(`${name}@${version} is not on the registry yet`);
      problems.push(...manifestProblems(manifest, members));
      // Every version release.yml publishes carries provenance; one without it came from
      // somewhere else. Reported, not refused: a package's first version is published by
      // hand by design, and is correct when it was published with `pnpm publish`.
      if (!manifest.dist?.attestations) notes.push(`${name}@${version} has no provenance attestation — published outside release.yml`);
    });
  } else {
    const dest = mkdtempSync(join(tmpdir(), 'publish-manifests-'));
    try {
      // One destination directory per member: two tarballs from parallel packs must never
      // be mistaken for each other.
      await pool(published, 6, async ([name, { path }]) => {
        const own = mkdtempSync(join(dest, 'p-'));
        const manifest = await packedManifest(path, own);
        if (manifest.name !== name) problems.push(`${name}: packed a manifest named ${manifest.name}`);
        problems.push(...manifestProblems(manifest, members));
      });
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  }

  for (const note of notes.sort()) console.log(`note: ${note}`);
  const where = registryMode ? 'as npm serves them' : 'as `pnpm pack` writes them';
  if (problems.length) {
    console.error(`✗ ${problems.length} problem(s) in the published manifests, ${where}:`);
    for (const p of problems.sort()) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`✓ ${published.length} public packages, manifests ${where}: every dependency resolves from npm`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
