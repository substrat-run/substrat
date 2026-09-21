import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SWEEP_RUNS_INTENT_INDEX, sweepRunsIntentHasKind } from '../src/index.js';

/**
 * #1572: the detection both adapters run on the stored index DDL. It reads what SQLite
 * actually stores in `sqlite_master.sql` — which drops `IF NOT EXISTS` and keeps the
 * author's whitespace — so each case is executed into a real table and read back
 * rather than handed to the function as a literal.
 */
const stored = (createIndex: string): string => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE _substrat_sweep_runs (request_id TEXT, kind TEXT, unit TEXT, kind_x TEXT)');
    db.exec(createIndex);
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = '_substrat_sweep_runs_intent'")
      .get() as { sql: string };
    return row.sql;
  } finally {
    db.close();
  }
};

describe('sweepRunsIntentHasKind (#1572)', () => {
  it('reads the shipped index as current', () => {
    expect(sweepRunsIntentHasKind(stored(SWEEP_RUNS_INTENT_INDEX))).toBe(true);
  });

  it('reads the pre-#1572 index as due for a rebuild — the shape every existing directory holds', () => {
    const legacy =
      'CREATE UNIQUE INDEX IF NOT EXISTS _substrat_sweep_runs_intent ON _substrat_sweep_runs (request_id, unit)';
    expect(sweepRunsIntentHasKind(stored(legacy))).toBe(false);
  });

  it('judges the column list, not the spelling around it', () => {
    expect(
      sweepRunsIntentHasKind(
        stored('CREATE UNIQUE INDEX _substrat_sweep_runs_intent\n  ON _substrat_sweep_runs (\n  request_id,\n  kind,\n  unit\n)'),
      ),
    ).toBe(true);
    // A column that merely CONTAINS the word is not the column.
    expect(
      sweepRunsIntentHasKind(stored('CREATE UNIQUE INDEX _substrat_sweep_runs_intent ON _substrat_sweep_runs (request_id, kind_x, unit)')),
    ).toBe(false);
  });
});
