// node --test tools/ci-scope.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertPartition, assignShards, buildNames, CHANGED_NAMES, enclosingNames, classify, decide, lockfileScope, parseLockfile, parseUnit, PARTS, PINNED, READS, readersOf, unitsOf } from './ci-scope.mjs';

// A lockfile in pnpm v9's shape: two workspace packages sharing one third-party
// dependency, plus the root importer.
const base = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:
  hono: 4.13.8

importers:

  .:
    devDependencies:
      tsx:
        specifier: ^4.19.0
        version: 4.23.1

  packages/kernel:
    dependencies:
      zod:
        specifier: ^4.4.3
        version: 4.4.3

  demos/todo:
    dependencies:
      '@substrat-run/kernel':
        specifier: workspace:^
        version: link:../../packages/kernel
      zod:
        specifier: ^4.4.3
        version: 4.4.3

packages:

  tsx@4.23.1:
    resolution: {integrity: sha512-aaa}
    hasBin: true

  zod@4.4.3:
    resolution: {integrity: sha512-bbb}

snapshots:

  tsx@4.23.1:
    optionalDependencies:
      fsevents: 2.3.3

  fsevents@2.3.3:
    optional: true

  zod@4.4.3: {}
`.replace(
  'packages:\n',
  'packages:\n\n  fsevents@2.3.3:\n    resolution: {integrity: sha512-ccc}\n    os: [darwin]\n',
);

const edit = (text, from, to) => {
  assert.ok(text.includes(from), `fixture edit: ${from}`);
  return text.replace(from, to);
};

// demos/todo gains a dependency the lockfile did not have before.
const addDep = edit(
  edit(
    edit(
      base,
      `      zod:
        specifier: ^4.4.3
        version: 4.4.3

packages:`,
      `      zod:
        specifier: ^4.4.3
        version: 4.4.3
      hono:
        specifier: ^4.13.8
        version: 4.13.8

packages:`,
    ),
    '  tsx@4.23.1:\n    resolution',
    '  hono@4.13.8:\n    resolution: {integrity: sha512-ddd}\n\n  tsx@4.23.1:\n    resolution',
  ),
  '  tsx@4.23.1:\n    optionalDependencies',
  '  hono@4.13.8: {}\n\n  tsx@4.23.1:\n    optionalDependencies',
);

test('the fixture parses: sections, entries and edges', () => {
  const doc = parseLockfile(base);
  assert.deepEqual([...doc.sections.keys()], ['lockfileVersion', 'settings', 'overrides', 'importers', 'packages', 'snapshots']);
  assert.deepEqual([...doc.importers.keys()], ['.', 'packages/kernel', 'demos/todo']);
  assert.deepEqual(doc.importers.get('demos/todo').deps.map((d) => d.version), ['link:../../packages/kernel', '4.4.3']);
  assert.deepEqual(doc.snapshots.get('tsx@4.23.1').deps, [{ name: 'fsevents', version: '2.3.3' }]);
});

test('a deprecated block scalar keeps its odd-indented content in package text', () => {
  const stanza = `  workers-ai-provider@4.0.1:
    resolution: {integrity: sha512-provider}
    deprecated: |-
      Deprecated. Use createAI from agents/models/ai-sdk, or
       ai-search-provider for AI Search: https://developers.cloudflare.com/agents/models/ai-sdk/
    peerDependencies:
      '@ai-sdk/provider': ^4.0.0`;
  const doc = parseLockfile(edit(base, '  zod@4.4.3:\n    resolution', `${stanza}\n\n  zod@4.4.3:\n    resolution`));
  assert.equal(doc.packages.get('workers-ai-provider@4.0.1').raw, stanza);
  assert.ok(doc.packages.has('zod@4.4.3'));
});

test('an identical lockfile attributes nothing', () => {
  assert.deepEqual(lockfileScope(base, base), { importers: [] });
});

test('an importer-only change scopes to that importer', () => {
  const head = edit(base, 'workspace:^\n        version: link', 'workspace:*\n        version: link');
  assert.deepEqual(lockfileScope(base, head), { importers: ['demos/todo'] });
});

test('a new dependency scopes to the importer that asked for it', () => {
  assert.deepEqual(lockfileScope(base, addDep), { importers: ['demos/todo'] });
  // …and the removal is the same change read backwards.
  assert.deepEqual(lockfileScope(addDep, base), { importers: ['demos/todo'] });
});

test('a shared entry that changes pulls in every importer that reaches it', () => {
  // demos/todo moves to a new zod; packages/kernel's block is untouched, but the zod
  // entry it resolves to changed too, so its installed tree changed.
  let head = edit(base, 'specifier: ^4.4.3\n        version: 4.4.3\n\npackages:', 'specifier: ^4.4.3\n        version: 4.4.3\n\npackages:');
  head = edit(head, '  zod@4.4.3:\n    resolution: {integrity: sha512-bbb}', '  zod@4.4.3:\n    resolution: {integrity: sha512-zzz}');
  head = edit(head, "      '@substrat-run/kernel':\n        specifier: workspace:^", "      '@substrat-run/kernel':\n        specifier: workspace:*");
  assert.deepEqual(lockfileScope(base, head), { importers: ['demos/todo', 'packages/kernel'] });
});

test('a snapshots-only change runs everything', () => {
  const head = edit(base, '  zod@4.4.3: {}', '  zod@4.4.3:\n    dependencies:\n      fsevents: 2.3.3');
  const scope = lockfileScope(base, head);
  assert.match(scope.everything, /third-party entries without changing any importer/);
});

test('a packages-only change runs everything', () => {
  const head = edit(base, 'sha512-bbb', 'sha512-yyy');
  assert.match(lockfileScope(base, head).everything, /without changing any importer/);
});

test('a change outside the entries runs everything', () => {
  for (const [from, to, section] of [
    ['hono: 4.13.8', 'hono: 4.14.0', 'overrides'],
    ['autoInstallPeers: true', 'autoInstallPeers: false', 'settings'],
    ["lockfileVersion: '9.0'", "lockfileVersion: '10.0'", 'lockfileVersion'],
  ]) {
    assert.equal(lockfileScope(base, edit(base, from, to)).everything, `pnpm-lock.yaml changed outside its entries: ${section}`);
  }
  const patched = edit(base, 'importers:', 'patchedDependencies:\n  zod: patches/zod.patch\n\nimporters:');
  assert.match(lockfileScope(base, patched).everything, /outside its entries: patchedDependencies/);
});

test('the root importer runs everything', () => {
  const head = edit(base, 'specifier: ^4.19.0', 'specifier: ^4.20.0');
  assert.match(lockfileScope(base, head).everything, /root importer/);
});

test('an entry no importer reaches runs everything', () => {
  let head = edit(base, 'workspace:^\n        version: link', 'workspace:*\n        version: link');
  head = head.replace('snapshots:\n', 'snapshots:\n\n  left-pad@1.3.0: {}\n').replace('packages:\n', 'packages:\n\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-lp}\n');
  assert.match(lockfileScope(base, head).everything, /no importer reaches: left-pad@1\.3\.0/);
});

test('an edge to a snapshot that does not exist runs everything', () => {
  const head = edit(edit(base, 'workspace:^\n        version: link', 'workspace:*\n        version: link'), 'fsevents: 2.3.3', 'fsevents: 9.9.9');
  assert.match(lockfileScope(base, head).everything, /could not be walked \(fsevents@9\.9\.9 resolves to no snapshot\)/);
});

test('a lockfile that does not parse runs everything', () => {
  for (const broken of [
    'lockfileVersion: 9.0\n  stray: indent\n',
    base.replace('importers:\n\n  .:', 'importers:\n\n   .:'),
    base.replace('        version: 4.4.3', '        resolved: 4.4.3'),
    `---\n${base}`,
    base.replace('    dependencies:\n      zod', '     dependencies:\n      zod'),
    '{"lockfileVersion": "9.0"}',
  ]) {
    assert.notEqual(broken, base);
    assert.match(lockfileScope(base, broken).everything ?? 'SCOPED', /could not be read|outside its entries/, broken.slice(0, 60));
  }
  assert.match(lockfileScope(base, '  indented first line\n').everything, /could not be read \(line 1: content before any section\)/);
});

test('entries reordered only attribute nothing', () => {
  const doc = base.split('\n\n');
  const i = doc.findIndex((b) => b.startsWith('  tsx@4.23.1:\n    resolution'));
  const j = doc.findIndex((b) => b.startsWith('  zod@4.4.3:\n    resolution'));
  [doc[i], doc[j]] = [doc[j], doc[i]];
  const head = doc.join('\n\n');
  assert.notEqual(head, base);
  assert.deepEqual(lockfileScope(base, head), { importers: [] });
});

// ── Changed files and the decision ──────────────────────────────────────────

test('the lockfile no longer widens on its own; tools/ and the catalog still do', () => {
  assert.deepEqual(classify(['pnpm-lock.yaml', 'demos/todo/package.json', 'docs/x.md']), { widening: [], inMembers: 1, lockfile: true });
  assert.deepEqual(classify(['tools/ci-scope.mjs', 'pnpm-workspace.yaml']).widening, ['tools/ci-scope.mjs', 'pnpm-workspace.yaml']);
});

const all = [
  { name: '@substrat-run/kernel', dir: 'packages/kernel' },
  { name: '@substrat-run/demo-todo', dir: 'demos/todo' },
];

test('decide: a lockfile the reader refuses runs everything, and says why', () => {
  const r = decide({
    event: 'pull_request',
    base: 'B',
    files: ['pnpm-lock.yaml', 'demos/todo/package.json'],
    lockfile: () => ({ everything: 'pnpm-lock.yaml changed outside its entries: overrides' }),
    all,
    selectChanged: () => assert.fail('must not select'),
  });
  assert.deepEqual(r, { everything: 'pnpm-lock.yaml changed outside its entries: overrides' });
});

test('decide: lockfile importers join the pnpm selection', () => {
  let asked;
  const r = decide({
    event: 'pull_request',
    base: 'B',
    files: ['pnpm-lock.yaml'],
    lockfile: () => ({ importers: ['demos/todo', 'packages/gone'] }),
    all,
    selectChanged: (extra) => ((asked = extra), [all[1]]),
  });
  assert.deepEqual(asked, ['@substrat-run/demo-todo']);
  assert.deepEqual(r.selected, [all[1]]);
});

test('decide: a package that reads a changed file off disk joins the selection', () => {
  let asked;
  const r = decide({
    event: 'pull_request',
    base: 'B',
    files: ['engines/notifications/src/index.ts'],
    lockfile: () => assert.fail('not read'),
    all,
    // pnpm's selector, stubbed: it answers what it is asked for.
    selectChanged: (extra) => ((asked = extra), extra.map((name) => ({ name, dir: 'apps/console' }))),
  });
  const readers = ['@substrat-run/console', '@substrat-run/contracts'];
  assert.deepEqual(asked, readers);
  assert.deepEqual(r.selected, readers.map((name) => ({ name, dir: 'apps/console' })));
  assert.deepEqual(r.readers, readers);
  assert.deepEqual(r.lockfileImporters, []);
});
test('decide: a wrangler config selects contracts, the router source selects the adapter', () => {
  const ask = (files) => {
    let asked;
    decide({ event: 'pull_request', base: 'B', files, lockfile: () => assert.fail('not read'), all, selectChanged: (extra) => ((asked = extra), [all[1]]) });
    return asked;
  };
  assert.deepEqual(ask(['apps/router/wrangler.jsonc', 'apps/router/src/worker.ts']), ['@substrat-run/adapter-cloudflare', '@substrat-run/contracts']);
  assert.deepEqual(ask(['demos/auth-server/wrangler.jsonc']), ['@substrat-run/contracts']);
  assert.deepEqual(ask(['apps/router/src/worker.ts']), ['@substrat-run/adapter-cloudflare']);
  assert.deepEqual(ask(['demos/todo/wrangler.jsonc', 'apps/router/test/a.test.ts', 'apps/router/src2/x.ts']), []);
});
test('decide: the adapter\'s scope DO selects the kernel, other adapter source does not', () => {
  const ask = (files) => {
    let asked;
    decide({ event: 'pull_request', base: 'B', files, lockfile: () => assert.fail('not read'), all, selectChanged: (extra) => ((asked = extra), [all[1]]) });
    return asked;
  };
  assert.deepEqual(ask(['packages/adapter-cloudflare/src/scope-do.ts']), ['@substrat-run/kernel']);
  assert.deepEqual(ask(['packages/adapter-cloudflare/src/control-plane-do.ts']), []);
  // adapter-sqlite's own scope DO is not the kernel's to read (the CLI's push suite reads it: below).
  assert.deepEqual(ask(['packages/adapter-sqlite/src/scope-do.ts']), ['@substrat-run/cli']);
});
test('CHANGED_NAMES: a file moved out of an engine is listed where it left, too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-scope-'));
  try {
    const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    mkdirSync(join(dir, 'engines/x/src'), { recursive: true });
    writeFileSync(join(dir, 'engines/x/src/index.ts'), "export const manifest = { entitlementKey: 'x' };\n".repeat(20));
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('mv', 'engines/x/src/index.ts', 'engines/x/src/manifest.ts');
    git('commit', '-qm', 'move');
    const files = git(...CHANGED_NAMES, 'HEAD~1', 'HEAD').split('\n').filter(Boolean).sort();
    assert.deepEqual(files, ['engines/x/src/index.ts', 'engines/x/src/manifest.ts']);
    assert.deepEqual(readersOf(files), ['@substrat-run/console', '@substrat-run/contracts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('readersOf: an engine manifest selects the console and contracts, nothing else an engine holds does', () => {
  assert.deepEqual(readersOf(['engines/notifications/src/index.ts']), ['@substrat-run/console', '@substrat-run/contracts']);
  assert.deepEqual(readersOf(['engines/a/src/index.ts', 'engines/b/src/index.ts']), ['@substrat-run/console', '@substrat-run/contracts']);
  assert.deepEqual(readersOf(['engines/notifications/src/send.ts', 'engines/notifications/test/index.ts']), []);
  assert.deepEqual(readersOf(['apps/console/src/index.ts']), []);
});
test('readersOf: kernel and adapter-sqlite source select the CLI, whose push links both into a fixture (#2321)', () => {
  assert.deepEqual(readersOf(['packages/kernel/src/migration-replay.ts']), ['@substrat-run/cli']);
  assert.deepEqual(readersOf(['packages/adapter-sqlite/src/index.ts']), ['@substrat-run/cli']);
  assert.deepEqual(readersOf(['packages/kernel/test/migration-replay.test.ts', 'packages/adapter-cloudflare/src/index.ts']), []);
});
test("readersOf: todo's model.json and PERMISSIONS.md select console-data, whose local suite reads them", () => {
  assert.deepEqual(readersOf(['demos/todo/model.json']), ['@substrat-run/console-data']);
  assert.deepEqual(readersOf(['demos/todo/PERMISSIONS.md']), ['@substrat-run/console-data']);
  assert.deepEqual(readersOf(['demos/todo/openapi.json', 'demos/shop/model.json']), []);
});
test('READS: every entry names a suite that exists, in the package it names', () => {
  // A misspelled or renamed reader is a pnpm filter that selects nothing, silently.
  for (const r of READS) {
    assert.ok(existsSync(r.suite), `${r.reader}: ${r.suite} does not exist`);
    const pkg = r.suite.split('/').slice(0, 2).join('/');
    assert.equal(JSON.parse(readFileSync(`${pkg}/package.json`, 'utf8')).name, r.reader);
  }
});
test('decide: package files changed but pnpm selected nothing runs everything', () => {
  const r = decide({ event: 'pull_request', base: 'B', files: ['demos/todo/src/a.ts'], lockfile: null, all, selectChanged: () => [] });
  assert.match(r.everything, /1 package file\(s\) changed but pnpm selected no package/);
});

test('decide: a push runs everything; a change outside every package widens', () => {
  assert.match(decide({ event: 'push', files: [], all }).everything, /push runs everything/);
  const r = decide({ event: 'pull_request', base: 'B', files: ['tsconfig.base.json'], all, selectChanged: () => all });
  assert.deepEqual(r, { everything: 'changed outside every package:', detail: ['tsconfig.base.json'] });
});

// ── Shards ──────────────────────────────────────────────────────────────────

const workspace = [
  'packages/adapter-cloudflare', 'demos/auth-server', 'apps/control-plane', 'packages/control-plane-api',
  'demos/ticket0', 'demos/tock', 'packages/kernel', 'packages/contracts', 'engines/workorder',
  'packages/some-new-package', 'demos/another-new-demo',
].map((dir) => ({ name: `@x/${dir.replace('/', '-')}`, dir }));
// The shard matrix in .github/workflows/ci.yml.
const SHARDS = 6;

test('the shards partition the selection exactly, new packages included', () => {
  const shards = assignShards(workspace, SHARDS);
  const units = unitsOf(workspace).map((u) => u.name);
  assert.equal(shards.length, SHARDS);
  assert.deepEqual(shards.flat().sort(), [...units].sort());
  assert.equal(new Set(shards.flat()).size, units.length);
  // Every package is tested: whole, or every one of its parts.
  assert.deepEqual([...new Set(shards.flat().map((u) => parseUnit(u).name))].sort(), workspace.map((p) => p.name).sort());
});

test('a split package is tested as its parts, on different shards', () => {
  const shards = assignShards(workspace, SHARDS);
  const cf = '@x/packages-adapter-cloudflare';
  assert.ok(!shards.flat().includes(cf), 'the whole package is never also a unit');
  const where = PARTS['packages/adapter-cloudflare'].map((script) => shards.findIndex((s) => s.includes(`${cf}#${script}`)));
  assert.equal(new Set(where).size, where.length);
  assert.deepEqual(parseUnit(`${cf}#test:rest-1`), { name: cf, script: 'test:rest-1' });
  assert.deepEqual(parseUnit(cf), { name: cf, script: 'test' });
});

test('every pinned unit lands on its own shard', () => {
  const shards = assignShards(workspace, SHARDS);
  for (const [dir, index] of Object.entries(PINNED)) {
    assert.ok(shards[index].includes(`@x/${dir.replace('/', '-')}`), dir);
  }
});

test('a scoped selection may leave a shard empty, and that is still a partition', () => {
  const small = workspace.filter((p) => p.dir === 'packages/kernel');
  const shards = assignShards(small, 3);
  assert.deepEqual(shards.flat(), ['@x/packages-kernel']);
  assert.equal(shards.filter((s) => s.length === 0).length, 2);
  assert.deepEqual(assignShards([], 3), [[], [], []]);
});

test('the assignment is deterministic', () => {
  assert.deepEqual(assignShards(workspace, 3), assignShards([...workspace].reverse(), 3));
});

test('assertPartition refuses a missing, duplicated or extra package', () => {
  assert.throws(() => assertPartition(['a', 'b'], [['a'], []]), /missing: \[b\]/);
  assert.throws(() => assertPartition(['a'], [['a'], ['a']]), /in shard 1 and shard 2/);
  assert.throws(() => assertPartition(['a'], [['a', 'z']]), /extra: \[z\]/);
});

test('a shard builds the apps nested under the packages it tests', () => {
  const all = [
    { name: 'auth', dir: 'demos/auth-server' },
    { name: 'auth-app', dir: 'demos/auth-server/app' },
    { name: 'auth-server-2', dir: 'demos/auth-server-2' },
    { name: 'shop', dir: 'demos/shop' },
    { name: 'shop-admin', dir: 'demos/shop/admin' },
  ];
  assert.deepEqual(buildNames(['auth'], all), ['auth', 'auth-app']);
  assert.deepEqual(buildNames(['auth-app'], all), ['auth-app']);
  assert.deepEqual(buildNames(['shop', 'auth-server-2'], all), ['auth-server-2', 'shop', 'shop-admin']);
});

test('a CLI shard builds the demos its push suite reads and their engine dependencies', () => {
  const demoNames = ['@substrat-run/demo-meridian', '@substrat-run/demo-ticket0'];
  const all = [{ name: '@substrat-run/cli', dir: 'packages/cli' },
    { name: demoNames[0], dir: 'demos/meridian' },
    { name: demoNames[1], dir: 'demos/ticket0' }];
  const names = buildNames(['@substrat-run/cli'], all);
  assert.deepEqual(names, ['@substrat-run/cli', ...demoNames]);
  const selected = JSON.parse(execFileSync('pnpm', ['-r', ...names.map((name) => `--filter=${name}...`), 'list', '--depth', '-1', '--json'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
  })).map((p) => p.name);
  for (const engine of ['absence', 'protocol', 'metering']) {
    assert.ok(selected.includes(`@substrat-run/engine-${engine}`), `build must include engine-${engine}`);
  }
});

test('each split package\'s parts exist and together run its whole `test`', () => {
  for (const [dir, scripts] of Object.entries(PARTS)) {
    const pkg = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8'));
    const parts = scripts.map((name) => {
      assert.ok(pkg.scripts[name], `${dir} has no script ${name}`);
      return pkg.scripts[name];
    });
    // The files some parts name are exactly the files each other part excludes, so a file is
    // in a naming part or an excluding one, and a new file falls into the excluding parts —
    // which vitest's `--shard` splits between them, so together they take shards 1..n of n.
    const named = parts.flatMap((s) => [...s.matchAll(/vitest run ((?:test\/\S+\.test\.ts ?)+)/g)].flatMap((m) => m[1].trim().split(' ')));
    assert.ok(named.length > 0, `${dir}: no part names a file`);
    const excluding = parts.filter((s) => s.includes('--exclude'));
    assert.ok(excluding.length > 0, `${dir}: no part runs the files the others do not name`);
    for (const s of excluding) {
      const excluded = [...s.matchAll(/--exclude (\S+)/g)].map((m) => m[1]);
      assert.deepEqual([...excluded].sort(), [...named].sort(), `${dir}: the named and excluded files differ`);
    }
    const shards = excluding.map((s) => /--shard=(\d+\/\d+)/.exec(s)?.[1] ?? '1/1').sort();
    assert.deepEqual(shards, excluding.map((_, i) => `${i + 1}/${excluding.length}`), `${dir}: the excluding parts are not shards 1..n of n`);
    // Every extra vitest config `test` runs is run by a part too.
    for (const [, config] of pkg.scripts.test.matchAll(/-c (\S+)/g)) {
      assert.ok(parts.some((s) => s.includes(`-c ${config}`)), `${dir}: no part runs ${config}`);
    }
  }
});

test('enclosingNames: a nested app selects the demo around it, never the reverse', () => {
  const all = [
    { name: 'demo', dir: 'demos/todo' },
    { name: 'app', dir: 'demos/todo/app' },
    { name: 'kernel', dir: 'packages/kernel' },
  ];
  assert.deepEqual(enclosingNames(['app'], all), ['app', 'demo']);
  assert.deepEqual(enclosingNames(['demo'], all), ['demo']);
  assert.deepEqual(enclosingNames(['kernel'], all), ['kernel']);
});

test('decide: the changesets release PR runs everything, however small its diff', () => {
  const args = {
    event: 'pull_request',
    base: 'b',
    files: ['packages/kernel/package.json', 'packages/kernel/CHANGELOG.md'],
    lockfile: () => assert.fail('not read'),
    all: [{ name: 'kernel', dir: 'packages/kernel' }],
    selectChanged: () => [{ name: 'kernel', dir: 'packages/kernel' }],
  };
  assert.ok('everything' in decide({ ...args, head: 'changeset-release/main' }));
  assert.deepEqual(decide({ ...args, head: 'feature/x' }).selected, [{ name: 'kernel', dir: 'packages/kernel' }]);
});
