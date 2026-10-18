#!/usr/bin/env tsx
/**
 * The computed changeset bump, held in CI (#2364).
 *
 * For every vertical in `demos/`, classify the diff of its `model.json`, `openapi.json` and
 * `PERMISSIONS.md` against the merge-base, then hold the changesets in `.changeset/` to it:
 * a changeset that names the vertical and declares LESS than the computed bump is red. The
 * classifier and the check are `@substrat-run/cli`'s own (`substrat changeset --check` runs the
 * same code in a builder's repo), imported by path like `model-diff` imports contracts, so this
 * tool never needs the build.
 *
 *   - A vertical whose artifacts changed and that no changeset names is a WARNING carrying the
 *     computed bump, not a failure: most demo artifact changes here come from a platform-wide
 *     regeneration that releases the platform, not the demo.
 *   - A reviewed exception is an override line in the changeset itself
 *     (`<!-- bump-override: <package> <level> — <reason> -->`), printed here. A malformed one,
 *     or one without a reason, is red.
 *   - A permission change is flagged for the human checkpoint either way.
 *   - Engines are not swept: their surface is their TypeScript exports, which no artifact
 *     carries, and the kernel packages in the `fixed` group keep hand-written changesets (#760).
 *
 * Usage: tsx tools/changeset-bump.mts --base <ref>
 *
 * Exit 0: no under-declared bump. 1: at least one (each printed). 2: could not run — a base not
 * in the checkout is that, never "every artifact is new".
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from '../packages/cli/src/bump.js';
import { ARTIFACT_FILES, atCommit, baseCommit, CannotRun, checkPackages, packageNameOf, readArtifacts } from '../packages/cli/src/changeset.js';
import { repoRoot } from './repo-path.mjs';

const ROOT = repoRoot(import.meta.url);
const DEMOS = 'demos';

const i = process.argv.indexOf('--base');
const ref = i >= 0 ? process.argv[i + 1] : undefined;
if (!ref || ref.startsWith('--')) {
  console.error('changeset-bump: --base <ref> is required (the branch this change merges into)');
  process.exit(2);
}

try {
  const commit = baseCommit(ref, ROOT);
  const entries: { pkg: string; result: ReturnType<typeof classify> }[] = [];
  for (const name of readdirSync(join(ROOT, DEMOS)).sort()) {
    const dir = join(ROOT, DEMOS, name);
    // A vertical removed in this change releases nothing; there is no package left to version.
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'package.json'))) continue;
    const files = Object.values(ARTIFACT_FILES);
    const held = files.some((f) => existsSync(join(dir, f)) || atCommit(commit, `${DEMOS}/${name}/${f}`, ROOT) !== null);
    if (!held) continue;
    const { base, head } = readArtifacts(dir, commit, ROOT);
    entries.push({ pkg: packageNameOf(dir), result: classify(base, head) });
  }
  if (entries.length === 0) {
    // A sweep that read nothing must never print green.
    throw new CannotRun(`no vertical under ${DEMOS}/ carries ${Object.values(ARTIFACT_FILES).join(', ')}`);
  }
  const { lines, failed } = checkPackages(entries, join(ROOT, '.changeset'));
  for (const l of lines) (failed ? console.error : console.log)(l);
  const changed = entries.filter((e) => e.result.bump !== 'none').length;
  if (failed) {
    console.error(`\nchangeset-bump: a changeset declares less than the change it releases (against ${ref}).`);
    process.exit(1);
  }
  console.log(`changeset-bump: ${entries.length} vertical(s) read, ${changed} changed against ${ref}, no bump under-declared`);
} catch (err) {
  console.error(`changeset-bump: cannot run — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
