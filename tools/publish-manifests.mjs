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
 * The pack-time half also requires the `prepublishOnly` guard (tools/publish-guard.mjs),
 * which is what refuses `npm publish` at the moment it would happen — these checks only
 * see it afterwards.
 *
 * Why it exists: `@substrat-run/control-plane-client@0.1.0` reached npm with
 * `"@substrat-run/contracts": "workspace:^"` in `dependencies`. It carries no provenance
 * attestation, which every version `release.yml` publishes does — so it was not published
 * by `pnpm publish -r`, and `npx @substrat-run/cli` failed for everyone with
 * EUNSUPPORTEDPROTOCOL. A package's FIRST version is published by hand (npm's trusted
 * publisher is configured on a package that already exists), so this is the path to hold:
 * publish that first version with `pnpm publish` from the package directory — the guard
 * refuses `npm publish` — and run `--registry` afterwards.
 */
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PUBLISH_GUARD } from './publish-guard.mjs';

const run = promisify(execFile);

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
 * The package a specifier installs: `npm:<name>@<range>` aliases another package (which is
 * how `pnpm pack` writes `workspace:<name>@…`), anything else installs the key itself.
 */
export function installTarget(dep, spec) {
  if (!String(spec).startsWith('npm:')) return { name: dep, range: String(spec) };
  const rest = String(spec).slice('npm:'.length);
  const at = rest.lastIndexOf('@'); // a scoped name starts with one
  return at > 0 ? { name: rest.slice(0, at), range: rest.slice(at + 1) } : { name: rest, range: 'latest' };
}

/** Each runtime dependency of `manifest`, with the package it actually installs. */
export function runtimeEdges(manifest) {
  return RUNTIME_FIELDS.flatMap((field) =>
    Object.entries(manifest[field] ?? {}).map(([dep, spec]) => ({ field, dep, ...installTarget(dep, spec) })),
  );
}

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
      }
    }
  }
  for (const { field, dep, name } of runtimeEdges(manifest)) {
    if (UNPUBLISHABLE_PROTOCOLS.some((p) => String(manifest[field][dep]).startsWith(p))) continue;
    if (members.get(name)?.private) {
      const what = name === dep ? '' : ` (an alias of ${name})`;
      problems.push(`${id}: ${field}['${dep}']${what} is a private workspace member — it is never published`);
    }
  }
  return problems;
}

/**
 * The runtime dependencies of a served manifest that name a PUBLIC workspace member and
 * that `resolves(name, range)` cannot satisfy. The registry is asked again until `deadline`
 * (ms since epoch), so the lag right after a release publishes a dependency is not red, and
 * a dependency that never ships is. Inside the window each miss is passed to `warn`; what
 * is still missing after it is returned, and the caller refuses it. `sleep` and `now` are
 * injectable for the test.
 */
export async function unresolvedEdges(
  manifest,
  members,
  resolves,
  { deadline, interval = 20_000, sleep, now = Date.now, warn = () => {} } = {},
) {
  let pending = runtimeEdges(manifest).filter(({ name }) => members.has(name) && !members.get(name).private);
  for (;;) {
    const results = await Promise.all(pending.map((e) => resolves(e.name, e.range)));
    pending = pending.filter((_, i) => !results[i]);
    if (!pending.length || now() + interval > deadline) return pending;
    for (const e of pending) warn(`${manifest.name}@${manifest.version} requires ${e.name}@${e.range}, not on npm yet — asking again`);
    await sleep(interval);
  }
}

/**
 * Whether npm can satisfy `name@range`, from npm's own answer to `npm view` (`stdout` and
 * `stderr` of the run): a version printed is yes; E404 (no such package) and ETARGET (no
 * version in range) are no. EUNSUPPORTEDPROTOCOL is a yes too: npm found the version and
 * then choked on ITS manifest — the defect `manifestProblems` reports against that package.
 * Anything else is a question npm did not answer, and is thrown rather than guessed.
 */
export function npmViewAnswer({ ok, stdout = '', stderr = '' }) {
  if (ok) return stdout.trim() !== '';
  if (/\bEUNSUPPORTEDPROTOCOL\b/.test(stderr)) return true;
  if (/\b(E404|ETARGET)\b/.test(`${stdout}${stderr}`)) return false;
  return undefined;
}

/** Whether npm can satisfy `name@range` — asked of npm itself, the resolver a consumer runs. */
async function npmResolves(name, range) {
  let result;
  try {
    result = { ok: true, ...(await run('npm', ['view', `${name}@${range}`, 'version', '--json'])) };
  } catch (err) {
    result = { ok: false, stdout: err.stdout, stderr: err.stderr };
  }
  const answer = npmViewAnswer(result);
  if (answer === undefined) throw new Error(`npm view ${name}@${range} gave no answer:\n${result.stderr}`);
  return answer;
}

/**
 * Every version release.yml publishes carries provenance; one without it came from somewhere
 * else. A note, not a refusal: a package's first version is published by hand by design, and
 * is correct when it was published with `pnpm publish`.
 */
export function provenanceNote(manifest) {
  if (manifest.dist?.attestations) return null;
  return `${manifest.name}@${manifest.version} has no provenance attestation — published outside release.yml`;
}

/**
 * A public package that does not declare the publish guard as `prepublishOnly` can be
 * published with `npm publish`, which ships the unrewritten manifest (tools/publish-guard.mjs).
 */
export function guardProblem(manifest) {
  if (manifest.scripts?.prepublishOnly === PUBLISH_GUARD) return null;
  return `${manifest.name}@${manifest.version}: scripts.prepublishOnly must be '${PUBLISH_GUARD}' — without it \`npm publish\` ships workspace: specifiers`;
}

/**
 * Every workspace member, as pnpm itself enumerates them — minus the gitignored builder
 * studio scratch projects, which are members locally and never published (#769).
 */
export function pnpmMembers(root = process.cwd()) {
  const listed = JSON.parse(
    execFileSync('pnpm', ['-r', 'ls', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' }),
  );
  const members = new Map();
  for (const { path } of listed) {
    if (relative(root, path).startsWith('.builder')) continue;
    const pj = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    if (!pj.name) continue;
    members.set(pj.name, { path, version: pj.version, private: pj.private === true, manifest: pj });
  }
  return members;
}

/**
 * Pack the member at `path` the way `pnpm publish` would and return the package.json inside
 * the tarball — the copy that ships, after pnpm's rewrite.
 */
export async function packedManifest(path) {
  const dest = mkdtempSync(join(tmpdir(), 'publish-manifests-'));
  try {
    await run('pnpm', ['pack', '--pack-destination', dest], { cwd: path });
    const tgz = readdirSync(dest).find((f) => f.endsWith('.tgz'));
    if (!tgz) throw new Error(`pnpm pack wrote no tarball for ${path}`);
    const { stdout } = await run('tar', ['-xzOf', join(dest, tgz), 'package/package.json']);
    return JSON.parse(stdout);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

/** The manifest npm serves for `name@version`, or `null` when that version is not published. */
async function registryManifest(name, version, registry) {
  const res = await fetch(`${registry}/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${name}@${version}: the registry answered ${res.status}`);
  return res.json();
}

/** `fn` over `items`, at most `limit` at a time. */
async function pool(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function main() {
  const registryMode = process.argv.includes('--registry');
  const root = resolve(import.meta.dirname, '..');
  const members = pnpmMembers(root);
  const published = [...members].filter(([, m]) => !m.private);
  const problems = [];
  const notes = [];

  if (registryMode) {
    const registry = (process.env.npm_config_registry ?? 'https://registry.npmjs.org').replace(/\/$/, '');
    const deadline = Date.now() + 3 * 60_000;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await pool(published, 8, async ([name, { version }]) => {
      const manifest = await registryManifest(name, version, registry);
      if (!manifest) {
        notes.push(`${name}@${version} is not on the registry yet`);
        return;
      }
      problems.push(...manifestProblems(manifest, members));
      // A public member it requires must be installable too — published, at a version the
      // range admits. Asked again for a bounded window, the same three minutes
      // scaffold-check waits for a publish, then refused.
      const missing = await unresolvedEdges(manifest, members, npmResolves, {
        deadline,
        sleep,
        warn: (w) => console.log(`warning: ${w}`),
      });
      for (const edge of missing) {
        problems.push(`${name}@${version}: ${edge.field}['${edge.dep}'] requires ${edge.name}@${edge.range}, which npm has no version of`);
      }
      const provenance = provenanceNote(manifest);
      if (provenance) notes.push(provenance);
    });
  } else {
    await pool(published, 6, async ([, { path, manifest }]) => {
      problems.push(...manifestProblems(await packedManifest(path), members));
      // Read from the SOURCE manifest: `pnpm pack` strips `prepublishOnly` from the copy it
      // ships, and the hook only ever runs in this checkout anyway.
      const guard = guardProblem(manifest);
      if (guard) problems.push(guard);
    });
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
