import { describe, expect, it } from 'vitest';
import { tenantLogsQuery } from '../web/src/lib/logs-query.js';

/**
 * The browser client's half of the invocation filter (#1525): `tenantLogsQuery` is where
 * an id becomes a query string, and the one place a truthiness check would turn an empty
 * id — a caller bug the plane answers with a 400 — into the app's whole, unfiltered log.
 */
describe('tenantLogsQuery invocationId (#1525)', () => {
  const CALL = '01J8Z3KX0Q5R7T9V1W2Y4A6B8C';

  it('sends the id', () => {
    expect(tenantLogsQuery({ invocationId: CALL, limit: 100 }).get('invocationId')).toBe(CALL);
  });

  it('sends an EMPTY id as present, so the plane can refuse it rather than answer unfiltered', () => {
    const p = tenantLogsQuery({ invocationId: '' });
    expect(p.has('invocationId')).toBe(true);
    expect(p.get('invocationId')).toBe('');
  });

  it('sends no param at all when there is no id', () => {
    expect(tenantLogsQuery({ hours: 24 }).has('invocationId')).toBe(false);
  });

  it('keeps the other filters as they were: falsy ones are dropped, the window rides along', () => {
    const p = tenantLogsQuery({ level: '', search: '', hours: 24, limit: 100, since: 'a', until: 'b' });
    expect(Object.fromEntries(p)).toEqual({ hours: '24', limit: '100', since: 'a', until: 'b' });
  });
});
