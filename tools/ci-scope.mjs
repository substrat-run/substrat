#!/usr/bin/env node
// Which workspace packages a PR's CI has to typecheck, build and test, and how the
// tests split across the parallel shard jobs (.github/workflows/ci.yml).
//
// The rule is the one the workflow always had: the packages with a changed file plus
// everything that depends on them (pnpm's own `...[base]`), widened to EVERYTHING the
// moment a change lands somewhere that could feed a typecheck or a test without living
// in a package. What this adds is the lockfile. `pnpm-lock.yaml` used to widen on its
// own, so a PR that added one dependency to one package ran the whole repo. Now its
// diff is read: each workspace importer whose block changed, and each importer whose
// resolved dependency closure reaches a changed `packages:`/`snapshots:` entry, joins
// the selection (plus its dependents). Anything the reader cannot attribute — a
// changed top-level section (settings, overrides, catalogs, lockfileVersion, …), an
// entry no importer reaches, a change to third-party entries with no importer change
// at all, the root importer, a line it does not recognise — falls back to everything
// and says why. A gate that skips work must never guess.
//
// A push to main always runs everything, so if the graph ever lies the merge goes red
// there instead of a PR going green forever.
//
//   node tools/ci-scope.mjs                   # the whole selection (checks job)
//   node tools/ci-scope.mjs --shard 2 --of 3  # one test shard's slice of it
//   node tools/ci-scope.mjs --base <ref>      # a dry run against another base
//
// On a pull_request the base is HEAD^1: the checkout is GitHub's merge commit, whose
// first parent is the base branch exactly as it was merged against, so every job in
// the run agrees on it no matter when it fetched. Outputs go to $GITHUB_OUTPUT when set.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ── Changed files ───────────────────────────────────────────────────────────

export const MEMBERS = /^(packages|engines|connectors|demos|apps)\//;
// Paths that cannot feed a typecheck or a test. tools/ can (template-sync.mjs writes
// packages/template-check's sources), and so can pnpm-workspace.yaml (the catalog),
// tsconfig.base.json and the workflow, so none of those are here.
export const INERT =
  /^(docs\/|\.changeset\/|\.claude\/|\.githooks\/|\.vscode\/|[^/]+\.md$|LICENSE|\.gitignore$|\.editorconfig$)/;
export const LOCKFILE = 'pnpm-lock.yaml';

export function classify(files) {
  const widening = [];
  let inMembers = 0;
  let lockfile = false;
  for (const f of files) {
    if (MEMBERS.test(f)) inMembers++;
    else if (f === LOCKFILE) lockfile = true;
    else if (!INERT.test(f)) widening.push(f);
  }
  return { widening, inMembers, lockfile };
}

// ── The lockfile ────────────────────────────────────────────────────────────
//
// pnpm writes lockfile v9 in one fixed shape, so this reads that shape strictly
// instead of carrying a YAML parser: a line it does not expect is a throw, and a
// throw is "everything". Only three things are read structurally — the top-level
// sections, the entries of importers/packages/snapshots, and the dependency edges
// between them; everything else is compared as the raw text pnpm wrote.

const DEP_GROUPS = new Set(['dependencies', 'devDependencies', 'optionalDependencies']);

function unquote(s) {
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new Error(`unterminated quote: ${s}`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('"')) return JSON.parse(s);
  return s;
}

// `key:` or `key: value`, with the key possibly quoted.
function splitKey(body, lineNo) {
  const m = /^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^'":][^:]*?):(?: (.*))?$/.exec(body);
  if (!m) throw new Error(`line ${lineNo}: cannot read "${body}"`);
  return { key: unquote(m[1]), value: m[2] };
}

export function parseLockfile(text) {
  const lines = text.split('\n');
  const sections = new Map(); // name -> raw text of the whole section
  const entries = { importers: new Map(), packages: new Map(), snapshots: new Map() };
  let section = null;
  let entry = null; // { raw: string[], deps: Map, group }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    if (line === '---' || line.startsWith('--- ')) throw new Error(`line ${n}: multi-document lockfile`);
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent % 2 !== 0) throw new Error(`line ${n}: odd indentation`);
    if (indent === 0) {
      const { key } = splitKey(line, n);
      if (sections.has(key)) throw new Error(`line ${n}: section ${key} twice`);
      section = key;
      sections.set(key, [line]);
      entry = null;
      continue;
    }
    if (section === null) throw new Error(`line ${n}: content before any section`);
    sections.get(section).push(line);
    if (!(section in entries)) continue;
    if (indent === 2) {
      const { key, value } = splitKey(line.slice(2), n);
      if (value !== undefined && value !== '{}') throw new Error(`line ${n}: unexpected inline entry`);
      if (entries[section].has(key)) throw new Error(`line ${n}: ${section} entry ${key} twice`);
      entry = { raw: [line], deps: new Map(), group: null };
      entries[section].set(key, entry);
      continue;
    }
    if (entry === null) throw new Error(`line ${n}: nested line outside an entry`);
    entry.raw.push(line);
    if (section === 'packages') continue; // resolution metadata only: compared as text
    if (indent === 4) {
      const { key, value } = splitKey(line.slice(indent), n);
      entry.group = DEP_GROUPS.has(key) && value === undefined ? key : null;
      entry.depName = null;
      continue;
    }
    if (entry.group === null) continue; // inside a key we do not read (peerDependencies, …)
    const { key, value } = splitKey(line.slice(indent), n);
    if (section === 'snapshots') {
      if (indent !== 6 || value === undefined) throw new Error(`line ${n}: unexpected snapshot edge`);
      entry.deps.set(`${entry.group}\0${key}`, { name: key, version: unquote(value) });
    } else if (indent === 6) {
      if (value !== undefined) throw new Error(`line ${n}: unexpected importer edge`);
      entry.depName = key;
    } else if (indent === 8 && entry.depName !== null) {
      if (key === 'version') {
        entry.deps.set(`${entry.group}\0${entry.depName}`, { name: entry.depName, version: unquote(value ?? '') });
      } else if (key !== 'specifier') {
        throw new Error(`line ${n}: unexpected importer field ${key}`);
      }
    } else {
      throw new Error(`line ${n}: unexpected importer line`);
    }
  }
  const raw = (lines) => lines.join('\n');
  const flat = (m) => new Map([...m].map(([k, e]) => [k, { raw: raw(e.raw), deps: [...e.deps.values()] }]));
  return {
    sections: new Map([...sections].map(([k, v]) => [k, raw(v)])),
    importers: flat(entries.importers),
    packages: flat(entries.packages),
    snapshots: flat(entries.snapshots),
  };
}

// `vitest@3.2.7(@types/node@22.20.1)(…)` → `vitest@3.2.7`: the packages: key a snapshot is an instance of.
export const packageKeyOf = (snapshotKey) => {
  const at = snapshotKey.indexOf('(');
  return at === -1 ? snapshotKey : snapshotKey.slice(0, at);
};

function snapshotKeyOf(doc, { name, version }) {
  if (version.startsWith('link:')) return null; // a workspace edge: its own importer block says if it moved
  const direct = `${name}@${version}`;
  if (doc.snapshots.has(direct)) return direct;
  if (doc.snapshots.has(version)) return version; // an alias: `name: real-name@1.2.3`
  throw new Error(`${name}@${version} resolves to no snapshot`);
}

function closure(doc, deps) {
  const seen = new Set();
  const stack = deps.map((d) => snapshotKeyOf(doc, d)).filter(Boolean);
  while (stack.length > 0) {
    const key = stack.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    for (const d of doc.snapshots.get(key).deps) {
      const next = snapshotKeyOf(doc, d);
      if (next !== null && !seen.has(next)) stack.push(next);
    }
  }
  return seen;
}

function changedKeys(a, b) {
  const out = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(k)?.raw !== b.get(k)?.raw) out.push(k);
  }
  return out.sort();
}

const STRUCTURED = new Set(['importers', 'packages', 'snapshots']);

/**
 * The workspace importers (lockfile keys: `.`, `packages/kernel`, …) whose resolved
 * dependencies differ between two lockfiles — or `{ everything: reason }` when the
 * difference cannot be pinned to importers.
 */
export function lockfileScope(baseText, headText) {
  let base, head;
  try {
    base = parseLockfile(baseText);
    head = parseLockfile(headText);
  } catch (e) {
    return { everything: `${LOCKFILE} could not be read (${e.message})` };
  }
  const sections = changedKeys(
    new Map([...base.sections].filter(([k]) => !STRUCTURED.has(k)).map(([k, v]) => [k, { raw: v }])),
    new Map([...head.sections].filter(([k]) => !STRUCTURED.has(k)).map(([k, v]) => [k, { raw: v }])),
  );
  if (sections.length > 0) return { everything: `${LOCKFILE} changed outside its entries: ${sections.join(', ')}` };

  const importers = new Set(changedKeys(base.importers, head.importers));
  const changedPackages = changedKeys(base.packages, head.packages);
  const changedSnapshots = new Set(changedKeys(base.snapshots, head.snapshots));
  // A changed packages: entry (its resolution, engines, …) changes every snapshot of it.
  for (const doc of [base, head]) {
    for (const k of doc.snapshots.keys()) if (changedPackages.includes(packageKeyOf(k))) changedSnapshots.add(k);
  }
  const unmatched = changedPackages.filter((p) => ![...changedSnapshots].some((s) => packageKeyOf(s) === p));
  if (unmatched.length > 0) return { everything: `${LOCKFILE} packages entries with no snapshot: ${unmatched.slice(0, 5).join(', ')}` };

  if (changedSnapshots.size > 0 && importers.size === 0) {
    // Attributable in principle — the closure walk below would find the importers —
    // but a bump nobody asked a package for is exactly where a surprise lives, and it
    // is rare enough that running everything costs little.
    return { everything: `${LOCKFILE} changed third-party entries without changing any importer` };
  }

  // Every importer whose closure, before or after, touches a changed entry.
  const reached = new Set();
  try {
    for (const doc of [base, head]) {
      for (const [key, { deps }] of doc.importers) {
        let hit = false;
        for (const s of closure(doc, deps)) {
          if (changedSnapshots.has(s)) {
            reached.add(s);
            hit = true;
          }
        }
        if (hit) importers.add(key);
      }
    }
  } catch (e) {
    return { everything: `${LOCKFILE} could not be walked (${e.message})` };
  }
  const orphans = [...changedSnapshots].filter((s) => !reached.has(s));
  if (orphans.length > 0) {
    return { everything: `${LOCKFILE} entries no importer reaches: ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ', …' : ''}` };
  }
  if (importers.has('.')) return { everything: `${LOCKFILE} changed the root importer's dependencies (tools/ and every script run on them)` };
  return { importers: [...importers].sort() };
}

// ── Shards ──────────────────────────────────────────────────────────────────
//
// Seconds each package's `test` took in a full CI run on main (2026-09-26). Only a
// weight: a package missing here gets DEFAULT_WEIGHT and still lands in a shard, and
// a stale number costs balance, never coverage. The three longest suites are pinned
// to different shards so they never queue behind one another.

export const PINNED = {
  'packages/adapter-cloudflare': 0,
  'demos/auth-server': 1,
  'apps/control-plane': 2,
};

export const WEIGHTS = {
  'packages/adapter-cloudflare': 86, 'demos/auth-server': 92, 'apps/control-plane': 50,
  'packages/control-plane-api': 38, 'demos/ticket0': 36, 'demos/manyfold': 30,
  'demos/meridian': 30, 'demos/tock': 28, 'packages/builder-workspace': 22,
  'apps/dashboard/web': 20, 'packages/cli': 19, 'packages/adapter-sqlite': 19,
  'packages/kernel': 18, 'apps/dashboard': 18, 'engines/protocol': 17, 'demos/callout': 17,
  'connectors/scrive': 16, 'demos/handlebar': 15, 'engines/invoicing': 13, 'demos/shop': 13,
  'apps/builder': 13, 'packages/contracts': 12, 'engines/booking': 12, 'engines/workorder': 12,
  'apps/console': 12, 'engines/absence': 11, 'engines/metering': 11, 'engines/invites': 10,
  'demos/todo': 10, 'packages/vertical-host': 9, 'packages/vertical-auth': 9,
  'packages/oidc-rp': 8, 'connectors/planima': 7, 'packages/model-emit': 7, 'apps/docs': 7,
  'packages/builder-generator': 7, 'connectors/fortnox': 7, 'apps/social-relay': 6,
  'packages/contract-tests': 6, 'packages/model-providers': 6, 'packages/template-check': 6,
  'apps/vertical-egress': 4, 'apps/router': 4,
};
export const DEFAULT_WEIGHT = 3;

/**
 * Split `packages` ([{ name, dir }]) into `n` shards: pinned packages first, then the
 * rest heaviest-first onto the lightest shard. Deterministic for the same input, so
 * every job in a run computes the same split. Throws unless the shards partition the
 * input exactly — a package in no shard would be a package nobody tests.
 */
export function assignShards(packages, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`shard count must be a positive integer, got ${n}`);
  const shards = Array.from({ length: n }, () => ({ load: 0, packages: [] }));
  const weight = (p) => WEIGHTS[p.dir] ?? DEFAULT_WEIGHT;
  const rest = [];
  for (const p of packages) {
    const pin = PINNED[p.dir];
    if (pin !== undefined && pin < n) {
      shards[pin].packages.push(p);
      shards[pin].load += weight(p);
    } else rest.push(p);
  }
  rest.sort((a, b) => weight(b) - weight(a) || a.dir.localeCompare(b.dir));
  for (const p of rest) {
    const target = shards.reduce((lo, s, i) => (s.load < shards[lo].load ? i : lo), 0);
    shards[target].packages.push(p);
    shards[target].load += weight(p);
  }
  const out = shards.map((s) => s.packages.map((p) => p.name).sort());
  assertPartition(packages.map((p) => p.name), out);
  return out;
}

export function assertPartition(selection, shards) {
  const seen = new Map();
  for (const [i, shard] of shards.entries()) {
    for (const name of shard) {
      if (seen.has(name)) throw new Error(`${name} is in shard ${seen.get(name) + 1} and shard ${i + 1}`);
      seen.set(name, i);
    }
  }
  const missing = selection.filter((name) => !seen.has(name));
  const extra = [...seen.keys()].filter((name) => !selection.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`shards do not partition the selection — missing: [${missing.join(', ')}], extra: [${extra.join(', ')}]`);
  }
}

/**
 * What a shard builds before it tests `names`: each of them, the workspace packages
 * nested under its directory (a demo's `app/`, `admin/`), and — through pnpm's `name...`
 * — everything those depend on. The nesting is not a declared edge: a demo's
 * `pretypecheck` inlines its built `app/dist` into `src/assets.generated.ts`, and its
 * suites assert against that SPA, so the app must be built even though nothing imports it.
 */
export function buildNames(names, all) {
  const dirs = all.filter((p) => names.includes(p.name)).map((p) => `${p.dir}/`);
  const nested = all.filter((p) => dirs.some((d) => p.dir.startsWith(d))).map((p) => p.name);
  return [...new Set([...names, ...nested])].sort();
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function workspace(filters) {
  const out = execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json', ...filters.map((f) => `--filter=${f}`)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const root = process.cwd();
  return JSON.parse(out)
    .filter((p) => p.path !== root)
    .map((p) => ({ name: p.name, dir: p.path.slice(root.length + 1) }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

export function decide({ event, base, files, lockfile, all, selectChanged }) {
  if (event !== 'pull_request') return { everything: `a ${event} runs everything` };
  const { widening, inMembers, lockfile: lockfileChanged } = classify(files);
  if (widening.length > 0) {
    return { everything: 'changed outside every package:', detail: widening };
  }
  const extra = [];
  if (lockfileChanged) {
    const scope = lockfile();
    if (scope.everything) return { everything: scope.everything };
    const byDir = new Map(all.map((p) => [p.dir, p]));
    for (const dir of scope.importers) {
      const p = byDir.get(dir);
      if (p) extra.push(p.name);
      // An importer that is no longer a member was removed; its directory is in the
      // diff under a package path, which the selector below already accounts for.
    }
  }
  const selected = selectChanged(extra);
  if (inMembers > 0 && selected.length === 0) {
    // pnpm's selector answers "nothing" for reasons other than "nothing changed" — it
    // does inside a linked git worktree, for one — and a gate that skips work must
    // never mistake the two.
    return { everything: `${inMembers} package file(s) changed but pnpm selected no package` };
  }
  return { selected, base, lockfileChanged, lockfileImporters: extra };
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const shardArg = arg('--shard');
  const of = Number(arg('--of') ?? 1);
  const event = process.env.GITHUB_EVENT_NAME ?? 'pull_request';
  let base = arg('--base');
  if (base === undefined && event === 'pull_request') {
    const parents = git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ');
    base = parents.length === 3 ? parents[1] : undefined;
  }
  const all = workspace([]);
  let result;
  if (event === 'pull_request' && base === undefined) {
    result = { everything: 'HEAD is not a merge commit and no --base was given, so there is no base to diff' };
  } else {
    result = decide({
      event,
      base,
      files: event === 'pull_request' ? git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean) : [],
      lockfile: () => lockfileScope(git('show', `${base}:${LOCKFILE}`), git('show', `HEAD:${LOCKFILE}`)),
      all,
      selectChanged: (extra) => workspace([`...[${base}]`, ...extra.map((n) => `...${n}`)]),
    });
  }

  const everything = 'everything' in result;
  const selection = everything ? all : result.selected;
  if (everything) {
    console.log(`scope: everything — ${result.everything}`);
    for (const d of result.detail ?? []) console.log(`  ${d}`);
  } else {
    console.log(`scope: ${selection.length} package(s) — changed against ${base}, plus their dependents:`);
    for (const p of selection) console.log(`  ${p.dir}`);
    if (result.lockfileImporters.length > 0) {
      console.log(`scope: ${LOCKFILE} changed the dependencies of: ${result.lockfileImporters.join(', ')}`);
    } else if (result.lockfileChanged) {
      console.log(`scope: ${LOCKFILE} changed, but no importer's resolved dependencies did (entries reordered only)`);
    }
  }

  const outputs = { mode: everything ? 'everything' : 'scoped' };
  if (shardArg === undefined) {
    // The checks job: a filter only when scoped, so "everything" stays today's unfiltered run.
    outputs.filters = everything ? '' : selection.map((p) => `--filter=${p.name}`).join(' ');
  } else {
    const index = Number(shardArg) - 1;
    const shards = assignShards(selection, of);
    if (!(index >= 0 && index < of)) throw new Error(`--shard ${shardArg} is outside 1..${of}`);
    for (const [i, names] of shards.entries()) console.log(`shard ${i + 1}/${of}: ${names.length} package(s)${i === index ? ' ← this job' : ''}`);
    const mine = shards[index];
    for (const name of mine) console.log(`  ${name}`);
    outputs.count = String(mine.length);
    outputs.filters = mine.map((name) => `--filter=${name}`).join(' ');
    // What this shard's tests need built: its packages, their nested apps, and dependencies.
    outputs.build_filters = buildNames(mine, all).map((name) => `--filter=${name}...`).join(' ');
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
  } else {
    for (const [k, v] of Object.entries(outputs)) console.log(`${k}=${v}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
