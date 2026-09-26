// node --test tools/ci-scope.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPartition, assignShards, buildNames, classify, decide, lockfileScope, parseLockfile, PINNED } from './ci-scope.mjs';

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

test('the shards partition the selection exactly, new packages included', () => {
  const shards = assignShards(workspace, 3);
  assert.equal(shards.length, 3);
  assert.deepEqual(shards.flat().sort(), workspace.map((p) => p.name).sort());
  assert.equal(new Set(shards.flat()).size, workspace.length);
});

test('the three longest suites land in three different shards', () => {
  const shards = assignShards(workspace, 3);
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
