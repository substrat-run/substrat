import { describe, expect, it } from 'vitest';
import { repointScopeGrants } from '../src/scope-repoint.js';
import type { SwitchSql } from '../src/system-switch.js';

/** #1869: the kernel's own guard, before any SQL runs. The row behaviour is the contract suite's. */
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
    expect(() => repointScopeGrants(sql, '01JZ0000000000000000SCP001', { scopeId: '', exact: true })).toThrow(
      /`exact` needs the scope the dump came from/,
    );
    expect(ran).toEqual([]);
  });

  it('twin: `exact` with a source runs the exact update', () => {
    const { sql, ran } = recording();
    repointScopeGrants(sql, '01JZ0000000000000000SCP001', { scopeId: '01JZ0000000000000000SCP002', exact: true });
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatch(/object = \? COLLATE BINARY$/);
  });
});
