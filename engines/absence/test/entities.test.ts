/**
 * The registry and the migration journal are two descriptions of one schema.
 * `journalColumns` is shared (contracts) — three engines had drifting copies.
 */
import { describe, expect, it } from 'vitest';
import { journalColumns } from '@substrat-run/model-emit';
import { absenceEntities } from '../src/entities.js';
import { absenceModule } from '../src/index.js';

const journal = journalColumns((absenceModule.migrations ?? []).map((m) => m.sql).join('\n'));

describe('the registry agrees with the migration journal', () => {
  it('parsed the journal at all', () => {
    expect(journal.size).toBeGreaterThan(0);
    expect(journal.get('absence_leave_types')?.size).toBeGreaterThan(1);
  });

  for (const [name, entity] of Object.entries(absenceEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('describes only what the platform can point at', () => {
    // Three tables, one entity: the ledger and the requests are rows this
    // engine owns — an accrual is not something a grant narrows to.
    expect(Object.keys(absenceEntities)).toEqual(['leave-type']);
  });
});
