import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRegistryCli } from './workspace-cli.mjs';

const lines = (src) => findRegistryCli(src).map((f) => f.line);

test('refuses the generated spelling, the one #3274 deployed with', () => {
  assert.deepEqual(lines('          npx @substrat-run/cli@latest push demos/auth-server --slug auth-server'), [1]);
});

test('refuses every registry runner, pinned or not, and boundary-lint too', () => {
  const src = [
    'run: npx -y @substrat-run/cli push .',
    'run: pnpm dlx @substrat-run/cli@0.60.3 push .',
    'run: yarn dlx @substrat-run/cli push .',
    'run: bunx @substrat-run/cli push .',
    'run: npm exec --yes -- @substrat-run/cli push .',
    'run: npm install -g @substrat-run/cli && substrat push .',
    'run: npx --package=@substrat-run/boundary-lint substrat-boundary-lint',
  ].join('\n');
  assert.deepEqual(lines(src), [1, 2, 3, 4, 5, 6, 7]);
});

test('accepts the workspace CLI and the pnpm filter that builds it', () => {
  const src = [
    'run: node packages/cli/dist/cli.js push demos/ticket0 --slug ticket0 --promote prod',
    'run: pnpm install --frozen-lockfile --filter "@substrat-run/cli..."',
    'run: pnpm --filter @substrat-run/cli --filter create-substrat test',
  ].join('\n');
  assert.deepEqual(lines(src), []);
});

test('ignores a YAML comment that quotes the registry spelling', () => {
  const src = [
    '# the generated workflow uses `npx @substrat-run/cli@latest` because …',
    '    run: node packages/cli/dist/cli.js push . # not npx @substrat-run/cli',
  ].join('\n');
  assert.deepEqual(lines(src), []);
});

test('does not read a longer package name as the CLI', () => {
  assert.deepEqual(lines('run: npx @substrat-run/cli-next push .'), []);
});

test('admits a reasoned opt-out on the line or the one above, and only a reasoned one', () => {
  const src = [
    '# workspace-cli-allow: checks what npm serves after a release',
    'run: npx @substrat-run/cli@latest --version',
    'run: npx @substrat-run/cli@latest --version # workspace-cli-allow: same, inline',
    '# workspace-cli-allow:',
    'run: npx @substrat-run/cli@latest --version',
  ].join('\n');
  assert.deepEqual(lines(src), [5]);
});
