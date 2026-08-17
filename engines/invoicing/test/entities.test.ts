/**
 * The registry and the migration journal are two descriptions of one schema.
 *
 * Migration 0002 rebuilds `invoicing_lines`: it creates `invoicing_lines_new`,
 * copies, drops the original and renames. `journalColumns` follows `RENAME TO`
 * for exactly this — the three hand-rolled parsers this replaced did not, and
 * would have reported the pre-rebuild columns forever.
 */
import { describe, expect, it } from 'vitest';
import { journalColumns } from '@substrat-run/model-emit';
import { invoicingEntities, underlagLine } from '../src/entities.js';
import { invoicingModule } from '../src/index.js';

const journal = journalColumns((invoicingModule.migrations ?? []).map((m) => m.sql).join('\n'));

describe('the registry agrees with the migration journal', () => {
  it('parsed the journal at all', () => {
    expect(journal.size).toBeGreaterThan(0);
    expect(journal.get('invoicing_underlag')?.size).toBeGreaterThan(1);
  });

  for (const [name, entity] of Object.entries(invoicingEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('follows the 0002 rebuild: lines live under the renamed table', () => {
    // The temporary name must be gone, and the real one must carry the NEW
    // columns — document_type/document_id, which 0001's table never had.
    expect(journal.has('invoicing_lines_new')).toBe(false);
    expect(Object.keys(underlagLine.shape).sort()).toEqual([...(journal.get('invoicing_lines') ?? [])].sort());
  });

  it('describes only what the platform can point at', () => {
    // One entity, two tables: lines are rows this engine owns and totals.
    expect(Object.keys(invoicingEntities)).toEqual(['underlag']);
  });

  it('declares no parents — the customer ref is the vertical’s noun', () => {
    expect('parents' in invoicingEntities.underlag).toBe(false);
  });
});
