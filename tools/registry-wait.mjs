/**
 * Whether npm SERVES a version yet, and the order a release publishes in so that it does
 * before anything needs it (#3260).
 *
 * `npm publish` returns once the registry has accepted an upload. Serving it is a separate,
 * later step, and each package reaches it on its own clock: the packument (cached per package,
 * and separately in the abbreviated form an installer asks for) has to list the version, and
 * the tarball it names has to be on the CDN. Release #3222 published `contracts@0.200.0` 52 s
 * before `cli@0.60.2`, in the right order, and `npx @substrat-run/cli@latest` still failed
 * for a while, because npm served the CLI before it served the `contracts` it requires. The
 * scaffold check that followed resolved `engine-workorder@0.13.25` from a packument that listed
 * it and got a 404 on the tarball.
 *
 * So a version is **fetchable** when both halves answer: the abbreviated packument lists it,
 * and its tarball answers 200. The tarball is asked about only once the packument lists the
 * version, so the poll never requests a tarball the registry has not been told about yet.
 *
 * Two users: `tools/publish-packages.mjs` waits, before each topological wave, for every
 * workspace dependency of that wave; `tools/scaffold-check.mjs` waits for every version the
 * scaffold will install. The scaffold job has no `pnpm install`, so this module imports node
 * builtins only.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleepFor } from 'node:timers/promises';

/** The manifest fields whose packages a consumer's install fetches. */
export const RUNTIME_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

/** What `npm install` sends for a packument, so the poll reads the copy an installer reads. */
export const INSTALL_ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';

/** How long a wait lasts before it gives up, and how often it asks. */
export const WAIT_MS = 10 * 60_000;
export const POLL_MS = 10_000;

/** `npm_config_registry` without its trailing slash, or npm's own registry. */
export function registryUrl(env = process.env) {
  return (env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/+$/, '');
}

const isPublic = (member) => Boolean(member) && !member.private && Boolean(member.version);

/**
 * The members `manifest` names by `workspace:` in a runtime field: what its published copy
 * pins at the version this checkout carries. Private members are left out, since a public
 * package cannot install one (`lint:publish-manifests` refuses that edge on its own).
 */
export function workspaceDeps(manifest, members) {
  const names = new Set();
  for (const field of RUNTIME_FIELDS) {
    for (const [name, spec] of Object.entries(manifest?.[field] ?? {})) {
      if (typeof spec === 'string' && spec.startsWith('workspace:') && isPublic(members.get(name))) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * The public members in topological waves: each wave depends only on the waves before it,
 * so publishing a wave once the ones before it are served never exposes a dependent first.
 * A cycle among runtime edges has no such order, and is thrown with its members named.
 */
export function publishWaves(members) {
  const pending = new Map();
  for (const [name, member] of members) {
    if (isPublic(member)) pending.set(name, new Set(workspaceDeps(member.manifest, members)));
  }
  const waves = [];
  const placed = new Set();
  while (pending.size > 0) {
    const wave = [...pending].filter(([, deps]) => [...deps].every((d) => placed.has(d))).map(([name]) => name).sort();
    if (wave.length === 0) {
      throw new Error(`these public packages depend on each other at runtime, so no publish order serves each one's dependencies first: ${[...pending.keys()].sort().join(', ')}`);
    }
    for (const name of wave) {
      pending.delete(name);
      placed.add(name);
    }
    waves.push(wave);
  }
  return waves;
}

/** Every public workspace dependency of `wave`, at this checkout's version: what must be served before it publishes. */
export function needsBefore(wave, members) {
  const names = new Set(wave.flatMap((name) => workspaceDeps(members.get(name)?.manifest, members)));
  return [...names].sort().map((name) => ({ name, version: members.get(name).version }));
}

/** `roots` and every public member they reach through runtime workspace edges, at this checkout's versions. */
export function installClosure(roots, members) {
  const seen = new Set();
  const queue = roots.filter((name) => isPublic(members.get(name)));
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...workspaceDeps(members.get(name).manifest, members));
  }
  return [...seen].sort().map((name) => ({ name, version: members.get(name).version }));
}

/**
 * The members under `packages/`, `engines/` and `connectors/`, read straight off the checkout:
 * every directory a public package lives in, without pnpm (the scaffold job has none).
 */
export function checkoutMembers(root = process.cwd()) {
  const members = new Map();
  for (const dir of ['packages', 'engines', 'connectors']) {
    if (!existsSync(join(root, dir))) continue;
    for (const entry of readdirSync(join(root, dir))) {
      const path = join(root, dir, entry, 'package.json');
      if (!existsSync(path)) continue;
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      if (manifest.name) members.set(manifest.name, { version: manifest.version, private: manifest.private === true, manifest });
    }
  }
  return members;
}

/**
 * Why npm does not serve `name@version` yet, or `null` when it does: the abbreviated
 * packument lists the version and the tarball it names answers 200. A request that fails
 * outright is a reason like any other, so a flaky network is waited out rather than thrown.
 */
export async function unservedReason({ name, version }, { registry = registryUrl(), fetch = globalThis.fetch, signal } = {}) {
  // A wait that has run out starts no new request: the round reports what it has.
  if (signal?.aborted) return 'the wait ran out before it was asked';
  let packument;
  try {
    packument = await fetch(`${registry}/${name.replace('/', '%2f')}`, { headers: { accept: INSTALL_ACCEPT }, signal });
  } catch (error) {
    return `the packument request failed (${error?.message ?? error})`;
  }
  if (packument.status === 404) return 'the registry has no packument for it yet';
  if (!packument.ok) return `the packument answered ${packument.status}`;
  let entry;
  try {
    entry = (await packument.json())?.versions?.[version];
  } catch (error) {
    return `the packument did not parse (${error?.message ?? error})`;
  }
  if (!entry) return 'the packument does not list it yet';
  const tarball = entry.dist?.tarball;
  if (!tarball) return 'the packument lists it with no tarball';
  let head;
  try {
    head = await fetch(tarball, { method: 'HEAD', signal });
  } catch (error) {
    return `the tarball request failed (${error?.message ?? error})`;
  }
  return head.status === 200 ? null : `its tarball answered ${head.status}`;
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
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

/**
 * Ask until npm serves every one of `targets`, or `timeoutMs` has passed. Resolves to what is
 * still not served, each with the last reason it gave: empty means every one is fetchable.
 *
 * The deadline holds during a request too: every request and body read in a round carries a
 * signal that aborts at the deadline, so a stalled registry cannot hold the wait past its bound.
 */
export async function waitUntilServed(
  targets,
  {
    registry = registryUrl(),
    fetch = globalThis.fetch,
    sleep = sleepFor,
    now = Date.now,
    timeoutMs = WAIT_MS,
    intervalMs = POLL_MS,
    log = (line) => console.error(line),
  } = {},
) {
  const unique = new Map(targets.map((t) => [`${t.name}@${t.version}`, t]));
  let pending = [...unique.values()];
  const deadline = now() + timeoutMs;
  for (;;) {
    // At least 1 ms, so a deadline already reached still asks nothing rather than throwing.
    const signal = AbortSignal.timeout(Math.max(1, deadline - now()));
    const reasons = await pool(pending, 8, (target) => unservedReason(target, { registry, fetch, signal }));
    pending = pending.map((target, i) => ({ ...target, reason: reasons[i] })).filter((t) => t.reason !== null);
    if (pending.length === 0) return [];
    if (now() + intervalMs > deadline) return pending;
    log(`  npm does not serve ${pending.length} yet (${pending.slice(0, 3).map((t) => `${t.name}@${t.version}`).join(', ')}${pending.length > 3 ? ', …' : ''}); asking again in ${intervalMs / 1000} s`);
    await sleep(intervalMs);
  }
}

/** One line per version npm did not serve in time, with the reason it last gave. */
export function describeUnserved(missing) {
  return missing.map((t) => `  ${t.name}@${t.version}: ${t.reason}`);
}
