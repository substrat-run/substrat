import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ciCommands, findOffences, parseGates } from './review-checklist.mjs';

const ci = ciCommands(`
jobs:
  checks:
    steps:
      - run: pnpm lint:model --check
      - run: node tools/boundary-lint.mjs
      - run: pnpm run lint:tests
      - name: base
        run: |
          base="origin/main"
          pnpm lint:export-schemas --base "$base"
      - name: typecheck
        run: |
          pnpm -r "\${filters[@]}" typecheck
`);
const world = {
  scripts: { 'lint:model': 'tsx tools/model-diff.mts', 'lint:tests': 'node x', 'lint:export-schemas': 'tsx y', typecheck: 'pnpm -r typecheck', 'lint:unrun': 'node z' },
  ci,
  scaffold: new Set(['npm test', 'npm run lint:boundaries']),
  fileExists: (p) => p === 'tools/boundary-lint.mjs',
};
const item = (gates) => `# Checklist\n\n## Items\n\n### S1 · Thing: blocking\n\nProse.\n\n${gates}\n\n## Not listed here\n`;
const offences = (gates) => findOffences(item(gates), world);

test('commands that exist and run, plus judgement, pass', () => {
  assert.deepEqual(offences('gates: `pnpm lint:model --check` · `node tools/boundary-lint.mjs` · `npm run lint:boundaries` · judgement'), []);
});

test('`pnpm run X` in the checklist matches `pnpm X` in CI, and the reverse', () => {
  assert.deepEqual(offences('gates: `pnpm run lint:model --check` · `pnpm lint:tests`'), []);
});

test('a script CI runs only through its recursive sweep counts', () => {
  assert.deepEqual(offences('gates: `pnpm typecheck`'), []);
});

test('<ref> stands for the one argument CI computes', () => {
  assert.deepEqual(offences('gates: `pnpm lint:export-schemas --base <ref>`'), []);
});

test('judgement alone is a valid answer for an item no script decides', () => {
  assert.deepEqual(offences('gates: judgement'), []);
});

test('a script that does not exist is refused', () => {
  assert.match(offences('gates: `pnpm lint:nothing`')[0], /names no root package.json script/);
});

test('a script that exists but CI never runs is refused', () => {
  assert.match(offences('gates: `pnpm lint:unrun`')[0], /is not run by/);
});

test('a CI command with other arguments is not the same gate', () => {
  assert.match(offences('gates: `pnpm lint:model`')[0], /is not run by/);
  assert.match(offences('gates: `pnpm lint:tests --check`')[0], /is not run by/);
});

test('a node command naming no file is refused, and so is one CI does not run', () => {
  assert.match(offences('gates: `node tools/gone.mjs`')[0], /names no file/);
  const runsNot = { ...world, fileExists: () => true };
  assert.match(findOffences(item('gates: `node tools/other.mjs`'), runsNot)[0], /is not run by/);
});

test('a scaffold command that is not a shipped gate is refused', () => {
  assert.match(offences('gates: `npm run lint:model`')[0], /not a gate a scaffolded project ships with/);
});

test('an item with no gates line, or two, is refused', () => {
  assert.match(offences('No machine line.')[0], /has 0 `gates:` lines/);
  assert.match(offences('gates: judgement\ngates: judgement')[0], /has 2 `gates:` lines/);
});

test('a gates line under the NEXT heading does not count for the item above it', () => {
  const md = `### S1 · A: blocking\n\nprose\n\n## Not listed here\n\ngates: judgement\n`;
  assert.match(findOffences(md, world)[0], /has 0 `gates:` lines/);
});

test('an empty or malformed gates value is refused', () => {
  assert.match(parseGates('').error, /neither a backticked command/);
  assert.match(parseGates('pnpm lint:model').error, /neither a backticked command/);
  assert.match(parseGates('judgement · judgement').error, /listed twice/);
});

test('a checklist with no items is refused rather than passing over nothing', () => {
  assert.match(findOffences('# nothing\n', world)[0], /no `### S<n>` items/);
});

test('an unknown command kind is refused', () => {
  assert.match(offences('gates: `make lint`')[0], /neither a pnpm, node nor npm command/);
});

test('a |- or >- block scalar is read like |', () => {
  const runs = ciCommands(`
jobs:
  checks:
    steps:
      - run: |-
          pnpm lint:model --check
      - run: >-
          pnpm lint:tests
`);
  assert.deepEqual(runs.map((c) => c.join(' ')), ['pnpm lint:model --check', 'pnpm lint:tests']);
});

test('a step that runs only on some events or refs, or in another directory, does not count as run on a PR', () => {
  const runs = ciCommands(`
jobs:
  checks:
    steps:
      - name: push only
        if: github.event_name == 'push'
        run: pnpm lint:pushonly
      - if: github.ref == 'refs/heads/main'
        run: pnpm lint:mainonly
      - name: elsewhere
        working-directory: demos/todo
        run: pnpm lint:elsewhere
      - name: scoped, still every PR
        if: steps.scope.outputs.count != '0'
        run: pnpm lint:scoped
  release:
    if: github.event_name == 'push'
    steps:
      - run: pnpm lint:releaseonly
  every:
    steps:
      - run: pnpm lint:every
`);
  assert.deepEqual(runs.map((c) => c.join(' ')), ['pnpm lint:scoped', 'pnpm lint:every']);
});

test('a step that cannot fail the PR, or runs only under a condition CI cannot promise, is not a gate', () => {
  const runs = ciCommands(`
jobs:
  checks:
    steps:
      - name: may fail
        continue-on-error: true
        run: pnpm lint:mayfail
      - if: contains(github.event.pull_request.labels.*.name, 'heavy')
        run: pnpm lint:labelled
      - if: false
        run: pnpm lint:never
      - if: \${{ always() }}
        run: pnpm lint:always
      - if: success()
        run: pnpm lint:success
      - if: steps.scope.outputs.count != '0'
        run: pnpm lint:scoped
      - continue-on-error: false
        run: pnpm lint:strict
`);
  assert.deepEqual(runs.map((c) => c.join(' ')), ['pnpm lint:always', 'pnpm lint:success', 'pnpm lint:scoped', 'pnpm lint:strict']);
});
