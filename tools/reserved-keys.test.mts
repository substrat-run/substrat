// tsx --test tools/reserved-keys.test.mts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { reservedKeyMessage, reservedKeyOffences } from './reserved-keys.mts';

const none = { roles: [], grants: [] };

test('a role granting assistant:run is an offence naming the role', () => {
  const o = reservedKeyOffences({ ...none, roles: [{ key: 'member', permissions: ['assistant:use', 'assistant:run'] }] });
  assert.deepEqual(o, [{ where: 'role member', key: 'assistant:run' }]);
});

test('an entity grant shape granting it is an offence too', () => {
  const o = reservedKeyOffences({ ...none, grants: [{ entityType: 'thread', permissions: ['assistant:run'] }] });
  assert.deepEqual(o, [{ where: 'grant shape on thread', key: 'assistant:run' }]);
});

test('its twin: use and audit on roles, and on a shape, pass', () => {
  const o = reservedKeyOffences({
    roles: [
      { key: 'member', permissions: ['assistant:use'] },
      { key: 'staff', permissions: ['assistant:use', 'assistant:audit'] },
    ],
    grants: [{ entityType: 'thread', permissions: ['assistant:use'] }],
  });
  assert.deepEqual(o, []);
});

test('the message names the vertical, the file, the grant and the remedy', () => {
  const m = reservedKeyMessage('demos/x', 'src/provision.ts', [{ where: 'role member', key: 'assistant:run' }]);
  assert.match(m, /demos\/x\/src\/provision\.ts/);
  assert.match(m, /role member → assistant:run/);
  assert.match(m, /schedule/);
});

// End to end: the tool itself, on a fixture vertical, so the wiring is held and not only the function.
const fixture = (roles: unknown, schedules: unknown = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'reserved-keys-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', type: 'module', substrat: { permissions: 'src/p.mjs' } }),
  );
  writeFileSync(
    join(dir, 'src/p.mjs'),
    `export const permissions = { entityGrants: [], roles: ${JSON.stringify(roles)}, modules: [{ manifest: {
  id: 'engine-assistant', schedules: ${JSON.stringify(schedules)},
  permissions: ['assistant:use','assistant:audit','assistant:run'].map((key) => ({ key, description: key })) } }] };`,
  );
  return dir;
};
const run = (dir: string) =>
  spawnSync('pnpm', ['exec', 'tsx', 'tools/permission-diff.mts', '--root', dir], { encoding: 'utf8' });

test('the tool exits 2 on a role granting assistant:run, naming it', () => {
  const r = run(fixture([{ key: 'member', permissions: ['assistant:run'] }]));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /role member → assistant:run/);
});

test('…and passes a role with use/audit, with the run key held only by a schedule (system principal)', () => {
  const r = run(
    fixture(
      [{ key: 'staff', permissions: ['assistant:use', 'assistant:audit'] }],
      [{ operation: 'assistant/sweep', permissions: ['assistant:run'] }],
    ),
  );
  assert.equal(r.status, 0, r.stderr);
});
