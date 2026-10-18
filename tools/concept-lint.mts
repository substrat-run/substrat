/**
 * `spec/concept.md` kept true to the code (#2362).
 *
 * A concept document is split by owner: three regions between `<!-- substrat:… -->` markers
 * are GENERATED from the artifacts of record (`PERMISSIONS.md`, `model.json`), and the rest is
 * authored. `substrat concept sync` rewrites the regions; this is the gate that says no:
 *
 *   1. **Stale** — re-render the regions from the checked-in `model.json` and `PERMISSIONS.md`
 *      and compare with the file. Differs → red; the remedy is `substrat concept sync`.
 *   2. **Decisions log** (with `--base <ref>`) — `model.json` or `PERMISSIONS.md` changed since
 *      the base but the document's Decisions log section did not. The model or a permission
 *      moved, and nobody wrote down why. Same shape as `lint:export-schemas`.
 *
 * A vertical that has a `model.json` must carry a concept document with the markers; one that
 * has the file without them is red, not skipped, so "migrated" cannot silently mean "ignored".
 * A concept document with markers but no `model.json` beside it cannot be rendered: exit 2.
 *
 * The rendering is `@substrat-run/model-view`'s `syncConcept`, imported by path like the other
 * tools import the pure core of what they inspect — the gate and `substrat concept sync` are
 * one function, so they cannot disagree.
 *
 * Usage: tsx tools/concept-lint.mts [--check] [--base <ref>] [--root <checkout>]
 * Exit 0 = fine, 1 = stale or undocumented change, 2 = the tool could not do its job.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConceptMarkerError, decisionsLog, syncConcept } from '../packages/model-view/src/concept.js';
import { atBase, baseCommit } from './export-schema-diff.mts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface Offence {
  readonly dir: string;
  readonly rule: 'stale' | 'no-markers' | 'no-decisions-log' | 'undocumented-change';
  readonly detail: string;
}

/** Every directory with a tracked `spec/concept.md`, outside scratch projects and the scaffold. */
export function conceptDirs(cwd: string): string[] {
  const files = execFileSync('git', ['ls-files', '--', '*spec/concept.md'], { cwd, encoding: 'utf8' }).split('\n');
  return files
    .filter((f) => f.endsWith('/spec/concept.md') && !f.startsWith('.builder/') && !f.includes('node_modules/'))
    .map((f) => f.slice(0, -'/spec/concept.md'.length))
    .sort();
}

const read = (p: string): string | undefined => (existsSync(p) ? readFileSync(p, 'utf8') : undefined);

/** The stale and structure half: no git, only the files beside each other. */
export function lintVertical(root: string, dir: string): Offence[] {
  const concept = read(join(root, dir, 'spec/concept.md'));
  if (concept === undefined) return [];
  const model = read(join(root, dir, 'model.json'));
  if (model === undefined) {
    // Prose-only design documents (the platform apps have no model) are not this gate's business.
    return [];
  }
  const out: Offence[] = [];
  if (!concept.includes('<!-- substrat:')) {
    return [{ dir, rule: 'no-markers', detail: 'spec/concept.md has none of the <!-- substrat:roles|entities|processes --> markers; add them and run `substrat concept sync`' }];
  }
  let fresh: string;
  try {
    const permissionsMd = read(join(root, dir, 'PERMISSIONS.md'));
    fresh = syncConcept(concept, {
      model: JSON.parse(model),
      ...(permissionsMd === undefined ? {} : { permissionsMd }),
    });
  } catch (err) {
    if (err instanceof ConceptMarkerError) return [{ dir, rule: 'no-markers', detail: err.message }];
    throw err;
  }
  if (fresh !== concept) {
    out.push({ dir, rule: 'stale', detail: 'a generated section of spec/concept.md is out of date — run `substrat concept sync`' });
  }
  if (decisionsLog(concept) === undefined) {
    out.push({ dir, rule: 'no-decisions-log', detail: 'spec/concept.md has no "Decisions log" section (a `##` heading) to record model and permission changes in' });
  }
  return out;
}

/** The base half: the model or the permissions moved, so the decisions log must have too. */
export function lintAgainstBase(root: string, dir: string, commit: string): Offence[] {
  const baseConcept = atBase(commit, `${dir}/spec/concept.md`, root);
  const baseLog = baseConcept === null ? undefined : decisionsLog(baseConcept);
  // A document the base did not have, or had no log in, is being introduced: nothing to compare.
  if (baseLog === undefined) return [];
  const nowLog = decisionsLog(read(join(root, dir, 'spec/concept.md')) ?? '');
  if (nowLog !== undefined && nowLog !== baseLog) return [];
  const moved = ['model.json', 'PERMISSIONS.md'].filter((f) => atBase(commit, `${dir}/${f}`, root) !== (read(join(root, dir, f)) ?? null));
  if (moved.length === 0) return [];
  return [{ dir, rule: 'undocumented-change', detail: `${moved.join(' and ')} changed against the base, but the Decisions log in spec/concept.md did not — add an entry saying what changed and why` }];
}

export function run(root: string, base?: string): Offence[] {
  const dirs = conceptDirs(root);
  const out = dirs.flatMap((d) => lintVertical(root, d));
  if (base !== undefined) {
    const commit = baseCommit(base, root);
    for (const d of dirs) out.push(...lintAgainstBase(root, d, commit));
  }
  return out;
}

function isMain(): boolean {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(resolve(arg));
  } catch {
    return false;
  }
}

if (isMain()) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const root = arg('--root') ?? ROOT;
    const checked = conceptDirs(root).filter((d) => existsSync(join(root, d, 'model.json')));
    if (checked.length === 0) {
      console.error('concept-lint: no spec/concept.md beside a model.json — nothing was checked');
      process.exit(2);
    }
    const found = run(root, arg('--base'));
    if (found.length === 0) {
      console.log(`concept-lint: ${checked.length} concept document(s) are current${arg('--base') ? ` and documented against ${arg('--base')}` : ''}`);
      process.exit(0);
    }
    for (const o of found) console.error(`${o.dir}/spec/concept.md: ${o.rule} — ${o.detail}`);
    console.error(`\nconcept-lint: ${found.length} problem(s).`);
    process.exit(1);
  } catch (err) {
    console.error(`concept-lint: cannot run — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
