import { expect, it } from 'vitest';
import { sortApps } from '../src/lib/name-order';

it('sorts names naturally and case-insensitively with a stable ID tie-breaker without mutating input', () => {
  const apps = [
    { name: 'Tool 10', app_scope_id: 'c' },
    { name: 'alpha', app_scope_id: 'b' },
    { name: 'Alpha', app_scope_id: 'a' },
    { name: 'Tool 2', app_scope_id: 'd' },
  ];
  expect(sortApps(apps).map(a => a.app_scope_id)).toEqual(['a', 'b', 'd', 'c']);
  expect(sortApps([...apps].reverse())).toEqual(sortApps(apps));
  expect(apps[0].app_scope_id).toBe('c');
});
