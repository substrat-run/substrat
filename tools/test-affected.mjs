#!/usr/bin/env node
// `pnpm test:affected` — the local half of what a PR's CI tests: the packages your
// branch touched plus everything that depends on them, built and tested with the same
// preloads the root `pnpm test` adds. The rule is tools/ci-scope.mjs's, imported rather
// than restated — same inert paths, same "anything outside a package widens to
// everything", same lockfile reader, same build closure (nested apps included) — so a
// green run here means the scoped PR run should agree.
//
// Two things differ from CI, both on purpose:
//
//   - Files map to packages by DIRECTORY, not through pnpm's `...[ref]` selector. That
//     selector silently selects nothing inside a linked git worktree (exit 0, no
//     packages), which is where most local work here happens. A path under a package
//     root that no member owns widens to everything instead of being dropped.
//   - The diff is the WORKING TREE against the merge-base with origin/main, untracked
//     files included, because what you are about to push is not committed yet.
//
//   pnpm test:affected                  # build + test the affected packages
//   pnpm test:affected --dry-run        # print the selection and stop
//   pnpm test:affected --base <ref>     # diff against another ref
//
// A push to main still runs everything in CI; this does not replace that.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildNames, decide, enclosingNames, lockfileScope, LOCKFILE, MEMBERS } from './ci-scope.mjs';

/**
 * Which workspace members own `files`. A file belongs to the member with the longest
 * directory prefix, so `demos/todo/app/src/x.ts` is the app's, not the demo's. A file
 * under a package root (MEMBERS) that no member owns is `unowned` — a deleted package,
 * or one this checkout's install has not seen — and the caller must not guess about it.
 */
export function ownersOf(files, all) {
  const byLength = [...all].sort((a, b) => b.dir.length - a.dir.length);
  const owners = new Set();
  const unowned = [];
  for (const f of files) {
    if (!MEMBERS.test(f)) continue;
    const p = byLength.find((m) => f.startsWith(`${m.dir}/`));
    if (p) owners.add(p.name);
    else unowned.push(f);
  }
  return { owners: [...owners].sort(), unowned };
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const lines = (s) => s.split('\n').filter(Boolean);

// The workspace members, minus the gitignored builder-studio scratch projects the root
// scripts exclude too (#769).
function workspace(filters) {
  const out = execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json', ...filters.map((f) => `--filter=${f}`)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const root = process.cwd();
  return JSON.parse(out)
    .filter((p) => p.path !== root)
    .map((p) => ({ name: p.name, dir: p.path.slice(root.length + 1) }))
    .filter((p) => !p.dir.startsWith('.builder/'))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

function run(cmd, args, env) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const dryRun = argv.includes('--dry-run');
  const base = arg('--base') ?? git('merge-base', 'HEAD', 'origin/main').trim();
  const files = [
    ...new Set([
      ...lines(git('diff', '--name-only', '--no-renames', base)),
      ...lines(git('ls-files', '--others', '--exclude-standard')),
    ]),
  ].sort();

  const all = workspace([]);
  const { owners, unowned } = ownersOf(files, all);
  const result =
    unowned.length > 0
      ? { everything: 'changed under a package root no workspace member owns:', detail: unowned }
      : decide({
          event: 'pull_request',
          base,
          files,
          lockfile: () => lockfileScope(git('show', `${base}:${LOCKFILE}`), readFileSync(LOCKFILE, 'utf8')),
          all,
          selectChanged: (extra) => {
            const names = enclosingNames([...owners, ...extra], all);
            return names.length === 0 ? [] : workspace(names.map((n) => `...${n}`));
          },
        });

  const preloads = {
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${process.cwd()}/tools/vitest/like-pattern-limit.cjs`, `--require=${process.cwd()}/tools/vitest/sql-limits.cjs`]
      .filter(Boolean)
      .join(' '),
  };

  if ('everything' in result) {
    console.log(`test:affected: everything — ${result.everything}`);
    for (const d of result.detail ?? []) console.log(`  ${d}`);
    if (!dryRun) run('pnpm', ['run', 'test']);
    return;
  }
  const names = result.selected.map((p) => p.name);
  console.log(`test:affected: ${names.length} package(s) — changed against ${base.slice(0, 12)}, plus their dependents:`);
  for (const p of result.selected) console.log(`  ${p.dir}`);
  if (result.lockfileImporters.length > 0) {
    console.log(`test:affected: ${LOCKFILE} changed the dependencies of: ${result.lockfileImporters.join(', ')}`);
  }
  if (names.length === 0) {
    console.log('test:affected: nothing to test — every change is outside the packages and inert');
    return;
  }
  if (dryRun) return;
  run('pnpm', ['-r', ...buildNames(names, all).map((n) => `--filter=${n}...`), 'build']);
  run('pnpm', ['-r', ...names.map((n) => `--filter=${n}`), 'test'], preloads);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
