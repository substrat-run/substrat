import { describe, expect, it } from 'vitest';
import { readFieldCoverage } from '../src/field-coverage-read.js';

const tenant = '01JZ0000000000000000TEN001';
const other = '01JZ0000000000000000TEN002';
const id = '01JZ0000000000000000000001';
const scope = { tenantId: tenant, vertical: 'acme/widgets', services: ['acme-widgets'],
  versionId: '01JZ0000000000000000VER001', declared: { 'acme/get': ['id', 'note', 'optional'] } };
const window = { since: '2026-10-01T00:00:00.000Z', until: '2026-10-02T00:00:00.000Z' };
const report = (over: Record<string, unknown> = {}) => ({ source: { substrat: 'invocation', tenantId: tenant,
  vertical: 'acme/widgets', method: 'GET', operation: 'acme/get', fieldCoverageId: id,
  outputFields: { present: ['id'], empty: ['note'], absent: ['optional'] }, ...over },
  $metadata: { service: 'acme-widgets' } });
const router = (over: Record<string, unknown> = {}, service = 'substrat-router') => ({
  source: { router: 'request', tenantId: tenant, vertical: 'acme/widgets', fieldCoverageId: id,
    fieldCoverageRate: 0.1, ...over }, $metadata: { service },
});

describe('sampled field read (#1331)', () => {
  it('counts one serialisation, excludes absent optional fields, and carries trusted rate and window', () => {
    const answer = readFieldCoverage([report({ fieldCoverageRate: 1 })], [router()], scope, window);
    expect(answer.source).toBe('vertical-asserted');
    expect(answer.groups[0]?.sampleRate).toBe(0.1);
    expect(answer.groups[0]?.operations[0]?.responses).toBe(1);
    expect(answer.groups[0]?.operations[0]?.fields).toEqual([
      { field: 'id', present: 1, empty: 0, absent: 0, eligible: 1, sampleRate: 0.1, window },
      { field: 'note', present: 0, empty: 1, absent: 0, eligible: 1, sampleRate: 0.1, window },
      { field: 'optional', present: 0, empty: 0, absent: 1, eligible: 0, sampleRate: 0.1, window },
    ]);
    expect(answer.groups[0]?.notObservedReturned).toEqual([{ operation: 'acme/get', field: 'optional' }]);
  });

  it('does not read another tenant or app, or an unsigned report with no router dispatch', () => {
    for (const lines of [[router({ tenantId: other })], [router({ vertical: 'other/app' })],
      [router({}, 'acme-widgets')], []]) {
      expect(readFieldCoverage([report()], lines, scope, window).groups).toEqual([]);
    }
    expect(readFieldCoverage([report({ tenantId: other })], [router()], scope, window).groups[0]?.operations[0]?.responses).toBe(0);
  });

  it('distinguishes an unarmed window from an armed window with no valid report', () => {
    expect(readFieldCoverage([], [], scope, window).groups).toEqual([]);
    const armed = readFieldCoverage([], [router()], scope, window);
    expect(armed.groups[0]?.armedRequests).toBe(1);
    expect(armed.groups[0]?.operations[0]?.responses).toBe(0);
  });
});
