// tsx --test tools/schedule-sweeper.test.mts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployables, offense, parseExportedSweeperNames, parseWranglerBindingClasses, type ScheduleRef } from './schedule-sweeper.mts';

const SCHEDULES: ScheduleRef[] = [{ moduleId: '@substrat-run/demo-todo', operation: 'todo/reap-abandoned' }];

test('a vertical with schedules and no SweeperDO export is refused, naming the module and schedule', () => {
  const why = offense(SCHEDULES, { exportedNames: [], boundClassNames: [] });
  assert.ok(why, 'expected a refusal');
  assert.match(why!, /@substrat-run\/demo-todo/);
  assert.match(why!, /todo\/reap-abandoned/);
  assert.match(why!, /defineScopeSweeperDO/);
});

test('its twin — schedules plus a bound, exported sweeper — passes', () => {
  assert.equal(offense(SCHEDULES, { exportedNames: ['SweeperDO'], boundClassNames: ['SweeperDO'] }), null);
});

test('a vertical with no schedules and no sweeper passes', () => {
  assert.equal(offense([], { exportedNames: [], boundClassNames: [] }), null);
});

test('a vertical composing an engine that declares schedules is still caught (no text mentions the schedule)', () => {
  // The worked example from #1646: meridian's own source never says "schedules" — the
  // schedule is declared on engine-absence's manifest and only reaches meridian by being
  // in its MODULES array. This asserts the PREDICATE catches it once the schedule is
  // handed to it, however it was collected — the loading half is proven by the
  // integration test below, which walks the real MODULES array meridian composes.
  const composed: ScheduleRef[] = [{ moduleId: '@substrat-run/engine-absence', operation: 'absence/expire-stale' }];
  const why = offense(composed, { exportedNames: [], boundClassNames: [] });
  assert.ok(why);
  assert.match(why!, /engine-absence/);
  assert.match(why!, /absence\/expire-stale/);
});

// #1873 Copilot finding 4117108901: a `defineScopeSweeperDO(...)` call sitting in an
// UNEXPORTED const binds no Durable Object class — workerd resolves one from the entry
// module's exports — so the schedules stay exactly as dead as with no call at all.
test('an exported-but-unbound sweeper is refused, distinctly from a wholly missing one', () => {
  const why = offense(SCHEDULES, { exportedNames: ['SweeperDO'], boundClassNames: ['ScopeDO'] });
  assert.ok(why, 'expected a refusal');
  assert.match(why!, /SweeperDO/);
  assert.match(why!, /never instantiate/);
});

test('parseExportedSweeperNames: a plain unexported const contributes no name', () => {
  const src = "import { defineScopeSweeperDO } from 'x';\nconst SweeperDO = defineScopeSweeperDO({});\n";
  assert.deepEqual(parseExportedSweeperNames(src), []);
});

test('parseExportedSweeperNames: export const, the common form', () => {
  const src = "import { defineScopeSweeperDO } from 'x';\nexport const SweeperDO = defineScopeSweeperDO<Env>({});\n";
  assert.deepEqual(parseExportedSweeperNames(src), ['SweeperDO']);
});

test('parseExportedSweeperNames: a local const re-exported under another name — the ALIAS is what must match a binding', () => {
  const src = [
    "import { defineScopeSweeperDO } from 'x';",
    'const Internal = defineScopeSweeperDO({});',
    'export { Internal as SweeperDO };',
  ].join('\n');
  assert.deepEqual(parseExportedSweeperNames(src), ['SweeperDO']);
});

test('parseExportedSweeperNames: export { X } with no alias', () => {
  const src = ["import { defineScopeSweeperDO } from 'x';", 'const X = defineScopeSweeperDO({});', 'export { X };'].join(
    '\n',
  );
  assert.deepEqual(parseExportedSweeperNames(src), ['X']);
});

test('parseExportedSweeperNames: export class extending the call', () => {
  const src = "import { defineScopeSweeperDO } from 'x';\nexport class SweeperDO extends defineScopeSweeperDO({}) {}\n";
  assert.deepEqual(parseExportedSweeperNames(src), ['SweeperDO']);
});

test('parseExportedSweeperNames: an unrelated export is not mistaken for a sweeper', () => {
  const src = 'export const ScopeDO = defineScopeDO(MODULES, {});\n';
  assert.deepEqual(parseExportedSweeperNames(src), []);
});

test('parseWranglerBindingClasses: reads durable_objects.bindings, JSONC comments and all', () => {
  const src = `{
    // a comment
    "durable_objects": {
      "bindings": [
        { "name": "SCOPE", "class_name": "ScopeDO" },
        { "name": "SWEEPER", "class_name": "SweeperDO" },
      ]
    }
  }`;
  assert.deepEqual(parseWranglerBindingClasses(src).sort(), ['ScopeDO', 'SweeperDO']);
});

test('parseWranglerBindingClasses: a config with no durable_objects block is empty, not a failure', () => {
  assert.deepEqual(parseWranglerBindingClasses('{ "name": "x" }'), []);
});

test('every current deployable vertical loads, and every schedule it declares (composed or not) has an exported, bound sweeper', async () => {
  const dirs = deployables();
  assert.ok(dirs.length > 0, 'expected at least one deployable vertical');

  const { existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  const offenders: string[] = [];
  for (const { dir, permissionsEntry, storeClasses } of dirs) {
    const entryPath = join(dir, permissionsEntry);
    assert.ok(existsSync(entryPath), `${entryPath} should exist for a declared substrat.permissions entry`);
    const mod = (await import(pathToFileURL(entryPath).href)) as {
      permissions?: { modules?: { manifest: { id: string; schedules?: { operation: string }[] } }[] };
    };
    const modules = mod.permissions?.modules;
    assert.ok(modules, `${entryPath} should export a permissions surface with modules`);
    const schedules: ScheduleRef[] = [];
    for (const m of modules!) {
      for (const s of m.manifest.schedules ?? []) schedules.push({ moduleId: m.manifest.id, operation: s.operation });
    }

    const workerPath = join(dir, 'src', 'worker.ts');
    const exportedNames = parseExportedSweeperNames(readFileSync(workerPath, 'utf8'));
    const wranglerPath = join(dir, 'wrangler.jsonc');
    const boundClassNames = existsSync(wranglerPath)
      ? [...storeClasses, ...parseWranglerBindingClasses(readFileSync(wranglerPath, 'utf8'))]
      : [...storeClasses];

    const why = offense(schedules, { exportedNames, boundClassNames });
    if (why) offenders.push(`${dir}: ${why}`);
  }
  assert.deepEqual(offenders, []);
});
