// tsx --test tools/reserved-keys.test.mts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

test('a system-held role may hold a reserved key (K-55), and nothing else may', () => {
  assert.deepEqual(
    reservedKeyOffences({ ...none, roles: [{ key: 'assistant-host', holder: 'system', permissions: ['assistant:run'] }] }),
    [],
  );
  assert.deepEqual(
    reservedKeyOffences({
      ...none,
      roles: [{ key: 'assistant-host', holder: 'system', permissions: ['assistant:run', 'assistant:use'] }],
    }),
    [{ where: 'system-held role assistant-host', key: 'assistant:use', notReserved: true }],
  );
});

test('holder: person is the same as no holder', () => {
  const o = reservedKeyOffences({ ...none, roles: [{ key: 'm', holder: 'person', permissions: ['assistant:run'] }] });
  assert.deepEqual(o, [{ where: 'role m', key: 'assistant:run' }]);
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

test('…and passes a system-held role with the run key, rendering it in its own section', () => {
  const dir = fixture([
    { key: 'staff', permissions: ['assistant:use'] },
    { key: 'assistant-host', holder: 'system', permissions: ['assistant:run'] },
  ]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(dir, 'PERMISSIONS.md'), 'utf8'), /System-held roles[\s\S]*assistant-host/);
});

test('…and refuses a system-held role holding a person-grade key', () => {
  const r = run(fixture([{ key: 'assistant-host', holder: 'system', permissions: ['assistant:run', 'assistant:use'] }]));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /system-held role assistant-host → assistant:use/);
});

test('a system-held role holding no reserved key is an offence, not a vacuous pass', () => {
  const o = reservedKeyOffences({ ...none, roles: [{ key: 'x', holder: 'system', permissions: [] }] });
  assert.deepEqual(o, [{ where: 'system-held role x', key: '(none)', notReserved: true, empty: true }]);
});

test('the message header follows the offence kind, and the remedy is not circular', () => {
  const m = reservedKeyMessage('demos/x', 'src/p.ts', [
    { where: 'system-held role h', key: 'assistant:use', notReserved: true },
  ]);
  assert.match(m, /declares a system-held role that is not made of keys reserved/);
  assert.doesNotMatch(m, /to a person's role or grant shape/);
});

test('…and the tool refuses an empty system-held role end to end', () => {
  const r = run(fixture([{ key: 'assistant-host', holder: 'system', permissions: [] }]));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /at least one key reserved/);
});

test('the Held-by column keeps the bare role key', () => {
  const dir = fixture([{ key: 'assistant-host', holder: 'system', permissions: ['assistant:run'] }]);
  assert.equal(run(dir).status, 0);
  const md = readFileSync(join(dir, 'PERMISSIONS.md'), 'utf8');
  assert.doesNotMatch(md, /\(system\)/);
});
