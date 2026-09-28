import { describe, expect, it } from 'vitest';
import { repointScopeGrants } from '../src/scope-repoint.js';
import type { SwitchSql } from '../src/system-switch.js';

/** #1869: the kernel's own guard, before any SQL runs. The row behaviour is the contract suite's. */
const NOW = '2026-09-28T00:00:00.000Z';

describe('repointScopeGrants', () => {
  const recording = () => {
    const ran: string[] = [];
    const sql: SwitchSql = {
      all: (q) => {
        ran.push(q);
        return [{ one: 1 }];
      },
      run: (q) => {
        ran.push(q);
      },
    };
    return { sql, ran };
  };

  it('refuses `exact` with no source scope, and runs nothing', () => {
    const { sql, ran } = recording();
    expect(() => repointScopeGrants(sql, '01JZ0000000000000000SCP001', { scopeId: '', exact: true }, NOW)).toThrow(
      /`exact` needs the scope the dump came from/,
    );
    expect(ran).toEqual([]);
  });

  it('twin: `exact` with a source settles collisions, then runs a plain update (#1882)', () => {
    const { sql, ran } = recording();
    repointScopeGrants(sql, '01JZ0000000000000000SCP001', { scopeId: '01JZ0000000000000000SCP002', exact: true }, NOW);
    expect(ran.map((q) => q.trimStart().split(/\s+/, 1)[0])).toEqual(['DELETE', 'DELETE', 'DELETE', 'UPDATE']);
    // Never `UPDATE OR REPLACE`: a collision the deletes missed must fail the load, not replace a row.
    expect(ran[3]).toMatch(/^UPDATE _substrat_tuples SET object = \? WHERE/);
  });
});
