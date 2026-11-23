import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { tenantId } from '@substrat-run/contracts';
import { COST_ROLLUP_DDL, sumCostDayRows } from '../src/cost-rollup.js';
import type { RedactionSql } from '../src/subject-redaction.js';

/** `sumCostDayRows` (#3316): the priced reads' aggregate over the stored cost rows. */

const T1 = '01J00000000000000000000T01';
const T2 = '01J00000000000000000000T02';

function directory() {
  const db = new DatabaseSync(':memory:');
  db.exec(COST_ROLLUP_DDL);
  // (day, script, scope, object, dimension, attribution, tenant, vertical, kind, quantity)
  const rows: [string, string, string, string, string, string, string | null, string | null, string, string][] = [
    ['2026-11-19', 's', 'S1', 'o1', 'do_rows_written', 'scope', T1, 'acme/crm', 'live', '0.000001'],
    ['2026-11-19', 's', 'S1', 'o2', 'do_rows_written', 'scope', T1, 'acme/crm', 'live', '0.000002'],
    ['2026-11-19', 's', 'S2', 'o3', 'do_rows_written', 'scope', T1, 'acme/crm', 'preview', '5'],
    ['2026-11-19', 's', 'S3', 'o4', 'do_rows_written', 'scope', T2, 'acme/todo', 'live', '7'],
    ['2026-11-19', 's', '', 'o5', 'do_rows_written', 'unmapped', null, 'acme/crm', 'live', '11'],
    ['2026-11-20', 's', 'S1', 'o1', 'do_rows_written', 'scope', T1, 'acme/crm', 'live', '3'],
    ['2026-11-20', 's', 'S2', 'o3', 'do_rows_read', 'scope', T1, 'acme/crm', 'preview', '4'],
    ['2026-11-21', 's', 'S1', 'o1', 'do_rows_written', 'scope', T1, 'acme/crm', 'live', '100'],
  ];
  const insert = db.prepare(
    `INSERT INTO _substrat_cost_days (day, script, scope_id, object_class, object_id, dimension, attribution, tenant_id, vertical, kind, quantity)
     VALUES (?, ?, ?, 'ScopeDO', ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) insert.run(...r);
  const sql: RedactionSql = (q, p) => db.prepare(q).all(...(p as (string | number | null)[]));
  return sql;
}

describe('sumCostDayRows (#3316)', () => {
  it('sums each group exactly, inside the window, and lists the scopes with their kind', () => {
    const { totals, scopes } = sumCostDayRows(directory(), { since: '2026-11-19', until: '2026-11-20' });
    expect(totals).toEqual([
      { day: '2026-11-19', tenantId: null, attribution: 'unmapped', vertical: 'acme/crm', kind: 'live', dimension: 'do_rows_written', quantity: '11' },
      { day: '2026-11-19', tenantId: T1, attribution: 'scope', vertical: 'acme/crm', kind: 'live', dimension: 'do_rows_written', quantity: '0.000003' },
      { day: '2026-11-19', tenantId: T1, attribution: 'scope', vertical: 'acme/crm', kind: 'preview', dimension: 'do_rows_written', quantity: '5' },
      { day: '2026-11-19', tenantId: T2, attribution: 'scope', vertical: 'acme/todo', kind: 'live', dimension: 'do_rows_written', quantity: '7' },
      { day: '2026-11-20', tenantId: T1, attribution: 'scope', vertical: 'acme/crm', kind: 'live', dimension: 'do_rows_written', quantity: '3' },
      { day: '2026-11-20', tenantId: T1, attribution: 'scope', vertical: 'acme/crm', kind: 'preview', dimension: 'do_rows_read', quantity: '4' },
    ]);
    expect(scopes).toEqual([
      { scopeId: 'S1', vertical: 'acme/crm', kind: 'live' },
      { scopeId: 'S2', vertical: 'acme/crm', kind: 'preview' },
      { scopeId: 'S3', vertical: 'acme/todo', kind: 'live' },
    ]);
  });

  it("narrows to one tenant's rows", () => {
    const { totals, scopes } = sumCostDayRows(directory(), { tenantId: tenantId.parse(T2), since: '2026-11-19', until: '2026-11-21' });
    expect(totals.map((t) => [t.tenantId, t.quantity])).toEqual([[T2, '7']]);
    expect(scopes.map((s) => s.scopeId)).toEqual(['S3']);
  });
});
