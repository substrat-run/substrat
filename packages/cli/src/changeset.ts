import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  type Artifacts,
  type Bump,
  type Change,
  type Classification,
  classify,
  isBump,
  maxBump,
  rank,
} from './bump.js';

/**
 * `substrat changeset` — the filesystem and git half of the computed bump (#2364).
 *
 * `bump.ts` judges two sets of artifact texts. This reads them: the vertical's `model.json`,
 * `openapi.json` and `PERMISSIONS.md` at the merge-base of the base branch and HEAD, against
 * the working tree. Then it either WRITES a changeset carrying the computed bump, or CHECKS the
 * changesets already there and refuses one that declares less.
 *
 * The base is the merge-base, never the base branch's tip, so a branch behind `main` is not
 * charged with what `main` changed since. A base that is not in the checkout is a refusal
 * (`CannotRun`), never "no artifacts at base": read that way, every artifact would be new and
 * every bump minor, and a removal would hide behind it.
 */

export class CannotRun extends Error {}

/** The three files `bump.ts` reads, at a vertical's package root. */
export const ARTIFACT_FILES = { model: 'model.json', openapi: 'openapi.json', permissions: 'PERMISSIONS.md' } as const;

function git(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function gitRoot(cwd: string): string {
  const r = git(['rev-parse', '--show-toplevel'], cwd);
  if (r.status !== 0) throw new CannotRun(`${cwd} is not inside a git checkout — the bump is a diff against a base commit`);
  return r.stdout.trim();
}

/** The merge-base of `ref` and HEAD, or a refusal that says why it is missing. */
export function baseCommit(ref: string, cwd: string): string {
  const resolved = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
  if (resolved.status !== 0) {
    const shallow = git(['rev-parse', '--is-shallow-repository'], cwd).stdout.trim() === 'true';
    throw new CannotRun(
      `the base '${ref}' is not in this checkout` +
        (shallow ? ' (a shallow clone: fetch it, or check out with full history)' : ' (fetch it first)') +
        ' — without it every artifact would read as new, and a removal would pass as an addition',
    );
  }
  const mb = git(['merge-base', resolved.stdout.trim(), 'HEAD'], cwd);
  if (mb.status !== 0) throw new CannotRun(`no merge-base between '${ref}' and HEAD in this checkout`);
  return mb.stdout.trim();
}

/** A file at a commit: its text, or `null` when the commit genuinely has no such file. */
export function atCommit(commit: string, path: string, cwd: string): string | null {
  // `ls-tree` answers "absent" with empty output and exit 0. Any error is a refusal upstream,
  // never an absence: an absence here reads as "added", which is the silent pass to avoid.
  const listed = git(['ls-tree', '--name-only', commit, '--', path], cwd);
  if (listed.status !== 0) throw new CannotRun(`cannot list ${path} at ${commit}: ${listed.stderr.trim()}`);
  if (listed.stdout.trim() === '') return null;
  const shown = git(['show', `${commit}:${path}`], cwd);
  if (shown.status !== 0) throw new CannotRun(`cannot read ${path} at ${commit}: ${shown.stderr.trim()}`);
  return shown.stdout;
}

/**
 * The repo-relative path git wants, with forward slashes. Both sides are REAL paths: git reports
 * its top level through symlinks resolved (macOS's /var is /private/var), and a path relative to
 * the unresolved one climbs out of the repository.
 */
const repoPath = (root: string, abs: string): string =>
  relative(realpathSync(root), realpathSync(abs)).split(sep).join('/');

/** One vertical's artifacts at the base commit and in the working tree. */
export function readArtifacts(pkgDir: string, commit: string, root: string): { base: Artifacts; head: Artifacts } {
  const read = (file: string) => (existsSync(join(pkgDir, file)) ? readFileSync(join(pkgDir, file), 'utf8') : null);
  const at = (file: string) => atCommit(commit, `${repoPath(root, pkgDir)}/${file}`.replace(/^\//, ''), root);
  return {
    base: { model: at(ARTIFACT_FILES.model), openapi: at(ARTIFACT_FILES.openapi), permissions: at(ARTIFACT_FILES.permissions) },
    head: { model: read(ARTIFACT_FILES.model), openapi: read(ARTIFACT_FILES.openapi), permissions: read(ARTIFACT_FILES.permissions) },
  };
}

export function packageNameOf(pkgDir: string): string {
  const file = join(pkgDir, 'package.json');
  if (!existsSync(file)) throw new CannotRun(`${pkgDir} has no package.json — a changeset names a package`);
  const name = (JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown }).name;
  if (typeof name !== 'string' || name === '') throw new CannotRun(`${file} declares no name`);
  return name;
}

/** The `.changeset` directory serving `pkgDir`: the nearest one at or above it, up to the repo root. */
export function changesetDirFor(pkgDir: string, root: string): string {
  const top = realpathSync(root);
  for (let dir = realpathSync(pkgDir); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.changeset', 'config.json'))) return join(dir, '.changeset');
    if (dir === top || dirname(dir) === dir) break;
  }
  throw new CannotRun(`no .changeset/config.json at or above ${pkgDir} — this project does not release with changesets (run \`changeset init\`)`);
}

interface ChangesetConfig {
  readonly baseBranch: string;
  /** Every package in a `fixed` group. Their surface is more than a model; they keep hand-written changesets. */
  readonly fixed: ReadonlySet<string>;
}

function readChangesetConfig(changesetDir: string): ChangesetConfig {
  const raw = JSON.parse(readFileSync(join(changesetDir, 'config.json'), 'utf8')) as { baseBranch?: unknown; fixed?: unknown };
  const fixed = new Set<string>();
  for (const group of Array.isArray(raw.fixed) ? raw.fixed : []) {
    for (const name of Array.isArray(group) ? group : []) if (typeof name === 'string') fixed.add(name);
  }
  return { baseBranch: typeof raw.baseBranch === 'string' ? raw.baseBranch : 'main', fixed };
}

// ─── changeset files ──────────────────────────────────────────────────────────────────────────

/**
 * A reviewed exception to the computed bump, written in the changeset as an HTML comment so it
 * stays out of the rendered CHANGELOG:
 *
 *     <!-- bump-override: @scope/pkg minor — why the computed major is wrong here -->
 *
 * The package is named because a changeset can name several, and an override must never reach
 * one it does not name. The level must be the one this changeset declares for that package, and
 * the reason must be there: an override is a claim a reviewer reads, and one with no reason is
 * nothing to read.
 */
export interface Override {
  readonly pkg: string;
  readonly level: Bump;
  readonly reason: string;
}

export interface Changeset {
  readonly file: string;
  readonly releases: ReadonlyMap<string, Bump>;
  readonly overrides: readonly Override[];
  /** Malformed override lines, and other reasons this file cannot be trusted. Each fails the check. */
  readonly problems: readonly string[];
}

const OVERRIDE = /^<!--\s*bump-override:\s*(\S+)\s+(none|patch|minor|major)\s+(?:—|--)\s*(.*?)\s*-->$/;

export function parseChangeset(file: string, text: string): Changeset {
  const problems: string[] = [];
  const releases = new Map<string, Bump>();
  const overrides: Override[] = [];
  // Fence by fence, line by line: an EMPTY frontmatter (`---\n---`, what `changeset --empty`
  // writes) is a valid changeset that releases nothing, and must not read as a broken one.
  const lines = text.split(/\r?\n/);
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (lines[0]?.trim() !== '---' || close === -1) {
    return { file, releases, overrides, problems: [`${file}: no frontmatter — not a changeset`] };
  }
  const front = lines.slice(1, close);
  const body = lines.slice(close + 1);
  for (const line of front) {
    if (line.trim() === '') continue;
    const r = /^\s*(["']?)(.+?)\1\s*:\s*(\S+)\s*$/.exec(line);
    if (!r || !isBump(r[3]!)) {
      problems.push(`${file}: cannot read the release line '${line.trim()}'`);
      continue;
    }
    releases.set(r[2]!, r[3]! as Bump);
  }
  for (const line of body) {
    if (!line.includes('bump-override')) continue;
    const o = OVERRIDE.exec(line.trim());
    if (!o) {
      problems.push(
        `${file}: malformed override '${line.trim()}' — write \`<!-- bump-override: <package> <level> — <reason> -->\``,
      );
      continue;
    }
    const [, pkg, level, reason] = o as unknown as [string, string, Bump, string];
    if (reason === '') problems.push(`${file}: the override for ${pkg} gives no reason — a reviewer has nothing to read`);
    else if (!releases.has(pkg)) problems.push(`${file}: the override names ${pkg}, which this changeset does not release`);
    else if (releases.get(pkg) !== level) {
      problems.push(`${file}: the override for ${pkg} says ${level}, but this changeset declares ${releases.get(pkg)}`);
    } else overrides.push({ pkg, level, reason });
  }
  return { file, releases, overrides, problems };
}

/** Every changeset in the directory (README.md and config.json are not changesets). */
function readChangesets(changesetDir: string): Changeset[] {
  return readdirSync(changesetDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .sort()
    .map((f) => parseChangeset(join(changesetDir, f), readFileSync(join(changesetDir, f), 'utf8')));
}

const MAX_LISTED = 25;

/** The changeset text for one package: the computed bump, and the changes it was computed from. */
export function renderChangeset(pkg: string, result: Classification, summary?: string): string {
  if (result.bump === 'none') throw new Error('nothing changed — there is no bump to write');
  const lines = result.changes
    .filter((c) => c.level !== 'patch' || result.bump === 'patch')
    .map((c) => `- ${c.flagged ? '**Review:** ' : ''}\`${c.path}\` (${c.artifact}): ${c.detail} — ${c.level}`);
  const listed = lines.slice(0, MAX_LISTED);
  if (lines.length > MAX_LISTED) listed.push(`- … and ${lines.length - MAX_LISTED} more`);
  const headline = summary?.trim() || `Surface change, computed as ${result.bump} from the model, API and permission artifacts.`;
  return `---\n'${pkg}': ${result.bump}\n---\n\n${headline}\n\n${listed.join('\n')}\n`;
}

// ─── the check ────────────────────────────────────────────────────────────────────────────────

export interface Verdict {
  readonly pkg: string;
  readonly computed: Classification;
  /** The highest bump any changeset declares for the package; `none` when none names it. */
  readonly declared: Bump;
  readonly named: boolean;
  readonly status: 'ok' | 'under-declared' | 'overridden' | 'missing' | 'skipped-fixed';
  readonly overrides: readonly Override[];
}

/**
 * The verdict for one package against every changeset present. Changesets combine: a release
 * bumps a package by the highest level any pending changeset names, so that maximum is what is
 * compared, wherever it was written.
 *
 * - declared ≥ computed → ok.
 * - declared < computed, and a changeset naming the package carries a well-formed override →
 *   overridden (printed, with its reason).
 * - declared < computed, a changeset names the package → under-declared, the failure.
 * - no changeset names it at all → missing: a warning carrying the computed bump, not a failure.
 *   In this repo most artifact changes to a demo come from a platform-wide regeneration that
 *   releases the platform, not the demo.
 * - a package in a `fixed` group → skipped: its surface is more than its model (#760).
 */
export function verdictFor(pkg: string, computed: Classification, changesets: readonly Changeset[], fixed: ReadonlySet<string>): Verdict {
  const naming = changesets.filter((c) => c.releases.has(pkg));
  const declared = naming.reduce<Bump>((acc, c) => maxBump(acc, c.releases.get(pkg)!), 'none');
  const overrides = naming.flatMap((c) => c.overrides.filter((o) => o.pkg === pkg));
  const base = { pkg, computed, declared, named: naming.length > 0, overrides };
  if (fixed.has(pkg)) return { ...base, status: 'skipped-fixed' };
  if (rank(declared) >= rank(computed.bump)) return { ...base, status: 'ok' };
  if (naming.length === 0) return { ...base, status: 'missing' };
  if (overrides.length > 0) return { ...base, status: 'overridden' };
  return { ...base, status: 'under-declared' };
}

/** Classify one vertical against the merge-base of `ref`. */
export function computeFor(pkgDir: string, ref: string): { pkg: string; result: Classification; root: string } {
  const root = gitRoot(pkgDir);
  const commit = baseCommit(ref, root);
  const { base, head } = readArtifacts(resolve(pkgDir), commit, root);
  return { pkg: packageNameOf(pkgDir), result: classify(base, head), root };
}

/** The base ref to diff against when none is given: the changesets base branch, as fetched. */
export function defaultBase(changesetDir: string, root: string): string {
  const { baseBranch } = readChangesetConfig(changesetDir);
  const remote = `origin/${baseBranch}`;
  return git(['rev-parse', '--verify', '--quiet', `${remote}^{commit}`], root).status === 0 ? remote : baseBranch;
}

const ghaEscape = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** A warning line: a GitHub annotation in CI, plain text elsewhere. */
function warn(message: string): string {
  return process.env.GITHUB_ACTIONS ? `::warning::${ghaEscape(message)}` : `warning: ${message}`;
}

/** The report lines for one verdict, and whether it fails the check. */
export function report(v: Verdict): { lines: string[]; failed: boolean } {
  const lines: string[] = [];
  const top = (cs: readonly Change[]) => cs.filter((c) => c.level === v.computed.bump).slice(0, 5);
  const reasons = top(v.computed.changes).map((c) => `    ${c.path} (${c.artifact}): ${c.detail}`);
  switch (v.status) {
    case 'skipped-fixed':
      lines.push(`${v.pkg}: in a fixed group — its changeset is written by hand (#760), not computed`);
      break;
    case 'ok':
      lines.push(`${v.pkg}: computed ${v.computed.bump}, declared ${v.declared} — ok`);
      break;
    case 'missing':
      lines.push(
        warn(
          `${v.pkg}: its artifacts changed, computed bump ${v.computed.bump}, and no changeset names it. ` +
            `If this change releases it, run \`substrat changeset\` in its directory (or write '${v.pkg}': ${v.computed.bump}).`,
        ),
        ...reasons,
      );
      break;
    case 'overridden':
      lines.push(`${v.pkg}: computed ${v.computed.bump}, declared ${v.declared} — OVERRIDDEN by a reviewed changeset line:`);
      for (const o of v.overrides) lines.push(`    bump-override ${o.level}: ${o.reason}`);
      lines.push(...reasons);
      break;
    case 'under-declared':
      lines.push(
        `${v.pkg}: a changeset declares ${v.declared}, but the change is ${v.computed.bump}:`,
        ...reasons,
        `  Declare '${v.pkg}': ${v.computed.bump}, or — when the classifier is wrong here — add\n` +
          `  <!-- bump-override: ${v.pkg} ${v.declared} — <why> --> to the changeset, for a reviewer to read.`,
      );
      break;
  }
  for (const c of v.computed.changes.filter((c) => c.flagged)) {
    lines.push(warn(`${v.pkg}: human checkpoint — ${c.path}: ${c.detail}`));
  }
  return { lines, failed: v.status === 'under-declared' };
}

/**
 * The whole check, for every classified package against every changeset in `changesetDir`. A
 * changeset that cannot be read — a malformed override above all — fails it, whichever package it
 * names: an override that silently did not parse would leave the reviewer reading a claim the gate
 * never saw.
 */
export function checkPackages(
  entries: readonly { pkg: string; result: Classification }[],
  changesetDir: string,
): { lines: string[]; failed: boolean; verdicts: Verdict[] } {
  const changesets = readChangesets(changesetDir);
  const { fixed } = readChangesetConfig(changesetDir);
  const lines: string[] = [];
  let failed = false;
  for (const c of changesets) {
    for (const p of c.problems) {
      lines.push(`changeset: ${p}`);
      failed = true;
    }
  }
  const verdicts = entries.map((e) => verdictFor(e.pkg, e.result, changesets, fixed));
  for (const v of verdicts) {
    const r = report(v);
    lines.push(...r.lines);
    if (r.failed) failed = true;
  }
  return { lines, failed, verdicts };
}

/** Where `substrat changeset` writes: a name that will not collide, readable in a PR's file list. */
function changesetFileName(pkg: string, bump: Bump): string {
  const slug = basename(pkg).replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  const id = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${slug}-${bump}-${id}.md`;
}

export function writeChangeset(changesetDir: string, pkg: string, result: Classification, summary?: string): string {
  const file = join(changesetDir, changesetFileName(pkg, result.bump));
  writeFileSync(file, renderChangeset(pkg, result, summary));
  return file;
}
