// node tools/override-advisories.mjs [audit.json]
//
// An advisory of ANY severity against a version `pnpm-workspace.yaml` pins in `overrides:` is
// a failure (#1601). Dependabot reads package.json ranges and the `catalog:` blocks and nothing
// under `overrides`, so for these pins the scanner cannot act, and audit.yml's critical-only
// gate will not — no severity is low enough to leave to either. Everything else in the tree
// keeps that gate; this reads the SAME `pnpm audit --json` report and judges only the
// overridden packages.
//
// Reads the keys, not a list: a pin added to `overrides:` tomorrow is covered by construction.
//
// Fails closed. A report with no `advisories` map (registry error) and an override whose value
// is not an exact version (a range cannot be placed against `vulnerable_versions`) both exit 2,
// because "could not tell" must not read as "clean".
//
// A consciously accepted advisory is expressed exactly as the critical gate expresses it: its
// GHSA id in package.json's `pnpm.auditConfig.ignoreGhsas`.
//
// No dependencies on purpose: the audit workflow runs no install.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

function main() {
  const auditPath = process.argv[2] ?? 'audit.json';
  const overrides = parseOverrides(readFileSync('pnpm-workspace.yaml', 'utf8'));
  const ignored = JSON.parse(readFileSync('package.json', 'utf8')).pnpm?.auditConfig?.ignoreGhsas ?? [];
  let audit;
  try {
    audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  } catch (e) {
    console.error(`override-advisories: cannot read ${auditPath}: ${e.message}`);
    process.exit(2);
  }
  let result;
  try {
    result = check(overrides, audit, ignored);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const names = Object.keys(overrides);
  if (result.unjudgeable.length > 0) {
    console.error(`override-advisories: not an exact version, so it cannot be checked against an advisory range:\n  ${result.unjudgeable.join('\n  ')}\nPin overrides exactly.`);
    process.exit(2);
  }
  if (result.hits.length === 0) {
    console.log(`override-advisories: ${names.length} override(s) (${names.join(', ')}) — no advisory of any severity against a pinned version.`);
    return;
  }
  console.error('override-advisories: advisories against a pinned override (Dependabot cannot move these — raise the pin in pnpm-workspace.yaml):');
  for (const h of result.hits) {
    const a = h.advisory;
    const patched = a.patched_versions === '<0.0.0' ? 'none' : a.patched_versions;
    console.error(`  ${h.name}@${h.version} (override "${h.key}") — ${a.severity} ${a.github_advisory_id}: ${a.title} · vulnerable ${a.vulnerable_versions} · patched ${patched} · ${a.url}`);
  }
  console.error('If one is consciously accepted, list its GHSA id in package.json pnpm.auditConfig.ignoreGhsas with the reason in the PR.');
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
