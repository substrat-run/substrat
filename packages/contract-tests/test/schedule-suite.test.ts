/**
 * #1591: the schedule suite's assertion was about the whole control plane, and the
 * fix narrows it to one scope. A narrowing that drops too much is the failure mode —
 * a filter that drops everything passes every run — so the filter is pinned directly:
 * it keeps this scope's errors in both spellings and drops everyone else's.
 */
import { describe, expect, it } from 'vitest';
import { errorsOfScope } from '../src/schedule-suite.js';

const mine = '01AAAAAAAAAAAAAAAAAAAAAAAA';
const other = '01BBBBBBBBBBBBBBBBBBBBBBBB';
const err = (id: string) => ({ kind: 'schedule', id, error: 'boom' });

describe('errorsOfScope', () => {
  it('keeps the scope-and-operation spelling of the schedule phase', () => {
    expect(errorsOfScope([err(`${mine}:sched/tick`)], mine)).toHaveLength(1);
  });

  it('keeps the bare-scope spelling of the per-scope phases', () => {
    expect(errorsOfScope([{ kind: 'freshness', id: mine, error: 'boom' }], mine)).toHaveLength(1);
  });

  it('drops every other scope, in both spellings', () => {
    expect(errorsOfScope([err(`${other}:sched/tick`), err(other)], mine)).toEqual([]);
  });

  it('does not match on a shared prefix', () => {
    expect(errorsOfScope([err(`${mine}X:sched/tick`), err(`${mine}X`)], mine)).toEqual([]);
  });

  it('keeps a scope error that sits among foreign ones', () => {
    const own = err(`${mine}:sched/tick`);
    expect(errorsOfScope([err(other), own, err(`${other}:sched/tick`)], mine)).toEqual([own]);
  });
});
