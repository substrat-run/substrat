#!/usr/bin/env node
/**
 * Fail on a dependency cycle between workspace packages.
 *
 * pnpm orders `-r build` topologically, but a cycle has no topological order —
 * so it gives up and builds the members in PARALLEL. If one compiles against
 * the other's emitted `dist`, that is a race: it passes or fails depending on
 * which tsc finishes first.
 *
 * It is invisible locally, because `dist` from an earlier build is still on
 * disk and the racing tsc finds it. A clean CI checkout has no such luck. That
 * is exactly how it got here: extracting @substrat-run/model-emit left a
 * vestigial devDependency pointing back at contracts, seven green local checks
 * said nothing, and CI failed on the first clean build.
 *
 * Local dist is why `pnpm -r build` is not its own guard. This reads the
 * declared graph instead, so it gives the same answer on any machine.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const roots = ['packages', 'engines', 'connectors', 'demos', 'apps'];

/** name → { dir, deps: Set<workspace name> } */
const graph = new Map();

for (const bucket of roots) {
  const base = join(root, bucket);
  if (!existsSync(base)) continue;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    // apps/* and demos/* nest a package a level down (apps/builder/web).
    for (const dir of [join(base, entry.name), ...nested(join(base, entry.name))]) {
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (!pkg.name) continue;
      const deps = new Set(
        Object.entries({
          ...(pkg.dependencies ?? {}),
          ...(pkg.devDependencies ?? {}),
          ...(pkg.peerDependencies ?? {}),
        })
          .filter(([, spec]) => String(spec).startsWith('workspace:'))
          .map(([name]) => name),
      );
      graph.set(pkg.name, { dir: dir.slice(root.length + 1), deps });
    }
  }
}

function nested(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules' && e.name !== 'src')
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

// Depth-first, tracking the path so the error can print the actual cycle
// rather than just naming a package that is in one.
const state = new Map(); // name → 'visiting' | 'done'
const cycles = [];

function walk(name, path) {
  if (state.get(name) === 'done') return;
  if (state.get(name) === 'visiting') {
    cycles.push([...path.slice(path.indexOf(name)), name]);
    return;
  }
  state.set(name, 'visiting');
  for (const dep of graph.get(name)?.deps ?? []) {
    if (graph.has(dep)) walk(dep, [...path, name]);
  }
  state.set(name, 'done');
}

for (const name of graph.keys()) walk(name, []);

if (!graph.size) {
  console.error('workspace-cycles: found no workspace packages — run from the repo root');
  process.exit(2);
}

if (cycles.length) {
  // Two packages can appear in the same cycle by more than one path; report each shape once.
  const seen = new Set();
  for (const cycle of cycles) {
    const fingerprint = [...cycle].sort().join('|');
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    console.error(`\nworkspace dependency cycle:\n  ${cycle.join('\n    → ')}`);
  }
  console.error(
    `\npnpm cannot order a cycle, so it builds the members in parallel. If either one` +
      `\ncompiles against the other's dist, the build races — and passes locally only` +
      `\nbecause a previous dist is lying around.\n` +
      `\nUsually the fix is that one edge is vestigial: check whether anything actually` +
      `\nimports it before reaching for a restructure.\n`,
  );
  process.exit(1);
}

console.log(`workspace-cycles: ${graph.size} packages, no cycles`);
