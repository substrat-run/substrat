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

// node-semver's range grammar (https://github.com/npm/node-semver#range-grammar), plus the `v`
// prefix and the space after an operator that it also accepts. Hand-written so the registry
// job needs no install; the test pins it against node-semver itself.
const NR = '(?:0|[1-9]\\d*)';
const XR = `(?:[xX*]|${NR})`;
const IDENTS = '[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*';
const PARTIAL = `v?${XR}(?:\\.${XR}(?:\\.${XR}(?:-${IDENTS})?(?:\\+${IDENTS})?)?)?`;
const SIMPLE = `(?:(?:<=|>=|<|>|=|~>?|\\^)\\s*)?${PARTIAL}`;
const RANGE = `(?:${PARTIAL}\\s+-\\s+${PARTIAL}|${SIMPLE}(?:\\s+${SIMPLE})*)?`;
const RANGE_SET = new RegExp(`^\\s*${RANGE}\\s*(?:\\|\\|\\s*${RANGE}\\s*)*$`);
/** A dist-tag: what npm-package-arg calls a tag once a spec is not a range — letters first, no protocol. */
const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** Whether npm resolves `spec` from the registry: a semver range (versions included) or a dist-tag. */
export function isRegistrySpec(spec) {
  return RANGE_SET.test(spec) || DIST_TAG.test(spec);
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
  for (const { field, dep, name, range } of runtimeEdges(manifest)) {
    const spec = String(manifest[field][dep]);
    if (UNPUBLISHABLE_PROTOCOLS.some((p) => spec.startsWith(p))) continue;
    // An alias's own spec is not caught by the protocol check above —
    // `npm:@substrat-run/contracts@workspace:^` starts with `npm:` — so it is held to the
    // only thing npm resolves inside an alias: a range or a dist-tag.
    if (spec.startsWith('npm:') && !isRegistrySpec(range)) {
      problems.push(`${id}: ${field}['${dep}'] is '${spec}' — an npm: alias must name a semver range or dist-tag`);
      continue;
    }
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
  // Only a spec npm resolves from the registry is asked about. Anything else never reaches
  // npm: a protocol or an alias that is not a range is refused by `manifestProblems`, and
  // the registry's answer to an invalid spec is an error about the QUESTION, not the package.
  let pending = runtimeEdges(manifest).filter(
    ({ name, range }) => members.has(name) && !members.get(name).private && isRegistrySpec(range),
  );
  for (;;) {
    const results = await Promise.all(pending.map((e) => resolves(e.name, e.range)));
    pending = pending.filter((_, i) => !results[i]);
    if (!pending.length || now() + interval > deadline) return pending;
    for (const e of pending) warn(`${manifest.name}@${manifest.version} requires ${e.name}@${e.range}, not on npm yet — asking again`);
    await sleep(interval);
  }
}

/** The error code npm reported for a failed `npm view --json`: its JSON body, else its stderr. */
function npmErrorCode({ stdout = '', stderr = '' }) {
  try {
    const code = JSON.parse(stdout)?.error?.code;
    if (code) return code;
  } catch {}
  return /npm error code (\S+)/.exec(stderr)?.[1] ?? null;
}

/** Codes that say the network or the registry failed, not that the package is missing. */
const TRANSIENT = /^(E429|E5\d\d|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|EPIPE|ENETUNREACH)$/;

/**
 * npm's answer to `npm view <name>@<range> version --json`, for a range that already passed
 * `isRegistrySpec`: a version printed is `true`; E404 or ETARGET is `false` — npm 10 reports
 * both "no such package" and "no version in range" as E404, older npm says ETARGET for the
 * second; a network or registry failure is `'transient'`; anything else is `undefined`, a
 * question npm did not answer, which the caller throws on rather than guessing either way.
 */
export function npmViewAnswer(result) {
  if (result.ok) return (result.stdout ?? '').trim() !== '';
  const code = npmErrorCode(result);
  if (code === 'E404' || code === 'ETARGET') return false;
  if (code && TRANSIENT.test(code)) return 'transient';
  return undefined;
}

/**
 * `fn()` once more after `pause` when its first answer is `'transient'`, so one dropped
 * connection does not redden the weekly job; a failure that persists is thrown, visibly.
 */
export async function withOneRetry(fn, describe, { sleep, pause = 10_000 }) {
  let answer = await fn();
  if (answer === 'transient') {
    await sleep(pause);
    answer = await fn();
  }
  if (typeof answer !== 'boolean') throw new Error(`${describe}: no answer from the registry (${answer ?? 'unexpected error'})`);
  return answer;
}

/** One `npm view` run, as `npmViewAnswer` reads it. */
async function npmView(name, range) {
  try {
    return npmViewAnswer({ ok: true, ...(await run('npm', ['view', `${name}@${range}`, 'version', '--json'])) });
  } catch (err) {
    return npmViewAnswer({ ok: false, stdout: err.stdout, stderr: err.stderr });
  }
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

/**
 * The manifest npm serves for `name@version`, or `null` when that version is not published.
 * A network failure, a 429 or a 5xx is asked once more after `pause`; a second is thrown.
 */
async function registryManifest(name, version, registry, { sleep, pause = 10_000 }) {
  const url = `${registry}/${name.replace('/', '%2f')}/${encodeURIComponent(version)}`;
  const once = () => fetch(url).catch((err) => ({ status: 0, ok: false, err }));
  let res = await once();
  if (res.status === 0 || res.status === 429 || res.status >= 500) {
    await sleep(pause);
    res = await once();
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${name}@${version}: the registry answered ${res.status || res.err}`);
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
      const manifest = await registryManifest(name, version, registry, { sleep });
      if (!manifest) {
        notes.push(`${name}@${version} is not on the registry yet`);
        return;
      }
      problems.push(...manifestProblems(manifest, members));
      // A public member it requires must be installable too — published, at a version the
      // range admits. Asked again for a bounded window, the same three minutes
      // scaffold-check waits for a publish, then refused.
      const resolves = (n, r) => withOneRetry(() => npmView(n, r), `npm view ${n}@${r}`, { sleep });
      const missing = await unresolvedEdges(manifest, members, resolves, {
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
