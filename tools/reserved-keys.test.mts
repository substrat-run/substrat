// tsx --test tools/reserved-keys.test.mts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { parsePermissions as permissionsView } from '../packages/model-view/dist/index.js';
import { classifyPermissions, parsePermissions as snapshotOf } from '../packages/cli/src/bump.ts';
import { repoRoot } from './repo-path.mjs';
import { reservedKeyMessage, reservedKeyOffences, reservedKeysOf } from './reserved-keys.mts';

type Surface = Parameters<typeof reservedKeyOffences>[0];

/** engine-assistant's three keys, as its manifest declares them: the run key reserved. */
const assistant = {
  manifest: {
    id: '@substrat-run/engine-assistant',
    permissions: [
      { key: 'assistant:use', description: 'use' },
      { key: 'assistant:audit', description: 'audit' },
      { key: 'assistant:run', description: 'drive a run', holder: 'system' as const },
    ],
  },
};
const reserved = reservedKeysOf([assistant]);
const offences = (s: Partial<Surface>, keys = reserved) => reservedKeyOffences({ roles: [], grants: [], ...s }, keys);

test('a role granting assistant:run is an offence naming the role', () => {
  const o = offences({ roles: [{ key: 'member', permissions: ['assistant:use', 'assistant:run'] }] });
  assert.deepEqual(o, [{ where: 'role member', key: 'assistant:run' }]);
});

test('an entity grant shape granting it is an offence too', () => {
  const o = offences({ grants: [{ entityType: 'thread', permissions: ['assistant:run'] }] });
  assert.deepEqual(o, [{ where: 'grant shape on thread', key: 'assistant:run' }]);
});

test('its twin: use and audit on roles, and on a shape, pass', () => {
  const o = offences({
    roles: [
      { key: 'member', permissions: ['assistant:use'] },
      { key: 'staff', permissions: ['assistant:use', 'assistant:audit'] },
    ],
    grants: [{ entityType: 'thread', permissions: ['assistant:use'] }],
  });
  assert.deepEqual(o, []);
});

test('a system-held role may hold a reserved key (K-55), and nothing else may', () => {
  assert.deepEqual(offences({ roles: [{ key: 'assistant-host', holder: 'system', permissions: ['assistant:run'] }] }), []);
  assert.deepEqual(
    offences({ roles: [{ key: 'assistant-host', holder: 'system', permissions: ['assistant:run', 'assistant:use'] }] }),
    [{ where: 'system-held role assistant-host', key: 'assistant:use', notReserved: true }],
  );
});

test('holder: person is the same as no holder', () => {
  const o = offences({ roles: [{ key: 'm', holder: 'person', permissions: ['assistant:run'] }] });
  assert.deepEqual(o, [{ where: 'role m', key: 'assistant:run' }]);
});

test('the message names the vertical, the file, the grant, the declaring module and the remedy', () => {
  const m = reservedKeyMessage('demos/x', 'src/provision.ts', [{ where: 'role member', key: 'assistant:run' }], reserved);
  assert.match(m, /demos\/x\/src\/provision\.ts/);
  assert.match(m, /role member → assistant:run: declared `holder: 'system'` by @substrat-run\/engine-assistant \(drive a run\)/);
  assert.match(m, /schedule/);
});

test('the reserved keys are exactly those a manifest declares holder: system', () => {
  assert.deepEqual([...reserved.keys()], ['assistant:run']);
  const digests = { manifest: { id: '@acme/engine-x', permissions: [{ key: 'x:send-digests', description: 'send', holder: 'system' as const }] } };
  assert.deepEqual([...reservedKeysOf([assistant, digests]).keys()], ['assistant:run', 'x:send-digests']);
});

test('…so a key nobody marks is not reserved, assistant:run included', () => {
  const unmarked = { manifest: { id: '@acme/engine-y', permissions: [{ key: 'assistant:run', description: 'drive a run' }] } };
  const keys = reservedKeysOf([unmarked]);
  assert.equal(keys.size, 0);
  assert.deepEqual(offences({ roles: [{ key: 'member', permissions: ['assistant:run'] }] }, keys), []);
});

test('one module marking a key reserves it, whatever another module declaring it says', () => {
  const redeclared = { manifest: { id: '@acme/vertical', permissions: [{ key: 'assistant:run', description: 'mine now' }] } };
  for (const modules of [[assistant, redeclared], [redeclared, assistant]]) {
    const keys = reservedKeysOf(modules);
    assert.deepEqual(keys.get('assistant:run')?.declaredBy, ['@substrat-run/engine-assistant']);
    assert.deepEqual(offences({ roles: [{ key: 'member', permissions: ['assistant:run'] }] }, keys), [
      { where: 'role member', key: 'assistant:run' },
    ]);
  }
});

// End to end: the tool itself, on a fixture vertical, so the wiring is held and not only the function.
const fixtureWith = (modules: string, roles: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'reserved-keys-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', type: 'module', substrat: { permissions: 'src/p.mjs' } }),
  );
  writeFileSync(
    join(dir, 'src/p.mjs'),
    `${modules}\nexport const permissions = { entityGrants: [], roles: ${JSON.stringify(roles)}, modules };`,
  );
  return dir;
};
const modulesOf = (manifests: unknown[]) => `const modules = ${JSON.stringify(manifests.map((manifest) => ({ manifest })))};`;
/** A fixture whose one module is engine-assistant's manifest as above: assistant:run declared holder: system. */
const fixture = (roles: unknown, schedules: unknown = []) => fixtureWith(modulesOf([{ ...assistant.manifest, schedules }]), roles);
const run = (dir: string) =>
  spawnSync('pnpm', ['exec', 'tsx', 'tools/permission-diff.mts', '--root', dir], { encoding: 'utf8' });
const rendered = (dir: string) => readFileSync(join(dir, 'PERMISSIONS.md'), 'utf8');

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

test('…and passes a system-held role with the run key, rendering it in its own section and marking the key reserved', () => {
  const dir = fixture([
    { key: 'staff', permissions: ['assistant:use'] },
    { key: 'assistant-host', holder: 'system', permissions: ['assistant:run'] },
  ]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const md = rendered(dir);
  assert.match(md, /System-held roles[\s\S]*assistant-host/);
  // The registry marks the reserved key, so dropping its declaration is a line in the reviewed diff.
  assert.match(md, /\| Key \| Description \| Declared by \| Reserved to a system principal \|\n\| --- \| --- \| --- \| --- \|/);
  assert.match(md, /\| `assistant:run` \| [^\n]* \| `@substrat-run\/engine-assistant` \| yes \|/);
  assert.match(md, /\| `assistant:use` \| [^\n]* \| `@substrat-run\/engine-assistant` \| — \|/);
});

test('…and refuses a system-held role holding a person-grade key', () => {
  const r = run(fixture([{ key: 'assistant-host', holder: 'system', permissions: ['assistant:run', 'assistant:use'] }]));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /system-held role assistant-host → assistant:use/);
});

test('a system-held role holding no reserved key is an offence, not a vacuous pass', () => {
  const o = offences({ roles: [{ key: 'x', holder: 'system', permissions: [] }] });
  assert.deepEqual(o, [{ where: 'system-held role x', key: '(none)', notReserved: true, empty: true }]);
});

test('the message header follows the offence kind, and the remedy is not circular', () => {
  const m = reservedKeyMessage('demos/x', 'src/p.ts', [{ where: 'system-held role h', key: 'assistant:use', notReserved: true }], reserved);
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
  assert.doesNotMatch(rendered(dir), /\(system\)/);
});

// A second key, declared by another engine: the manifest is the whole change.
const digestsEngine = (reserve: boolean) =>
  modulesOf([
    {
      id: '@acme/engine-digests',
      permissions: [
        { key: 'digests:read', description: 'read your digests' },
        { key: 'digests:send', description: 'send every subscriber their digest', ...(reserve ? { holder: 'system' } : {}) },
      ],
    },
  ]);

test('a manifest declaring holder: system on a new key: a role granting it exits 2, naming the declaring module', () => {
  const r = run(fixtureWith(digestsEngine(true), [{ key: 'member', permissions: ['digests:read', 'digests:send'] }]));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /role member → digests:send: declared `holder: 'system'` by @acme\/engine-digests/);
});

test('…its twin: the same key unmarked passes in a role, and the registry has no reservation column', () => {
  const dir = fixtureWith(digestsEngine(false), [{ key: 'member', permissions: ['digests:read', 'digests:send'] }]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  // Nothing reserved, so the artifact reads as every vertical's did before the column.
  assert.match(rendered(dir), /\| Key \| Description \| Declared by \|\n/);
  assert.doesNotMatch(rendered(dir), /Reserved to a system principal/);
});

// Emitter to readers: what the tool writes is what `substrat plan`'s classifier and model-view's
// reader (plan's table, concept.md, the console) read back, column included. No checked-in
// artifact carries the column yet, so nothing else feeds one to them.
test('the emitted registry round-trips through both readers, a multi-line description included', () => {
  const emit = (reserve: boolean) => {
    const dir = fixtureWith(
      modulesOf([
        {
          ...assistant.manifest,
          permissions: [
            { key: 'assistant:use', description: 'Open threads,\nread your own' },
            { key: 'assistant:run', description: 'drive a run', ...(reserve ? { holder: 'system' } : {}) },
          ],
          schedules: [{ operation: 'assistant/sweep', permissions: ['assistant:run'] }],
        },
      ]),
      [{ key: 'member', permissions: ['assistant:use'] }],
    );
    assert.equal(run(dir).status, 0);
    return rendered(dir);
  };
  const marked = emit(true);
  const view = permissionsView(marked);
  assert.equal(view.registryUnreadable, undefined);
  assert.deepEqual([...view.reserved], ['assistant:run']);
  // The newline is flattened, so the row keeps its reservation cell where the readers look.
  assert.equal(view.descriptions.get('assistant:use'), 'Open threads, read your own');
  assert.equal(snapshotOf(marked).registryUnreadable, undefined);
  assert.equal(snapshotOf(marked).registry['assistant:run']?.reserved, true);
  assert.equal(classifyPermissions(marked, marked).bump, 'none');
  // And the two directions, emitted rather than hand-written.
  const unreserved = emit(false);
  assert.deepEqual([...permissionsView(unreserved).reserved], []);
  const widened = classifyPermissions(marked, unreserved);
  assert.equal(widened.bump, 'minor');
  assert.deepEqual(
    widened.changes.map((c) => [c.path, c.flagged, /widening/.test(c.detail)]),
    [['key assistant:run', true, true]],
  );
  assert.ok(classifyPermissions(unreserved, marked).changes.some((c) => c.flagged && /narrowing/.test(c.detail)));
});

// §2a, emitted and read back (#2429): both readers read the system-held role apart from the person
// roles, and §2a's own header is never a role named `Role`. engine-notifications' built manifest, so
// the reserved key is the producer's.
const realNotifications = `import { notificationsManifest } from ${JSON.stringify(
  pathToFileURL(join(repoRoot(import.meta.url), 'engines/notifications/dist/index.js')).href,
)};\nconst modules = [{ manifest: notificationsManifest }];`;

test('a system-held role round-trips through both readers apart from the person roles', () => {
  const emit = (roles: unknown) => {
    const dir = fixtureWith(realNotifications, roles);
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    return rendered(dir);
  };
  const member = { key: 'member', permissions: ['notifications:self'] };
  const md = emit([member, { key: 'digest-host', holder: 'system', permissions: ['notifications:send-digests'] }]);
  assert.match(md, /^### 2a\. System-held roles/m);
  const view = permissionsView(md);
  assert.deepEqual(view.roles, [{ role: 'member', keys: ['notifications:self'] }]);
  assert.deepEqual(view.systemRoles, [{ role: 'digest-host', keys: ['notifications:send-digests'] }]);
  assert.deepEqual([...view.reserved], ['notifications:send-digests']);
  const snap = snapshotOf(md);
  assert.deepEqual(snap.roles, { member: ['notifications:self'] });
  assert.deepEqual(snap.systemRoles, { 'digest-host': ['notifications:send-digests'] });
  assert.deepEqual(snap.unread, {});
  assert.equal(classifyPermissions(md, md).bump, 'none');
  // The system-held role arriving is that one flagged widening, never "role Role added".
  const arrived = classifyPermissions(emit([member]), md);
  assert.deepEqual(
    arrived.changes.map((c) => [c.path, c.flagged, c.detail]),
    [['system-held role digest-host', true, 'added (holds: notifications:send-digests) — widening']],
  );
});

// Against the producer: engine-assistant's own built manifest, not a copy of it. If the engine
// stops declaring the run key reserved, this goes red here as well as in its own suite.
const realAssistant = `import { assistantManifest } from ${JSON.stringify(
  pathToFileURL(join(repoRoot(import.meta.url), 'engines/assistant/dist/index.js')).href,
)};\nconst modules = [{ manifest: assistantManifest }];`;

test('the real engine-assistant manifest reserves assistant:run: a role granting it exits 2', () => {
  const r = run(fixtureWith(realAssistant, [{ key: 'member', permissions: ['assistant:use', 'assistant:run'] }]));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /role member → assistant:run: declared `holder: 'system'` by @substrat-run\/engine-assistant/);
});

test('…and passes the same vertical with the run key in a system-held role', () => {
  const r = run(
    fixtureWith(realAssistant, [
      { key: 'member', permissions: ['assistant:use'] },
      { key: 'assistant-host', holder: 'system', permissions: ['assistant:run'] },
    ]),
  );
  assert.equal(r.status, 0, r.stderr);
});
