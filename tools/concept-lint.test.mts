import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { syncConcept } from '../packages/model-view/src/concept.js';
import { run } from './concept-lint.mts';

const model = (fields: string[]) =>
  JSON.stringify({
    entities: {
      list: { table: 't_lists', fields: { type: 'object', properties: Object.fromEntries(fields.map((f) => [f, { type: 'string' }])) } },
    },
  });
const PERMISSIONS = '# P\n\n## 2. Roles\n\n| Role | Permissions |\n| --- | --- |\n| `member` | `list:create` |\n';
const DOC = `# Concept

<!-- substrat:roles -->
<!-- /substrat:roles -->
<!-- substrat:entities -->
<!-- /substrat:entities -->
<!-- substrat:processes -->
<!-- /substrat:processes -->

## Decisions log
- first
`;

function repo(): { root: string; write: (f: string, s: string) => void; git: (...a: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'concept-lint-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' });
  const write = (f: string, s: string) => {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), s);
  };
  git('init', '-q', '-b', 'main');
  return { root, write, git };
}

/** A vertical at demos/a whose concept.md is in sync with its model. */
function seed(r: ReturnType<typeof repo>, fields = ['id']) {
  r.write('demos/a/model.json', model(fields));
  r.write('demos/a/PERMISSIONS.md', PERMISSIONS);
  r.write('demos/a/spec/concept.md', syncConcept(DOC, { model: JSON.parse(model(fields)), permissionsMd: PERMISSIONS }));
  r.git('add', '-A');
  r.git('commit', '-qm', 'seed');
}

test('a synced document is clean, and syncing it again changes nothing', () => {
  const r = repo();
  seed(r);
  assert.deepEqual(run(r.root), []);
  const once = readFileSync(join(r.root, 'demos/a/spec/concept.md'), 'utf8');
  assert.equal(syncConcept(once, { model: JSON.parse(model(['id'])), permissionsMd: PERMISSIONS }), once);
});

test('a model that grew a field without a sync is stale', () => {
  const r = repo();
  seed(r);
  r.write('demos/a/model.json', model(['id', 'color']));
  r.git('add', '-A');
  assert.deepEqual(run(r.root).map((o) => o.rule), ['stale']);
});

test('a widened role without a sync is stale', () => {
  const r = repo();
  seed(r);
  r.write('demos/a/PERMISSIONS.md', PERMISSIONS.replace('`list:create`', '`list:create`, `list:manage`'));
  r.git('add', '-A');
  assert.deepEqual(run(r.root).map((o) => o.rule), ['stale']);
});

test('a model.json with a concept.md that has no markers is refused, not skipped', () => {
  const r = repo();
  r.write('demos/a/model.json', model(['id']));
  r.write('demos/a/spec/concept.md', '# Concept\n\n## Decisions log\n');
  r.git('add', '-A');
  assert.deepEqual(run(r.root).map((o) => o.rule), ['no-markers']);
});

test('a document with no Decisions log section is refused', () => {
  const r = repo();
  seed(r);
  const f = 'demos/a/spec/concept.md';
  r.write(f, readFileSync(join(r.root, f), 'utf8').replace('## Decisions log', '## Notes'));
  r.git('add', '-A');
  assert.deepEqual(run(r.root).map((o) => o.rule), ['no-decisions-log']);
});

test('against a base: a synced model change with no decisions-log entry is refused; with one it passes', () => {
  const r = repo();
  seed(r);
  const next = model(['id', 'color']);
  r.write('demos/a/model.json', next);
  const f = 'demos/a/spec/concept.md';
  const synced = syncConcept(readFileSync(join(r.root, f), 'utf8'), { model: JSON.parse(next), permissionsMd: PERMISSIONS });
  r.write(f, synced);
  r.git('add', '-A');
  r.git('commit', '-qm', 'grow');
  assert.deepEqual(run(r.root).map((o) => o.rule), []);
  assert.deepEqual(run(r.root, 'HEAD~1').map((o) => o.rule), ['undocumented-change']);
  r.write(f, `${synced}- added color to list\n`);
  assert.deepEqual(run(r.root, 'HEAD~1').map((o) => o.rule), []);
});

test('against a base: a change that touches neither model nor permissions needs no entry', () => {
  const r = repo();
  seed(r);
  r.write('demos/a/other.txt', 'x');
  r.git('add', '-A');
  r.git('commit', '-qm', 'unrelated');
  assert.deepEqual(run(r.root, 'HEAD~1'), []);
});

test('against a base: a changed permission snapshot also needs an entry', () => {
  const r = repo();
  seed(r);
  const widened = PERMISSIONS.replace('`list:create`', '`list:create`, `list:manage`');
  r.write('demos/a/PERMISSIONS.md', widened);
  const f = 'demos/a/spec/concept.md';
  r.write(f, syncConcept(readFileSync(join(r.root, f), 'utf8'), { model: JSON.parse(model(['id'])), permissionsMd: widened }));
  r.git('add', '-A');
  r.git('commit', '-qm', 'widen');
  assert.deepEqual(run(r.root, 'HEAD~1').map((o) => o.rule), ['undocumented-change']);
});

test('a base that is not in the checkout is a refusal, never a pass', () => {
  const r = repo();
  seed(r);
  assert.throws(() => run(r.root, 'origin/nope'));
});
