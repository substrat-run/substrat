import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ulid } from '@substrat-run/kernel';
import { ControlPlaneDO, type SweepRunRow } from '../src/control-plane-do.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1572, Durable Object half: `_substrat_sweep_runs_intent` gains `kind` on a directory
 * DO that ALREADY HAS the old `(request_id, unit)` index — which is production, where
 * the directory DO has been constructed many times before this code ever runs.
 *
 * `DIRECTORY_DDL` says `CREATE UNIQUE INDEX IF NOT EXISTS`, which matches on the name, so
 * changing its column list reaches a fresh DO and no existing one. A test that starts
 * from a fresh DO passes either way; every case here starts from one carrying the old
 * index, staged by constructing a SECOND `ControlPlaneDO` over storage the first one
 * built and then put back — new code, old storage, which is what a deploy is.
 */

/** The index as `origin/main` created it before #1572, byte for byte. */
const LEGACY_INDEX =
  'CREATE UNIQUE INDEX IF NOT EXISTS _substrat_sweep_runs_intent ON _substrat_sweep_runs (request_id, unit)';

/** Unique on (request_id, unit), including two NULL request ids on one unit. */
const LEGACY_ROWS = [
  ['01JLEGACYROWAAAAAAAAAAAAA1', 'schedule', 'scope-1:acme/tick', 'ok', '01JLEGACYINTENTAAAAAAAAAAA'],
  ['01JLEGACYROWAAAAAAAAAAAAA2', 'schedule', 'scope-1:acme/rest', 'skipped', '01JLEGACYINTENTAAAAAAAAAAA'],
  ['01JLEGACYROWAAAAAAAAAAAAA3', 'connector', 'conn-1', 'ok', null],
  ['01JLEGACYROWAAAAAAAAAAAAA4', 'connector', 'conn-1', 'failed', null],
] as const;

const row = (over: Partial<SweepRunRow> & Pick<SweepRunRow, 'kind' | 'unit' | 'outcome'>): SweepRunRow => ({
  id: ulid(),
  tenant_id: null,
  scope_id: null,
  vertical: null,
  version: null,
  operation: null,
  connection_id: null,
  error: null,
  elapsed_ms: null,
  request_id: null,
  event_type: null,
  observed_at: null,
  at: new Date().toISOString(),
  ...over,
});

describe('#1572: a directory DO carrying the (request_id, unit) index', () => {
  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
  });

  /** A directory DO built by this code, with the previous release's index put back. */
  const legacyDirectory = async () => {
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`sweep-intent-${ulid()}`));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('DROP INDEX _substrat_sweep_runs_intent');
      state.storage.sql.exec(LEGACY_INDEX);
      for (const r of LEGACY_ROWS) {
        state.storage.sql.exec(
          'INSERT INTO _substrat_sweep_runs (id, kind, unit, outcome, request_id, at) VALUES (?, ?, ?, ?, ?, ?)',
          ...r,
          '2099-01-01T00:00:00.000Z',
        );
      }
    });
    return stub;
  };

  const indexColumns = (state: DurableObjectState) =>
    (
      state.storage.sql
        .exec("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = '_substrat_sweep_runs_intent'")
        .toArray()[0] as { sql: string } | undefined
    )?.sql
      .replace(/^[^(]*\(/, '')
      .replace(/\)\s*$/, '')
      .split(',')
      .map((c) => c.trim());
  const storedRows = (state: DurableObjectState) =>
    state.storage.sql.exec('SELECT id, kind, unit, outcome, request_id, at FROM _substrat_sweep_runs ORDER BY id').toArray();

  it('is staged for real: the old index is in place and swallows the second kind', async () => {
    // The negative control: a staging step that quietly failed would leave the new index
    // in place, and every case below would pass against the wrong store.
    const stub = await legacyDirectory();
    const { columns, written } = await runInDurableObject(stub, (_instance, state) => ({
      columns: indexColumns(state),
      written: state.storage.sql.exec(
        `INSERT OR IGNORE INTO _substrat_sweep_runs (id, kind, unit, outcome, request_id, at)
         VALUES ('01JSWALLOWEDAAAAAAAAAAAAAA', 'freshness', 'scope-1:acme/tick', 'failed', '01JLEGACYINTENTAAAAAAAAAAA', '2099-01-01T00:00:00.000Z')`,
      ).rowsWritten,
    }));
    expect(columns).toEqual(['request_id', 'unit']);
    // The bug: a different kind, dropped on (request_id, unit), and no error.
    expect(written).toBe(0);
  });

  it('is rebuilt with kind on construction, keeps every row, and is a no-op on the construction after', async () => {
    const stub = await legacyDirectory();
    const seen = await runInDurableObject(stub, (_instance, state) => {
      const before = storedRows(state);
      const out: { columns: string[] | undefined; rows: unknown[] }[] = [];
      for (let construction = 1; construction <= 2; construction += 1) {
        new ControlPlaneDO(state, env);
        out.push({ columns: indexColumns(state), rows: storedRows(state) });
      }
      return { before, out };
    });
    expect(seen.before).toHaveLength(LEGACY_ROWS.length);
    for (const { columns, rows } of seen.out) {
      expect(columns).toEqual(['request_id', 'kind', 'unit']);
      expect(rows).toEqual(seen.before);
    }
  });

  it('then keeps a schedule and a freshness row of one batch on one unit — and still refuses a true duplicate', async () => {
    const stub = await legacyDirectory();
    const counts = await runInDurableObject(stub, (_instance, state) => {
      const cp = new ControlPlaneDO(state, env);
      const unit = 'scope-1:orders.placed';
      const request_id = '01JUPGRADEDINTENTAAAAAAAAA';
      const schedule = () =>
        cp.recordSweepRun(row({ kind: 'schedule', unit, outcome: 'skipped', operation: 'orders.placed', request_id }));
      const freshness = () =>
        cp.recordSweepRun(row({ kind: 'freshness', unit, outcome: 'failed', event_type: 'orders.placed', request_id }));
      schedule();
      freshness();
      const kinds = cp.listSweepRuns({ unit }).map((r) => r.kind).sort();
      // The positive twin, on the migrated index — including a row the OLD index let in.
      schedule();
      freshness();
      cp.recordSweepRun(
        row({ kind: 'schedule', unit: 'scope-1:acme/tick', outcome: 'ok', request_id: '01JLEGACYINTENTAAAAAAAAAAA' }),
      );
      return {
        kinds,
        afterReplay: cp.listSweepRuns({ unit }).length,
        legacyUnit: cp.listSweepRuns({ unit: 'scope-1:acme/tick' }).length,
      };
    });
    expect(counts.kinds).toEqual(['freshness', 'schedule']);
    expect(counts.afterReplay).toBe(2);
    expect(counts.legacyUnit).toBe(1);
  });
});
