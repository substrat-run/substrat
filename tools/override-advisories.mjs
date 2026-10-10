// node tools/override-advisories.mjs [audit.json] [--event <name>] [--base <rev>] [--now <ISO date>]
//
// The pins `pnpm-workspace.yaml` holds in `overrides:` have no other actor (#1601): Dependabot
// reads package.json ranges and the `catalog:` blocks and nothing under `overrides`, so a pin
// there stays wherever the last human left it. Two things are judged, for every key — read
// from the block, not a list, so a pin added tomorrow is covered by construction:
//
//   ADVISORY  an advisory of ANY severity whose `vulnerable_versions` contains the pinned
//             version. audit.yml's critical-only gate covers the rest of the tree and does not
//             reach these; this reads the SAME `pnpm audit --json` report. Fails everywhere,
//             immediately. A consciously accepted advisory is expressed exactly as the critical
//             gate expresses it: its GHSA id in package.json's `pnpm.auditConfig.ignoreGhsas`.
//   STALE     a newer release on the pin's line (same major; same minor on 0.x) has been out for
//             more than GRACE_DAYS. Newer majors are migrations and prereleases are not
//             releases, so neither counts. Time alone turns this red, so it FAILS only where
//             the pins are the subject — a scheduled or manual run, a push to main, a PR that
//             changes the overrides, the lockfile or the accept file — and is a warning on
//             every other PR. A consciously held pin goes in ACCEPT_FILE with a reason and an
//             expiry; an expired entry is judged like the stale pin it was holding.
//
// Release dates come from `pnpm view <name> time --json`, the registry the install uses.
//
// Fails closed (exit 2): a report with no `advisories` map, a release lookup that fails, an
// override that is not an exact version (a range cannot be placed against either question), and
// an accept entry that is malformed or names no current pin — "could not tell" must not read as
// "clean".
//
// No dependencies on purpose: the audit workflow runs no install.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** The `overrides:` mapping of a pnpm-workspace.yaml, as `{ key: value }`. Flat scalars only. */
export function parseOverrides(yaml) {
  const out = {};
  let inBlock = false;
  for (const raw of yaml.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trimEnd();
    if (/^overrides:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (line.trim() === '') continue; // comment-only and blank lines stay inside the block
    if (!/^\s/.test(line)) break; // next top-level key
    const m = line.match(/^\s+(?:'([^']+)'|"([^"]+)"|([^\s:'"][^:]*?))\s*:\s*(?:'([^']*)'|"([^"]*)"|(\S.*))\s*$/);
    if (!m) throw new Error(`override-advisories: cannot read overrides line: ${raw}`);
    out[m[1] ?? m[2] ?? m[3]] = (m[4] ?? m[5] ?? m[6]).trim();
  }
  return out;
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

/**
 * @returns {{ hits: object[], unjudgeable: string[] }} `hits` are advisories against a pinned
 * version; `unjudgeable` are overrides whose value is not an exact version.
 */
export function check(overrides, audit, ignored = []) {
  if (!audit || typeof audit.advisories !== 'object' || audit.advisories === null) {
    throw new Error('override-advisories: the audit report has no `advisories` — the lookup failed, and a tree that could not be checked is not clean');
  }
  const pins = new Map(); // name -> [{ key, version }]
  const unjudgeable = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (!EXACT.test(value)) {
      unjudgeable.push(`${key}: ${value}`);
      continue;
    }
    const name = overriddenName(key);
    pins.set(name, [...(pins.get(name) ?? []), { key, version: value }]);
  }
  const hits = [];
  for (const adv of Object.values(audit.advisories)) {
    for (const pin of pins.get(adv.module_name) ?? []) {
      if (ignored.includes(adv.github_advisory_id)) continue;
      if (inRange(pin.version, adv.vulnerable_versions)) hits.push({ ...pin, name: adv.module_name, advisory: adv });
    }
  }
  hits.sort((a, b) => a.name.localeCompare(b.name) || a.advisory.github_advisory_id.localeCompare(b.advisory.github_advisory_id));
  return { hits, unjudgeable };
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
 * How far `version` is behind its own line, given `pnpm view <name> time --json`.
 * @returns {{ latest: string, behindSince: string, stale: boolean } | null} null when nothing
 * newer exists on the line; `behindSince` is the publish date of the first release after it.
 */
export function staleness(version, times, now) {
  const newer = Object.keys(times)
    .filter((v) => EXACT.test(v) && !v.includes('-') && lineOf(v) === lineOf(version) && cmp(v, version) > 0)
    .sort(cmp);
  if (newer.length === 0) return null;
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
 * through: there the passage of time is not the PR's doing. An unknown event fails closed.
 */
export function stalenessFails({ event, changedFiles = [], baseOverrides = {}, headOverrides = {} }) {
  if (event !== 'pull_request') return true;
  if (changedFiles.some((f) => f === 'pnpm-lock.yaml' || f === ACCEPT_FILE)) return true;
  const sorted = (o) => JSON.stringify(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return sorted(baseOverrides) !== sorted(headOverrides);
}

function fail(message) {
  console.error(message);
  process.exit(2);
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
  const overrides = parseOverrides(readFileSync('pnpm-workspace.yaml', 'utf8'));
  const ignored = JSON.parse(readFileSync('package.json', 'utf8')).pnpm?.auditConfig?.ignoreGhsas ?? [];
  let audit;
  try {
    audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  } catch (e) {
    fail(`override-advisories: cannot read ${auditPath}: ${e.message}`);
  }
  let result;
  try {
    result = check(overrides, audit, ignored);
  } catch (e) {
    fail(e.message);
  }
  if (result.unjudgeable.length > 0) {
    fail(`override-advisories: not an exact version, so it cannot be checked against an advisory range:\n  ${result.unjudgeable.join('\n  ')}\nPin overrides exactly.`);
  }

  const pins = Object.entries(overrides).map(([key, version]) => ({ key, version, name: overriddenName(key) }));
  let accepts;
  try {
    accepts = readAccepts(JSON.parse(readFileSync(ACCEPT_FILE, 'utf8')), pins, now);
  } catch (e) {
    fail(`override-advisories: cannot read ${ACCEPT_FILE}: ${e.message}`);
  }
  if (accepts.errors.length > 0) fail(`override-advisories: ${ACCEPT_FILE}:\n  ${accepts.errors.join('\n  ')}`);

  const stale = [];
  for (const pin of pins) {
    let times;
    try {
      times = JSON.parse(execFileSync('pnpm', ['view', pin.name, 'time', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
    } catch (e) {
      fail(`override-advisories: cannot read the release dates of ${pin.name}: ${e.message}`);
    }
    const s = staleness(pin.version, times, now);
    if (s?.stale && !accepts.held.has(`${pin.name}@${pin.version}`)) stale.push({ ...pin, ...s });
  }
  const staleLines = [
    ...stale.map((p) => `${p.name}@${p.version} (override "${p.key}") — behind since ${p.behindSince.slice(0, 10)}, more than ${GRACE_DAYS} days; latest on its line is ${p.latest}`),
    ...accepts.expired.map((e) => `${e.package}@${e.version} — its ${ACCEPT_FILE} entry expired on ${e.expires} ("${e.reason}")`),
  ];

  let staleFails = true;
  if (event === 'pull_request') {
    const base = opts.base ?? 'HEAD^1';
    try {
      const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      staleFails = stalenessFails({
        event,
        changedFiles: git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean),
        baseOverrides: parseOverrides(git('show', `${base}:pnpm-workspace.yaml`)),
        headOverrides: overrides,
      });
    } catch (e) {
      fail(`override-advisories: cannot compare against ${base}: ${e.message}`);
    }
  }

  let failed = false;
  if (result.hits.length > 0) {
    failed = true;
    console.error('override-advisories: advisories against a pinned override (Dependabot cannot move these — raise the pin in pnpm-workspace.yaml):');
    for (const h of result.hits) {
      const a = h.advisory;
      const patched = a.patched_versions === '<0.0.0' ? 'none' : a.patched_versions;
      console.error(`  ${h.name}@${h.version} (override "${h.key}") — ${a.severity} ${a.github_advisory_id}: ${a.title} · vulnerable ${a.vulnerable_versions} · patched ${patched} · ${a.url}`);
    }
    console.error('If one is consciously accepted, list its GHSA id in package.json pnpm.auditConfig.ignoreGhsas with the reason in the PR.');
  }
  if (staleLines.length > 0) {
    const how = `Raise the pin in pnpm-workspace.yaml to the latest release on its line, or hold it in ${ACCEPT_FILE} with a reason and an expiry.`;
    if (staleFails) {
      failed = true;
      console.error(`override-advisories: stale overrides (Dependabot cannot move these):\n  ${staleLines.join('\n  ')}\n${how}`);
    } else {
      // A PR that does not touch the pins is not made red by the calendar; the annotation is
      // what reaches its author, and the next push to main or weekly run fails on it.
      for (const line of staleLines) console.log(`::warning title=Stale pnpm override::${line}. ${how}`);
    }
  }
  if (failed) process.exit(1);
  const names = Object.keys(overrides);
  console.log(`override-advisories: ${names.length} override(s) (${names.join(', ')}) — no advisory of any severity against a pinned version${staleLines.length > 0 && !staleFails ? '; stale pins warned above' : ', and none stale'}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
