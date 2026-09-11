import { describe, expect, it } from 'vitest';
import { DEFAULT_DENIAL_LIMIT, denialFilter, denialQuery } from '../src/denial.js';

/**
 * The denial filter's wire form (#971). The encoder was copy-pasted into every client
 * that reads the K-35 log, so these cases pin what a call site is entitled to assume:
 * every declared field travels, nothing else does, and an unnarrowed read adds no `?`.
 */
describe('denialQuery', () => {
  it('carries every field the filter declares', () => {
    const filter = denialFilter.parse({
      actor: '01J0ACTOR',
      permission: 'workorder.complete',
      operation: 'workorder/complete',
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-02T00:00:00.000Z',
      limit: DEFAULT_DENIAL_LIMIT,
    });
    const params = new URLSearchParams(denialQuery(filter).slice(1));
    expect(Object.fromEntries(params)).toEqual({
      actor: '01J0ACTOR',
      permission: 'workorder.complete',
      operation: 'workorder/complete',
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-02T00:00:00.000Z',
      limit: String(DEFAULT_DENIAL_LIMIT),
    });
    // Every key the schema knows about is accounted for — a field added to the filter
    // and forgotten here (the drift this helper exists to stop) fails this line.
    expect([...params.keys()].sort()).toEqual(Object.keys(denialFilter.shape).sort());
  });

  it('is empty — not a dangling `?` — when nothing is narrowed', () => {
    expect(denialQuery()).toBe('');
    expect(denialQuery({})).toBe('');
  });

  it('omits the fields that were not set, and escapes the ones that were', () => {
    // The object form of a system/connection actor is stored JSON-stringified, so it
    // reaches the query string with quotes and braces that MUST be percent-encoded.
    expect(denialQuery({ actor: '{"system":"invoicing"}' })).toBe(
      '?actor=%7B%22system%22%3A%22invoicing%22%7D',
    );
  });

  it('stringifies the numeric limit', () => {
    expect(denialQuery({ limit: 25 })).toBe('?limit=25');
  });
});
