#!/usr/bin/env node
// Whether a PR changes anything a deployed vertical's preview would be built from — the
// first job of meridian-deploy.yml and substrat-deploy.yml, which skip `preview` when it
// says no.
//
// Every preview and deploy shares ONE concurrency group (`substrat-platform-build`): the
// hosted builder serves one build per tenant and answers 409 to a second. A preview of a PR
// that changed nothing the vertical uploads is a slot in that queue for no information, and
// on a busy day the queue was forty minutes long.
//
// The closure is the one `substrat push` uploads (packages/cli/src/source-snapshot.ts,
// `collectSourceSnapshot`), read off pnpm's workspace graph rather than a list of paths, so a
// new dependency is covered the day it is declared:
//
//   - the vertical's directory, whole, and every workspace member nested under it;
//   - every member those reach over dependencies, devDependencies, peer and optional
//     dependencies, transitively — minus each dependency's `test/` and `CHANGELOG.md`, which
//     the CLI does not upload;
//   - every root file, and all of `tools/` and `scripts/` (uploaded wholesale: the vertical's
//     vitest configs and the CLI both read files there).
//
// On top of that, four changes inside the closure are judged by what they change rather than
// where they are, because each is common and none alters a build:
//
//   - `pnpm-lock.yaml`: read with ci-scope's `lockfileScope`. It runs when an importer inside
//     the closure resolves differently, and whenever the change cannot be pinned to importers.
//   - a member's `package.json` whose only change is `version` (the changesets release PR).
//   - the root `package.json` when only `scripts` entries changed, none of them an install
//     lifecycle hook and none named by a closure member's own scripts.
//   - a `CHANGELOG.md`, and a root `*.md` or LICENSE: documentation no build reads.
//
// Plus the workflow file itself, which runs the preview. Anything this cannot read runs the
// preview and says why: a gate that skips work must never guess.
//
// The workflows keep their hand-written `pull_request` `paths:` filters as the outer bound, and
// this only narrows them: the full closure would roughly double the platform build queue
// (#3253). The changes those filters never let through (the kernel, contracts, cli) are #3254.
//
//   node tools/preview-scope.mjs --vertical demos/meridian --workflow .github/workflows/meridian-deploy.yml
//   node tools/preview-scope.mjs … --base <ref> --head <ref>   # a dry run between two commits
//
// On a pull_request the base is HEAD^1 of GitHub's merge commit, as in ci-scope.mjs. Writes
// `run=true|false` to $GITHUB_OUTPUT and the verdict to $GITHUB_STEP_SUMMARY when set.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHANGED_NAMES, LOCKFILE, lockfileScope } from './ci-scope.mjs';

// ── The closure ─────────────────────────────────────────────────────────────

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * The workspace directories (repo-relative, no trailing slash) a push of `vertical` uploads:
 * the CLI's selection. `members` is [{ name, dir }]; `manifestOf(dir)` returns the parsed
 * package.json.
 */
export function closureDirs(vertical, members, manifestOf) {
  const byName = new Map(members.filter((m) => m.name).map((m) => [m.name, m.dir]));
  const selected = new Set(members.filter((m) => m.dir === vertical || m.dir.startsWith(`${vertical}/`)).map((m) => m.dir));
  selected.add(vertical);
  const queue = [...selected];
  for (const dir of queue) {
    const pkg = manifestOf(dir);
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        const dep = byName.get(name);
        if (dep !== undefined && !selected.has(dep)) {
          selected.add(dep);
          queue.push(dep);
        }
      }
    }
  }
  return [...selected].sort();
}

/**
 * Whether the CLI's snapshot of `vertical` would carry `path` at all, before any of the
 * judgements below. Mirrors `collectSourceSnapshot`'s filter, except its credential and
 * build-output exclusions, which only ever drop a file: over-including is the safe side.
 */
export function inUpload(path, vertical, dirs) {
  if (!path.includes('/') || path.startsWith('tools/') || path.startsWith('scripts/')) return true;
  if (path.startsWith(`${vertical}/`)) return true;
  const dir = owningDir(path, dirs);
  if (dir === undefined) return false;
  return !/^(?:test\/|CHANGELOG\.md$)/.test(path.slice(dir.length + 1));
}

function owningDir(path, dirs) {
  let best;
  for (const d of dirs) if (path.startsWith(`${d}/`) && (best === undefined || d.length > best.length)) best = d;
  return best;
}

// ── Judging one change ──────────────────────────────────────────────────────

// Scripts pnpm runs by itself during `pnpm install` (and around publish/pack, for good measure).
export const LIFECYCLE = /^(?:pre|post)?(?:install|prepare|publish|prepublishOnly|pack|dependencies)$|^pnpm:/;

const parseJson = (text) => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const without = (obj, key) => {
  const { [key]: _, ...rest } = obj;
  return JSON.stringify(rest);
};

/** null when only `version` changed; otherwise why the manifest change counts. */
export function memberManifestChange(baseText, headText) {
  const a = parseJson(baseText);
  const b = parseJson(headText);
  if (a === undefined || b === undefined) return 'package.json added, removed or unreadable';
  return without(a, 'version') === without(b, 'version') ? null : 'package.json changed beyond its version';
}

/**
 * null when the root manifest changed only in scripts no install runs and no closure member
 * calls; otherwise why it counts. `memberScripts` is every closure member's scripts, joined.
 */
export function rootManifestChange(baseText, headText, memberScripts) {
  const a = parseJson(baseText);
  const b = parseJson(headText);
  if (a === undefined || b === undefined) return 'root package.json added, removed or unreadable';
  if (without(a, 'scripts') !== without(b, 'scripts')) return 'root package.json changed outside its scripts';
  const sa = a.scripts ?? {};
  const sb = b.scripts ?? {};
  const changed = [...new Set([...Object.keys(sa), ...Object.keys(sb)])].filter((k) => sa[k] !== sb[k]).sort();
  const hook = changed.find((k) => LIFECYCLE.test(k));
  if (hook !== undefined) return `root package.json changed the \`${hook}\` script, which install runs`;
  const called = changed.find((k) => memberScripts.includes(k));
  if (called !== undefined) return `root package.json changed the \`${called}\` script, which a closure member's scripts name`;
  return null;
}

/**
 * The verdict for one PR. Pure: everything it reads from git or pnpm is passed in.
 *
 *   files        changed paths (`git diff --name-only --no-renames base head`)
 *   vertical     the vertical's directory, e.g. `demos/meridian`
 *   workflow     the workflow file that runs the preview
 *   dirs         closureDirs(…) at head
 *   show(path)   { base, head } file texts (undefined where absent)
 *   lockfile()   lockfileScope(base, head) — called only when the lockfile changed
 *   memberScripts  closure members' scripts, joined into one string
 *
 * Returns { run, reason, counted: [{ path, why }], ignored: [{ path, why }] }.
 */
export function decidePreview({ files, vertical, workflow, dirs, show, lockfile, memberScripts }) {
  const counted = [];
  const ignored = [];
  for (const path of files) {
    const why = judge(path);
    (why.counts ? counted : ignored).push({ path, why: why.why });
  }
  const name = vertical.split('/').pop();
  if (counted.length > 0) {
    return { run: true, reason: `${counted[0].path}: ${counted[0].why}`, counted, ignored };
  }
  return { run: false, reason: `no change to ${name}'s upload closure`, counted, ignored };

  function judge(path) {
    if (path === workflow) return { counts: true, why: 'the workflow that runs this preview' };
    if (path === LOCKFILE) {
      const scope = lockfile();
      if (scope.everything) return { counts: true, why: scope.everything };
      const inside = scope.importers.filter((i) => dirs.includes(i));
      return inside.length > 0
        ? { counts: true, why: `resolves differently for ${inside.join(', ')}` }
        : { counts: false, why: `resolves differently only for ${scope.importers.join(', ') || 'no importer'}` };
    }
    if (!inUpload(path, vertical, dirs)) return { counts: false, why: 'outside the upload closure' };
    const base = path.split('/').pop();
    if (!path.includes('/')) {
      if (/\.md$/i.test(path) || /^LICEN[CS]E/i.test(path)) return { counts: false, why: 'root documentation' };
      if (path === 'package.json') {
        const { base: a, head: b } = show(path);
        const why = rootManifestChange(a, b, memberScripts);
        return why === null ? { counts: false, why: 'root scripts no install or closure member runs' } : { counts: true, why };
      }
      return { counts: true, why: 'a root file, uploaded with every vertical' };
    }
    if (path.startsWith('tools/') || path.startsWith('scripts/')) {
      return { counts: true, why: `${path.split('/')[0]}/ is uploaded whole` };
    }
    if (base === 'CHANGELOG.md') return { counts: false, why: 'a changelog' };
    if (base === 'package.json' && dirs.includes(path.slice(0, -'/package.json'.length))) {
      const { base: a, head: b } = show(path);
      const why = memberManifestChange(a, b);
      return why === null ? { counts: false, why: 'only its version changed' } : { counts: true, why };
    }
    return { counts: true, why: `in ${owningDir(path, dirs) ?? vertical}` };
  }
}

/** The job summary: the verdict, then every file and why it did or did not count. */
export function summary(verdict, vertical) {
  const name = vertical.split('/').pop();
  const lines = verdict.run
    ? [`### ${name} preview: runs`, '', `This PR changes ${name}'s upload closure — \`${verdict.reason.replace(/`/g, '')}\`.`]
    : [
        `### ${name} preview: skipped — ${verdict.reason}`,
        '',
        `Not a failure. Nothing this PR changes is in what \`substrat push ${vertical}\` uploads, so a preview`,
        'would rebuild the same vertical and hold the platform build queue while it did. The judge is',
        '`tools/preview-scope.mjs`.',
      ];
  const list = (title, rows) => {
    if (rows.length === 0) return;
    lines.push('', `<details><summary>${title} (${rows.length})</summary>`, '');
    for (const r of rows.slice(0, 200)) lines.push(`- \`${r.path}\` — ${r.why}`);
    if (rows.length > 200) lines.push(`- … and ${rows.length - 200} more`);
    lines.push('', '</details>');
  };
  list('Changes that count', verdict.counted);
  list('Changes that do not', verdict.ignored);
  return `${lines.join('\n')}\n`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/**
 * The paths changed between two commits, exactly as the tree spells them. NUL-delimited: with the
 * default `core.quotePath`, a newline-delimited list C-quotes a path holding a non-ASCII byte or a
 * double quote (`"demos/x/caf\303\251.svg"`), which then matches no closure directory and would
 * skip a preview the change needed. `--no-renames` names a move at both ends, as in ci-scope.
 */
export function changedFiles(base, head, cwd = process.cwd()) {
  const out = execFileSync('git', [...CHANGED_NAMES, '-z', base, head], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}
const showAt = (ref, path) => {
  try {
    return git('show', `${ref}:${path}`);
  } catch {
    return undefined;
  }
};

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const vertical = arg('--vertical');
  const workflow = arg('--workflow');
  if (!vertical || !workflow) throw new Error('usage: preview-scope.mjs --vertical <dir> --workflow <file> [--base <ref>] [--head <ref>]');
  const head = arg('--head') ?? 'HEAD';
  let base = arg('--base');
  if (base === undefined) {
    const parents = git('rev-list', '--parents', '-n', '1', head).trim().split(' ');
    base = parents.length === 3 ? parents[1] : undefined;
  }

  let verdict;
  if (base === undefined) {
    verdict = { run: true, reason: `${head} is not a merge commit and no --base was given, so there is nothing to diff`, counted: [], ignored: [] };
  } else {
    const root = process.cwd();
    // The graph at head: a dependency the PR adds changes a closure member's package.json,
    // which counts on its own, so the base graph has nothing to add.
    const listed = JSON.parse(execFileSync('pnpm', ['-r', 'list', '--depth', '-1', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    const members = listed
      .map((m) => ({ name: m.name, dir: relative(root, resolve(m.path)).split('\\').join('/') }))
      .filter((m) => m.dir !== '');
    const manifestOf = (dir) => JSON.parse(head === 'HEAD' ? readFileSync(join(root, dir, 'package.json'), 'utf8') : (showAt(head, `${dir}/package.json`) ?? '{}'));
    const dirs = closureDirs(vertical, members, manifestOf);
    const memberScripts = dirs.map((d) => Object.values(manifestOf(d).scripts ?? {}).join('\n')).join('\n');
    verdict = decidePreview({
      files: changedFiles(base, head),
      vertical,
      workflow,
      dirs,
      memberScripts,
      show: (path) => ({ base: showAt(base, path), head: showAt(head, path) }),
      lockfile: () => lockfileScope(showAt(base, LOCKFILE) ?? '', showAt(head, LOCKFILE) ?? ''),
    });
    console.log(`closure of ${vertical}: ${dirs.length} workspace member(s), plus root files, tools/ and scripts/`);
  }

  console.log(`preview: ${verdict.run ? 'runs' : 'skipped'} — ${verdict.reason}`);
  for (const r of verdict.counted) console.log(`  counts  ${r.path} — ${r.why}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${verdict.run}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(verdict, vertical));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    // Never a red that blocks a merge for a tooling fault, and never a silent skip: run it.
    console.log(`::warning::preview-scope could not decide (${e.message}) — running the preview`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'run=true\n');
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `preview-scope could not decide (${e.message}); the preview runs.\n`);
  }
}
