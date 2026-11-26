#!/usr/bin/env node
/**
 * The peer-floor checkpoint — an engine or connector compiles against the oldest kernel it
 * says it accepts.
 *
 * Engines and connectors run inside the vertical's kernel: they take its `ctx` and hand back
 * a `BoundOperations` its host registers, a class whose private field makes two copies
 * incompatible types. So `@substrat-run/kernel` and `@substrat-run/contracts` are
 * **peerDependencies** of every package under `engines/` and `connectors/`: the vertical owns
 * the one copy, and the engine states the range it works with.
 *
 * They used to be `workspace:^` dependencies, published as `^0.<minor>.0`. On 0.x a caret
 * admits one minor, so every kernel minor left every engine out of range and changesets
 * republished all of them — 28 published packages for a kernel-only feature, most with
 * nothing in their changelog but "Updated dependencies". A peer range `>=0.213.0 <1.0.0`
 * moves only when the engine starts using something newer, and changesets leaves an
 * in-range peer alone (`onlyUpdatePeerDependentsWhenOutOfRange` in `.changeset/config.json`).
 *
 * That trade is only honest if the floor is true. The workspace always builds an engine
 * against the kernel at HEAD, which proves the top of the range and nothing else — an engine
 * that starts calling a kernel export newer than its floor stays green here and breaks for a
 * vertical that installed the floor. So this tool:
 *
 *   1. Static (always): every such package declares both as peers in the one shape this tool
 *      reads, `>=X.Y.Z <N.0.0`; the workspace's own version is inside that range; it keeps a
 *      `workspace:*` devDependency so the monorepo links HEAD; and neither is a regular
 *      dependency.
 *   2. Floor (unless `--static`): installs the floor versions FROM NPM into a scratch
 *      directory, with each package's third-party dependencies, and typechecks each
 *      package's `src` against them with the workspace's `tsc`. A package whose floor is not
 *      published is refused: nobody could install it.
 *
 * What it does NOT check: behaviour at the floor. The engines' suites run through
 * `engine-test-kit` and the adapters, which version with the kernel, so running them against
 * an old kernel means building a second copy of half the workspace. The floor typecheck
 * catches the common way a floor goes stale — a new export, a new field, a widened `ctx` —
 * and a behavioural dependency on a newer kernel is the reviewer's to raise the floor for.
 *
 *   pnpm lint:peer-floor            static rules + floor typecheck (needs npm)
 *   pnpm lint:peer-floor --static   static rules only
 *
 * Raising a floor: edit the package's peer range to the version whose surface it now uses
 * (it must be published), and the next release ships the narrower range.
 *
 * Exit codes follow boundary-lint's: 0 = ok, 1 = a package breaks a rule, 2 = cannot run.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PEERS = ['@substrat-run/kernel', '@substrat-run/contracts'];
const HOMES = ['engines', 'connectors'];
const RANGE = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.0\.0$/;

/** `>=X.Y.Z <N.0.0` → its floor and ceiling, or null for any other shape. */
export function parseRange(range) {
  const m = RANGE.exec(range ?? '');
  if (!m) return null;
  return { floor: `${m[1]}.${m[2]}.${m[3]}`, floorParts: [+m[1], +m[2], +m[3]], ceilingMajor: +m[4] };
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** True when `version` (X.Y.Z, no prerelease) is inside the parsed range. */
export function inRange(version, parsed) {
  const v = version.split('.').map(Number);
  return compare(v, parsed.floorParts) >= 0 && v[0] < parsed.ceilingMajor;
}

/**
 * The static rules for one manifest. `versions` maps each peer name to its workspace version.
 * Returns problem strings; empty means it holds.
 */
export function staticProblems(manifest, versions) {
  const problems = [];
  for (const name of PEERS) {
    if (manifest.dependencies?.[name]) {
      problems.push(`${name} is a regular dependency — make it a peer (the vertical owns the one copy)`);
      continue;
    }
    const range = manifest.peerDependencies?.[name];
    if (!range) {
      problems.push(`${name} is not a peerDependency`);
      continue;
    }
    const parsed = parseRange(range);
    if (!parsed) {
      problems.push(`${name} peer range "${range}" is not of the shape \`>=X.Y.Z <N.0.0\``);
      continue;
    }
    if (!inRange(versions[name], parsed)) {
      problems.push(`${name} peer range "${range}" does not admit the workspace's ${versions[name]}`);
    }
    if (manifest.devDependencies?.[name] !== 'workspace:*') {
      problems.push(`${name} needs a \`workspace:*\` devDependency, so the monorepo builds against HEAD`);
    }
  }
  return problems;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The members this rule holds: every package under engines/ and connectors/ that names a peer anywhere. */
function members() {
  const out = [];
  for (const home of HOMES) {
    for (const dir of readdirSync(join(ROOT, home))) {
      const rel = `${home}/${dir}`;
      const file = join(ROOT, rel, 'package.json');
      if (!existsSync(file)) continue;
      const manifest = readJson(file);
      const all = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies };
      if (PEERS.some((p) => p in all)) out.push({ rel, manifest });
    }
  }
  return out;
}

/** The default catalog in pnpm-workspace.yaml, as name → range. Only flat `name: range` lines. */
function catalog() {
  const text = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const out = {};
  let inside = false;
  for (const line of text.split('\n')) {
    if (/^catalog:\s*$/.test(line)) { inside = true; continue; }
    if (inside && /^\S/.test(line)) break;
    const m = inside && /^  ('?)([^':\s]+)\1:\s*(\S+)\s*$/.exec(line);
    if (m) out[m[2]] = m[3].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function cannot(message) {
  console.error(`peer-floor: ${message}`);
  process.exit(2);
}

function main() {
  const staticOnly = process.argv.includes('--static');
  const versions = Object.fromEntries(
    PEERS.map((name) => [name, readJson(join(ROOT, 'packages', name.replace('@substrat-run/', ''), 'package.json')).version]),
  );

  const found = members();
  if (found.length === 0) cannot('found no package under engines/ or connectors/ — is this the repo root?');

  let failed = false;
  for (const { rel, manifest } of found) {
    const problems = staticProblems(manifest, versions);
    for (const p of problems) console.error(`  ✕ ${rel}: ${p}`);
    if (problems.length) failed = true;
  }
  if (failed) {
    console.error(`\npeer-floor: the rules above keep an engine's kernel range honest — tools/peer-floor.mjs says why.`);
    process.exit(1);
  }
  console.log(`peer-floor: ${found.length} packages declare kernel + contracts as peers, in range of the workspace.`);
  if (staticOnly) return;

  // ── Floor typecheck ──────────────────────────────────────────────────────
  const cat = catalog();
  const resolveSpec = (name, spec) => {
    if (spec === 'catalog:') {
      if (!cat[name]) cannot(`${name} is \`catalog:\` but pnpm-workspace.yaml's catalog has no entry for it`);
      return cat[name];
    }
    return spec;
  };

  const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
  if (!existsSync(tsc)) cannot('no node_modules/.bin/tsc — run `pnpm install` first.');

  /** Packages grouped by their floor pair, so one install serves every package sharing it. */
  const groups = new Map();
  for (const { rel, manifest } of found) {
    // The package's own compiler options, flattened, so the floor is judged as its build is.
    let shown;
    try {
      shown = JSON.parse(execFileSync(tsc, ['-p', join(ROOT, rel, 'tsconfig.json'), '--showConfig'], { encoding: 'utf8', stdio: 'pipe' }));
    } catch (e) {
      cannot(`cannot read ${rel}/tsconfig.json with \`tsc --showConfig\`: ${`${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message}`);
    }
    const floors = PEERS.map((name) => `${name}@${parseRange(manifest.peerDependencies[name]).floor}`);
    const key = floors.join(' ');
    if (!groups.has(key)) groups.set(key, { floors, deps: {}, packages: [] });
    const group = groups.get(key);
    group.packages.push({ rel, manifest, compilerOptions: shown.compilerOptions ?? {} });
    // A `types` entry is ambient, not imported, so the package carries it as a devDependency.
    for (const name of shown.compilerOptions?.types ?? []) {
      const spec = manifest.devDependencies?.[name];
      if (!spec) cannot(`${rel}'s tsconfig names types "${name}", which its package.json does not declare`);
      group.deps[name] ??= resolveSpec(name, spec);
    }
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        if (name.startsWith('@substrat-run/')) {
          if (PEERS.includes(name)) continue;
          cannot(`${rel} has a runtime dependency on ${name}; this tool installs only kernel + contracts from npm. Teach it the new edge.`);
        }
        // A regular dependency's range wins over a peer's: it is the narrower, installed one.
        if (field === 'dependencies' || !group.deps[name]) group.deps[name] = resolveSpec(name, spec);
      }
    }
  }

  const scratch = mkdtempSync(join(tmpdir(), 'peer-floor-'));
  const failures = [];
  try {
    for (const [key, group] of groups) {
      const dir = join(scratch, String([...groups.keys()].indexOf(key)));
      mkdirSync(dir, { recursive: true });
      const deps = { ...group.deps };
      for (const spec of group.floors) {
        const at = spec.lastIndexOf('@');
        deps[spec.slice(0, at)] = spec.slice(at + 1);
      }
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'peer-floor-scratch', private: true, type: 'module', dependencies: deps }, null, 2));
      console.log(`peer-floor: installing ${group.floors.join(', ')} for ${group.packages.length} package(s)…`);
      try {
        execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] });
      } catch {
        failures.push(`npm could not install ${group.floors.join(', ')} — a floor must be a published version (${group.packages.map((p) => p.rel).join(', ')})`);
        continue;
      }
      for (const { rel, manifest, compilerOptions: own } of group.packages) {
        const pkgDir = join(dir, 'pkgs', rel);
        mkdirSync(pkgDir, { recursive: true });
        cpSync(join(ROOT, rel, 'src'), join(pkgDir, 'src'), { recursive: true });
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: manifest.name, private: true, type: manifest.type ?? 'module' }));
        const compilerOptions = { ...own, noEmit: true, rootDir: 'src' };
        for (const k of ['outDir', 'declarationDir', 'tsBuildInfoFile', 'composite', 'incremental']) delete compilerOptions[k];
        writeFileSync(join(pkgDir, 'tsconfig.json'), JSON.stringify({ compilerOptions, include: ['src'] }, null, 2));
        try {
          execFileSync(tsc, ['-p', 'tsconfig.json', '--pretty', 'false'], { cwd: pkgDir, encoding: 'utf8', stdio: 'pipe' });
          console.log(`  ✓ ${rel} compiles against ${group.floors.join(', ')}`);
        } catch (e) {
          // tsc ran in the scratch copy, so its paths read `src/…`; point them at the repo.
          const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.replace(/^src\//gm, `${rel}/src/`).trim();
          failures.push(`${rel} does not compile against its floor (${group.floors.join(', ')}):\n${out.split('\n').map((l) => `      ${l}`).join('\n')}`);
        }
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (failures.length) {
    for (const f of failures) console.error(`  ✕ ${f}`);
    console.error(
      `\npeer-floor: a package uses kernel or contracts surface newer than the floor its peer range\n` +
        `  states, so a vertical that installed the floor cannot build it. Raise the floor in its\n` +
        `  peerDependencies to the first published version that has what it uses.`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
