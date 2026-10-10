// node tools/override-advisories.mjs [audit.json] [--event <name>] [--base <rev>] [--now <ISO date>]
//
// The pins `pnpm-workspace.yaml` holds in `overrides:` have no other actor (#1601): Dependabot
// reads package.json ranges and the `catalog:` blocks and nothing under `overrides`, so a pin
// there stays wherever the last human left it. An override may say `'catalog:'`, so its version
// lives in the catalog Dependabot does read; either way it is judged at the version it RESOLVES
// to in pnpm-lock.yaml, which is what is installed and what `pnpm audit` reads. Every key is
// judged — read from the block, not a list, so a pin added tomorrow is covered by construction:
//
//   ADVISORY  an advisory of ANY severity whose `vulnerable_versions` contains the resolved
//             version. audit.yml's critical-only gate covers the rest of the tree and does not
//             reach these; this reads the SAME `pnpm audit --json` report. Fails everywhere,
//             immediately. A consciously accepted advisory is expressed exactly as the critical
//             gate expresses it: its GHSA id in package.json's `pnpm.auditConfig.ignoreGhsas`.
//   STALE     a newer release on the version's line (same major; same minor on 0.x) has been out
//             for more than GRACE_DAYS. Newer majors are migrations and prereleases are not
//             releases, so neither counts. Time alone turns this red, so it FAILS only where
//             the pins are the subject — a scheduled or manual run, a push to main, a PR that
//             changes what an override says or the accept file — and is a warning on every
//             other PR, a lockfile-only one included. A consciously held pin goes in ACCEPT_FILE
//             with a reason and an expiry; an expired entry is judged like the pin it was holding.
//
// And the guarantee an override used to give by construction is asserted instead: each package
// in ONE_VERSION resolves to exactly one version in the lockfile.
//
// Release dates come from `pnpm view <name> time versions --json`, the registry the install
// uses; only a version still published counts.
//
// Fails closed (exit 2): a report with no `advisories` map, a release lookup that fails, an
// override whose version cannot be told (a range or catalog reference resolving to more or
// fewer than one version, a catalog reference with no entry), and an accept entry that is
// malformed or names no current pin — "could not tell" must not read as "clean".
//
// No dependencies on purpose: the audit workflow runs no install.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseLockfile } from './ci-scope.mjs';

/**
 * Packages that must resolve to exactly one version. hono: `vertical-host` hands a Hono app
 * across packages, and two resolved versions would be two distinct types (#510/#517).
 * better-sqlite3: v13 ships prebuilt binaries, and a second copy beside it may not (#546).
 */
export const ONE_VERSION = ['better-sqlite3', 'hono'];

/** A top-level mapping of a pnpm-workspace.yaml (`overrides`, `catalog`), as `{ key: value }`. Flat scalars only. */
export function parseBlock(yaml, block) {
  const out = {};
  let inBlock = false;
  for (const raw of yaml.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (line === `${block}:`) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (line.trim() === '') continue; // comment-only and blank lines stay inside the block
    if (!/^\s/.test(line)) break; // next top-level key
    const m = line.match(/^\s+(?:'([^']+)'|"([^"]+)"|([^\s:'"][^:]*?))\s*:\s*(?:'([^']*)'|"([^"]*)"|(\S.*))\s*$/);
    if (!m) throw new Error(`override-advisories: cannot read ${block} line: ${raw}`);
    out[m[1] ?? m[2] ?? m[3]] = (m[4] ?? m[5] ?? m[6]).trim();
  }
  return out;
}

export const parseOverrides = (yaml) => parseBlock(yaml, 'overrides');

/**
 * What each override actually says: a `catalog:` / `catalog:default` value is replaced by the
 * default catalog's entry for the package it overrides. Throws on a missing entry or a named
 * catalog, which this does not read.
 */
export function effectiveOverrides(yaml) {
  const catalog = parseBlock(yaml, 'catalog');
  const out = {};
  for (const [key, value] of Object.entries(parseOverrides(yaml))) {
    if (!value.startsWith('catalog:')) {
      out[key] = value;
      continue;
    }
    const name = overriddenName(key);
    if (value !== 'catalog:' && value !== 'catalog:default') throw new Error(`override-advisories: "${key}: ${value}" names a catalog this does not read`);
    if (catalog[name] === undefined) throw new Error(`override-advisories: "${key}: ${value}" but the catalog has no ${name}`);
    out[key] = catalog[name];
  }
  return out;
}

/** Every version each package resolves to in a pnpm-lock.yaml, as `name -> Set<version>`. */
export function lockedVersions(lockfile) {
  const out = new Map();
  for (const key of parseLockfile(lockfile).packages.keys()) {
    const at = key.lastIndexOf('@');
    const name = key.slice(0, at);
    out.set(name, (out.get(name) ?? new Set()).add(key.slice(at + 1)));
  }
  return out;
}

/**
 * The version each override is judged at. An exact value is its own answer, and must be in the
 * lockfile; anything else (a range, a catalog entry) is the one version the package resolves to.
 * @returns {{ pins: { key, name, version }[], errors: string[] }}
 */
export function resolvePins(overrides, locked) {
  const pins = [];
  const errors = [];
  for (const [key, spec] of Object.entries(overrides)) {
    const name = overriddenName(key);
    const versions = [...(locked.get(name) ?? [])];
    if (EXACT.test(spec) ? !versions.includes(spec) : versions.length !== 1) {
      errors.push(`"${key}: ${spec}" resolves to ${versions.length === 0 ? 'nothing' : versions.join(', ')} in pnpm-lock.yaml — expected exactly one version${EXACT.test(spec) ? `, ${spec}` : ''}`);
      continue;
    }
    pins.push({ key, name, version: EXACT.test(spec) ? spec : versions[0] });
  }
  return { pins, errors };
}

/** The ONE_VERSION packages that resolve to more than one version, as messages. */
export function oneVersionErrors(locked, names = ONE_VERSION) {
  return names.filter((n) => (locked.get(n)?.size ?? 0) > 1).map((n) => `${n} resolves to ${[...locked.get(n)].join(', ')}`);
}

/**
 * The package an override key names: `a>b` -> `b`, `b@<2` -> `b`, `@s/p@1` -> `@s/p`,
 * `b@>4` -> `b`, `a>b@>=4` -> `b`. A `>` is the parent separator only when it does not open a
 * comparator — pnpm's own rule (`[^ |@]>` in @pnpm/parse-overrides) — so `@>` and ` >` stay
 * part of the version selector.
 */
export function overriddenName(key) {
  const last = key.split(/(?<=[^ |@])>/).pop();
  const at = last.indexOf('@', 1);
  return at === -1 ? last : last.slice(0, at);
}

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RELEASE = /^\d+\.\d+\.\d+$/; // an exact version that is not a prerelease

function parse(v) {
  const dash = v.indexOf('-'); // the first one only: `1.0.0-rc-1.2` has prerelease `rc-1.2`
  const core = dash === -1 ? v : v.slice(0, dash);
  return { n: core.split('.').map(Number), pre: dash === -1 ? null : v.slice(dash + 1).split('.') };
}
/** SemVer §11 prerelease precedence: numeric ids numerically and below alphanumeric ones, then length. */
function cmpPre(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) return Number(a[i]) < Number(b[i]) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
function cmp(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.pre === null && y.pre === null) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return cmpPre(x.pre, y.pre);
}

/**
 * Whether `version` satisfies an advisory `vulnerable_versions` range: `||`-separated sets of
 * space-separated comparators (`>=1.2.3 <1.4.0`). The shape the npm audit endpoint emits.
 * Anything it cannot read throws rather than answering false.
 */
export function inRange(version, range) {
  return range.split('||').some((set) =>
    set
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((c) => {
        const m = c.match(/^(<=|>=|<|>|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
        if (!m) throw new Error(`override-advisories: cannot read range "${range}" (at "${c}")`);
        const d = cmp(version, m[2]);
        switch (m[1]) {
          case '<': return d < 0;
          case '<=': return d <= 0;
          case '>': return d > 0;
          case '>=': return d >= 0;
          default: return d === 0;
        }
      }),
  );
}

/** The advisories in a `pnpm audit --json` report against the pins, sorted by package then id. */
export function check(pins, audit, ignored = []) {
  if (!audit || typeof audit.advisories !== 'object' || audit.advisories === null) {
    throw new Error('the audit report has no `advisories` — the lookup failed, and a tree that could not be checked is not clean');
  }
  const hits = [];
  for (const adv of Object.values(audit.advisories)) {
    if (ignored.includes(adv.github_advisory_id)) continue;
    for (const pin of pins) {
      if (pin.name === adv.module_name && inRange(pin.version, adv.vulnerable_versions)) hits.push({ ...pin, advisory: adv });
    }
  }
  hits.sort((a, b) => a.name.localeCompare(b.name) || a.advisory.github_advisory_id.localeCompare(b.advisory.github_advisory_id));
  return hits;
}

export const GRACE_DAYS = 30;
export const ACCEPT_FILE = 'tools/override-advisories.accept.json';
const DAY = 24 * 60 * 60 * 1000;

/** The release line a version belongs to: its major, or `0.<minor>` below 1.0.0. */
function lineOf(version) {
  const [major, minor] = parse(version).n;
  return major === 0 ? `0.${minor}` : String(major);
}

/**
 * How far `version` is behind its own line, given `pnpm view <name> time versions --json`.
 * Only a version in `versions` counts: the registry keeps a `time` entry for an UNPUBLISHED
 * version too, and a pulled patch is not a release anyone can move to. `created`/`modified`
 * fail RELEASE and the `versions` lookup both.
 * @returns {{ latest: string, behindSince: string, stale: boolean } | null} null when nothing
 * newer exists on the line; `behindSince` is the publish date of the first release after it.
 * Throws on an answer it cannot read: a missing `versions` would filter out every release and
 * read as "none stale", and could-not-tell is not clean.
 */
export function staleness(version, release, now) {
  const { time: times, versions } = release ?? {};
  const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  const isVersion = (v) => typeof v === 'string' && v !== '';
  if (!isObject(times)) throw new Error('the registry answer has no `time` map');
  // a package with one version answers `versions` as a bare string
  if (!(isVersion(versions) || (Array.isArray(versions) && versions.length > 0 && versions.every(isVersion)))) {
    throw new Error('the registry answer has no `versions` list');
  }
  const published = new Set([versions].flat());
  const newer = Object.keys(times)
    .filter((v) => published.has(v) && RELEASE.test(v) && lineOf(v) === lineOf(version) && cmp(v, version) > 0)
    .sort(cmp);
  if (newer.length === 0) return null;
  const unreadable = newer.find((v) => typeof times[v] !== 'string' || Number.isNaN(Date.parse(times[v])));
  if (unreadable) throw new Error(`the registry answer dates ${unreadable} unreadably: ${JSON.stringify(times[unreadable])}`);
  const behindSince = newer.map((v) => times[v]).sort()[0];
  return { latest: newer.at(-1), behindSince, stale: now.getTime() - Date.parse(behindSince) > GRACE_DAYS * DAY };
}

/**
 * Reads the accept list against the current pins (`[{ name, version }]`).
 * @returns {{ held: Set<string>, expired: object[], errors: string[] }} `held` keys are `name@version`.
 */
export function readAccepts(entries, pins, now) {
  const held = new Set();
  const expired = [];
  const errors = [];
  if (!Array.isArray(entries)) return { held, expired, errors: [`${ACCEPT_FILE} must be a JSON array`] };
  const today = now.toISOString().slice(0, 10);
  for (const e of entries) {
    const label = JSON.stringify(e);
    if (typeof e?.package !== 'string' || typeof e.version !== 'string' || typeof e.reason !== 'string' || e.reason.trim() === '' || typeof e.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) {
      errors.push(`${label}: needs "package", "version", a non-empty "reason" and "expires" as YYYY-MM-DD`);
    } else if (!pins.some((p) => p.name === e.package && p.version === e.version)) {
      errors.push(`${label}: no override pins ${e.package}@${e.version} — remove the entry`);
    } else if (e.expires < today) {
      expired.push(e);
    } else {
      held.add(`${e.package}@${e.version}`);
    }
  }
  return { held, expired, errors };
}

/**
 * Whether a stale pin fails this run, or only warns. Only a PR that leaves the pins alone is let
 * through: there the passage of time is not the PR's doing. The overrides compared are the
 * effective ones, so a catalog edit to an overridden package counts; a lockfile-only change
 * (Dependabot's included) does not. An unknown event fails closed.
 */
export function stalenessFails({ event, changedFiles = [], baseOverrides = {}, headOverrides = {} }) {
  if (event !== 'pull_request') return true;
  if (changedFiles.includes(ACCEPT_FILE)) return true;
  const sorted = (o) => JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return sorted(baseOverrides) !== sorted(headOverrides);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

/** `fn()`, or exit 2 with `what` and the reason: everything here that can fail means "could not tell". */
function attempt(what, fn) {
  try {
    return fn();
  } catch (e) {
    fail(`override-advisories: ${what}: ${e.message}`);
  }
}

function main() {
  const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: { event: { type: 'string' }, base: { type: 'string' }, now: { type: 'string' } },
  });
  const auditPath = positionals[0] ?? 'audit.json';
  const event = opts.event ?? process.env.GITHUB_EVENT_NAME;
  const now = new Date(opts.now ?? Date.now());
  if (Number.isNaN(now.getTime())) fail(`override-advisories: --now is not a date`);
  const overrides = attempt('cannot read pnpm-workspace.yaml', () => effectiveOverrides(readFileSync('pnpm-workspace.yaml', 'utf8')));
  const locked = attempt('cannot read pnpm-lock.yaml', () => lockedVersions(readFileSync('pnpm-lock.yaml', 'utf8')));
  // Judged before the pins resolve: a second copy of a `catalog:` override is also what stops
  // it resolving, and the duplicate is the actionable half of that report.
  const doubled = oneVersionErrors(locked);
  const reportDoubled = () => {
    if (doubled.length === 0) return;
    console.error(`override-advisories: more than one resolved version of a package that must have one:\n  ${doubled.join('\n  ')}\nFind what pulls in the second copy (\`pnpm why <name>\`) and bring it onto the catalog's version.`);
  };
  const { pins, errors } = resolvePins(overrides, locked);
  if (errors.length > 0) {
    reportDoubled();
    fail(`override-advisories: cannot tell the version an override is judged at:\n  ${errors.join('\n  ')}`);
  }
  const ignored = JSON.parse(readFileSync('package.json', 'utf8')).pnpm?.auditConfig?.ignoreGhsas ?? [];
  const audit = attempt(`cannot read ${auditPath}`, () => JSON.parse(readFileSync(auditPath, 'utf8')));
  const hits = attempt('cannot judge the audit report', () => check(pins, audit, ignored));

  const accepts = attempt(`cannot read ${ACCEPT_FILE}`, () => readAccepts(JSON.parse(readFileSync(ACCEPT_FILE, 'utf8')), pins, now));
  if (accepts.errors.length > 0) fail(`override-advisories: ${ACCEPT_FILE}:\n  ${accepts.errors.join('\n  ')}`);

  const run = (cmd, ...args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const releasesOf = new Map(); // one registry lookup per package, however many keys pin it
  const staleLines = [];
  for (const pin of pins) {
    if (!releasesOf.has(pin.name)) {
      releasesOf.set(pin.name, attempt(`cannot read the release dates of ${pin.name}`, () => JSON.parse(run('pnpm', 'view', pin.name, 'time', 'versions', '--json'))));
    }
    const s = attempt(`cannot judge the release dates of ${pin.name}`, () => staleness(pin.version, releasesOf.get(pin.name), now));
    if (s?.stale && !accepts.held.has(`${pin.name}@${pin.version}`)) {
      staleLines.push(`${pin.name}@${pin.version} (override "${pin.key}") — behind since ${s.behindSince.slice(0, 10)}, more than ${GRACE_DAYS} days; latest on its line is ${s.latest}`);
    }
  }
  for (const e of accepts.expired) staleLines.push(`${e.package}@${e.version} — its ${ACCEPT_FILE} entry expired on ${e.expires} ("${e.reason}")`);

  const base = opts.base ?? 'HEAD^1';
  const prChanges =
    event === 'pull_request'
      ? attempt(`cannot compare against ${base}`, () => ({
          changedFiles: run('git', 'diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean),
          baseOverrides: effectiveOverrides(run('git', 'show', `${base}:pnpm-workspace.yaml`)),
          headOverrides: overrides,
        }))
      : {};
  const staleFailing = staleLines.length > 0 && stalenessFails({ event, ...prChanges });

  reportDoubled();
  if (hits.length > 0) {
    console.error('override-advisories: advisories against an override — raise it in pnpm-workspace.yaml (the catalog entry, for a `catalog:` override):');
    for (const h of hits) {
      const a = h.advisory;
      const patched = a.patched_versions === '<0.0.0' ? 'none' : a.patched_versions;
      console.error(`  ${h.name}@${h.version} (override "${h.key}") — ${a.severity} ${a.github_advisory_id}: ${a.title} · vulnerable ${a.vulnerable_versions} · patched ${patched} · ${a.url}`);
    }
    console.error('If one is consciously accepted, list its GHSA id in package.json pnpm.auditConfig.ignoreGhsas with the reason in the PR.');
  }
  const how = `Raise it in pnpm-workspace.yaml (the catalog entry, for a \`catalog:\` override) to the latest release on its line, or hold it in ${ACCEPT_FILE} with a reason and an expiry.`;
  if (staleFailing) {
    console.error(`override-advisories: stale overrides:\n  ${staleLines.join('\n  ')}\n${how}`);
  } else {
    // A PR that does not touch the pins is not made red by the calendar; the annotation is
    // what reaches its author, and the next push to main or weekly run fails on it.
    for (const line of staleLines) console.log(`::warning title=Stale pnpm override::${line}. ${how}`);
  }
  if (hits.length > 0 || doubled.length > 0 || staleFailing) process.exit(1);
  const names = pins.map((p) => `${p.key}@${p.version}`);
  console.log(`override-advisories: ${names.length} override(s) (${names.join(', ')}), one version each of ${ONE_VERSION.join(', ')} — no advisory of any severity against a pinned version${staleLines.length > 0 ? '; stale pins warned above' : ', and none stale'}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
