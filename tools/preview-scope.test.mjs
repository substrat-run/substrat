// node --test tools/preview-scope.test.mjs
//
// The last test reads the CLI's built `collectSourceSnapshot`, so it needs `pnpm -r build`
// (or at least @substrat-run/cli's closure) first; ci.yml runs it after the build.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { changedFiles, closureDirs, decidePreview, inUpload, LIFECYCLE, memberManifestChange, rootManifestChange, summary } from './preview-scope.mjs';

// A workspace in the repo's shape: a vertical with a nested app, an engine, the kernel it
// reaches through the engine, a dev-only tool package, and an app nothing in it depends on.
const MEMBERS = [
  { name: '@x/demo', dir: 'demos/demo' },
  { name: '@x/demo-app', dir: 'demos/demo/app' },
  { name: '@x/engine', dir: 'engines/engine' },
  { name: '@x/kernel', dir: 'packages/kernel' },
  { name: '@x/lint', dir: 'packages/lint' },
  { name: '@x/dashboard', dir: 'apps/dashboard' },
];
const MANIFESTS = {
  'demos/demo': { dependencies: { '@x/engine': 'workspace:*', zod: '^4' }, devDependencies: { '@x/lint': 'workspace:*' } },
  'demos/demo/app': {},
  'engines/engine': { peerDependencies: { '@x/kernel': 'workspace:*' } },
  'packages/kernel': { scripts: { build: 'tsc' } },
  'packages/lint': { scripts: { check: 'pnpm -w run lint:root' } },
  'apps/dashboard': { dependencies: { '@x/kernel': 'workspace:*' } },
};
const DIRS = closureDirs('demos/demo', MEMBERS, (d) => MANIFESTS[d]);

const pkg = (o) => `${JSON.stringify(o, null, 2)}\n`;
const ROOT = { name: 'root', private: true, scripts: { prepare: 'git config core.hooksPath .githooks', 'lint:a': 'node tools/a.mjs' } };

function verdict(files, { show = {}, lockfile = { importers: [] } } = {}) {
  return decidePreview({
    files,
    vertical: 'demos/demo',
    workflow: '.github/workflows/demo-deploy.yml',
    dirs: DIRS,
    memberScripts: DIRS.map((d) => Object.values(MANIFESTS[d].scripts ?? {}).join('\n')).join('\n'),
    show: (p) => show[p] ?? assert.fail(`read ${p} unexpectedly`),
    lockfile: () => lockfile,
  });
}

test('the closure follows every dependency field transitively, and nests', () => {
  assert.deepEqual(DIRS, ['demos/demo', 'demos/demo/app', 'engines/engine', 'packages/kernel', 'packages/lint']);
});

test('changed-file lists → run or skip', () => {
  const cases = [
    // [files, run, what it proves]
    [['apps/dashboard/src/a.ts', 'docs/x.md', '.changeset/a.md', 'README.md'], false, 'nothing the vertical uploads'],
    [['.github/workflows/ci.yml'], false, 'another workflow'],
    [['.github/workflows/demo-deploy.yml'], true, 'its own workflow'],
    [['packages/kernel/src/index.ts'], true, 'a transitive dependency'],
    [['packages/lint/src/rule.ts'], true, 'a dev-only dependency is uploaded too'],
    [['demos/demo/app/src/main.tsx'], true, 'a nested app'],
    [['demos/demo/test/scenario.test.ts'], true, "the vertical's own tests"],
    [['packages/kernel/test/a.test.ts', 'engines/engine/CHANGELOG.md'], false, "a dependency's tests and changelog"],
    [['demos/demo/CHANGELOG.md'], false, "the vertical's own changelog"],
    [['tools/vitest/preload.cjs'], true, 'tools/ is uploaded whole'],
    [['scripts/x.mjs'], true, 'scripts/ is uploaded whole'],
    [['pnpm-workspace.yaml'], true, 'the catalog'],
    [['.npmrc'], true, 'a root config file'],
    [['LICENSE', 'CLAUDE.md'], false, 'root documentation'],
  ];
  for (const [files, run, why] of cases) assert.equal(verdict(files).run, run, `${why}: ${files.join(', ')}`);
});

test('the lockfile counts only for an importer inside the closure, and whenever it cannot be pinned', () => {
  assert.equal(verdict(['pnpm-lock.yaml'], { lockfile: { importers: ['apps/dashboard'] } }).run, false);
  assert.equal(verdict(['pnpm-lock.yaml'], { lockfile: { importers: ['apps/dashboard', 'packages/kernel'] } }).run, true);
  const v = verdict(['pnpm-lock.yaml'], { lockfile: { everything: 'pnpm-lock.yaml changed outside its entries: catalogs' } });
  assert.equal(v.run, true);
  assert.match(v.reason, /catalogs/);
});

test("a member's package.json counts unless only its version moved", () => {
  const before = pkg({ name: '@x/kernel', version: '1.0.0', scripts: { build: 'tsc' } });
  const bumped = pkg({ name: '@x/kernel', version: '1.1.0', scripts: { build: 'tsc' } });
  const rescripted = pkg({ name: '@x/kernel', version: '1.0.0', scripts: { build: 'tsc -b' } });
  const p = 'packages/kernel/package.json';
  assert.equal(verdict([p], { show: { [p]: { base: before, head: bumped } } }).run, false);
  assert.equal(verdict([p], { show: { [p]: { base: before, head: rescripted } } }).run, true);
  assert.equal(verdict([p], { show: { [p]: { base: undefined, head: bumped } } }).run, true);
  assert.equal(memberManifestChange(before, '{ not json'), 'package.json added, removed or unreadable');
});

test('the root package.json counts unless only scripts nothing here runs changed', () => {
  const r = (o) => ({ 'package.json': { base: pkg(ROOT), head: pkg(o) } });
  const scripts = (extra) => ({ ...ROOT, scripts: { ...ROOT.scripts, ...extra } });
  assert.equal(verdict(['package.json'], { show: r(scripts({ 'test:new': 'node --test tools/new.test.mjs' })) }).run, false);
  assert.equal(verdict(['package.json'], { show: r(scripts({ prepare: 'husky' })) }).run, true, 'an install hook');
  assert.equal(verdict(['package.json'], { show: r(scripts({ postinstall: 'node x' })) }).run, true, 'a new install hook');
  assert.equal(verdict(['package.json'], { show: r(scripts({ 'lint:root': 'y' })) }).run, true, 'a script a member names');
  assert.equal(verdict(['package.json'], { show: r({ ...ROOT, packageManager: 'pnpm@11.0.0' }) }).run, true, 'outside scripts');
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'pnpm:devPreinstall']) assert.match(hook, LIFECYCLE);
  assert.equal(rootManifestChange(pkg(ROOT), pkg(ROOT), ''), null);
});

test('changed paths come out of git exactly as the tree spells them, and still count', () => {
  // core.quotePath at its default: a newline-delimited list would C-quote both names.
  const repo = mkdtempSync(join(tmpdir(), 'preview-scope-'));
  try {
    const run = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: repo, encoding: 'utf8' });
    run('init', '-q');
    writeFileSync(join(repo, 'README.md'), 'x\n');
    run('add', '.');
    run('commit', '-qm', 'base');
    const names = ['demos/demo/app/public/caf\u00e9.svg', 'demos/demo/say "hi".txt'];
    mkdirSync(join(repo, 'demos/demo/app/public'), { recursive: true });
    for (const n of names) writeFileSync(join(repo, n), '<svg/>\n');
    run('add', '.');
    run('commit', '-qm', 'head');
    const files = changedFiles('HEAD~1', 'HEAD', repo);
    assert.deepEqual(files.sort(), [...names].sort());
    assert.equal(verdict(files).run, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the summary of a skip says it is not a failure and lists what did not count', () => {
  const s = summary(verdict(['apps/dashboard/src/a.ts']), 'demos/demo');
  assert.match(s, /^### demo preview: skipped — no change to demo's upload closure/);
  assert.match(s, /Not a failure/);
  assert.match(s, /`apps\/dashboard\/src\/a.ts` — outside the upload closure/);
  assert.match(summary(verdict(['packages/kernel/src/a.ts']), 'demos/demo'), /^### demo preview: runs/);
});

// The tool restates the CLI's selection rule; this holds the two together on the real repo.
// Every file the CLI would upload must be one `inUpload` keeps (the direction that matters:
// otherwise a change the build sees could skip its preview), and every file `inUpload` keeps
// beyond that must be one the CLI drops only as a credential or build-output path.
test('inUpload agrees with the CLI snapshot of every deployed vertical', async (t) => {
  const cli = 'packages/cli/dist/source-snapshot.js';
  const contracts = 'packages/contracts/dist/index.js';
  assert.ok(existsSync(cli) && existsSync(contracts), `build first: ${cli} and ${contracts} are missing`);
  const { collectSourceSnapshot } = await import(pathToFileURL(cli).href);
  const { excludedSourcePath } = await import(pathToFileURL(contracts).href);
  const listed = JSON.parse(execFileSync('pnpm', ['-r', 'list', '--depth', '-1', '--json'], { encoding: 'utf8', maxBuffer: 64e6 }));
  const root = process.cwd();
  const members = listed.filter((m) => m.path !== root).map((m) => ({ name: m.name, dir: m.path.slice(root.length + 1) }));
  const { readFileSync } = await import('node:fs');
  const manifestOf = (d) => JSON.parse(readFileSync(`${d}/package.json`, 'utf8'));
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256e6 }).split('\0').filter(Boolean);
  for (const vertical of ['demos/meridian', 'demos/ticket0']) {
    await t.test(vertical, () => {
      const uploaded = new Set(collectSourceSnapshot(vertical).files.map((f) => f.path));
      const dirs = closureDirs(vertical, members, manifestOf);
      const missed = [...uploaded].filter((p) => !inUpload(p, vertical, dirs));
      assert.deepEqual(missed, [], 'uploaded by the CLI, judged outside the closure');
      const extra = tracked.filter((p) => existsSync(p) && inUpload(p, vertical, dirs) && !uploaded.has(p) && !excludedSourcePath(p));
      assert.deepEqual(extra, [], 'judged inside the closure, never uploaded');
    });
  }
});
