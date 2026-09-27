// tsx --test tools/schedule-sweeper.test.mts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployables, offense, type ScheduleRef } from './schedule-sweeper.mts';

const SWEEPER_WORKER = `
export const ScopeDO = defineScopeDO(MODULES, {});
export const SweeperDO = defineScopeSweeperDO<Env>({
  intervalMs: 120_000,
  host: hostFor,
});
`;
const NO_SWEEPER_WORKER = `
export const ScopeDO = defineScopeDO(MODULES, {});
`;
const SCHEDULES: ScheduleRef[] = [
  { moduleId: '@substrat-run/demo-todo', operation: 'todo/reap-abandoned' },
];

test('a vertical with schedules and no SweeperDO export is refused, naming the module and schedule', () => {
  const why = offense(SCHEDULES, NO_SWEEPER_WORKER);
  assert.ok(why, 'expected a refusal');
  assert.match(why!, /@substrat-run\/demo-todo/);
  assert.match(why!, /todo\/reap-abandoned/);
  assert.match(why!, /defineScopeSweeperDO/);
});

test('its twin — schedules plus a sweeper — passes', () => {
  assert.equal(offense(SCHEDULES, SWEEPER_WORKER), null);
});

test('a vertical with no schedules and no sweeper passes', () => {
  assert.equal(offense([], NO_SWEEPER_WORKER), null);
});

test('a vertical composing an engine that declares schedules is still caught (no text mentions the schedule)', () => {
  // The worked example from #1646: meridian's own source never says "schedules" — the
  // schedule is declared on engine-absence's manifest and only reaches meridian by being
  // in its MODULES array. This asserts the PREDICATE catches it once the schedule is
  // handed to it, however it was collected — the loading half is proven by the
  // integration test below, which walks the real MODULES array meridian composes.
  const composed: ScheduleRef[] = [{ moduleId: '@substrat-run/engine-absence', operation: 'absence/expire-stale' }];
  const why = offense(composed, NO_SWEEPER_WORKER);
  assert.ok(why);
  assert.match(why!, /engine-absence/);
  assert.match(why!, /absence\/expire-stale/);
});

test('every current deployable vertical loads and wires a sweeper for every schedule it declares', async () => {
  const dirs = deployables();
  assert.ok(dirs.length > 0, 'expected at least one deployable vertical');

  const { existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');

  const offenders: string[] = [];
  for (const { dir, permissionsEntry } of dirs) {
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
    const worker = readFileSync(join(dir, 'src', 'worker.ts'), 'utf8');
    const why = offense(schedules, worker);
    if (why) offenders.push(`${dir}: ${why}`);
  }
  assert.deepEqual(offenders, []);
});
