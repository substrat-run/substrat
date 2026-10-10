import { describe, expect, it } from 'vitest';
import { CONNECTOR_CALL_ERROR_TYPES, connectorCallRecord, settleConnectionUse } from '../src/connector-calls.js';

/**
 * The connector-call record (#1691): OpenTelemetry attribute names, an identity read off the
 * row, and a closed error enum. Where each name lands in an Analytics Engine data point is
 * the hosted adapter's half, pinned in its `connector-call-data-point.test.ts`.
 */
describe('connector-call record — OTel names (#1691)', () => {
  it('pins the closed error.type enum', () => {
    expect(CONNECTOR_CALL_ERROR_TYPES).toEqual(['4xx', '5xx', 'other_status', 'timeout', 'network', '_OTHER']);
  });

  const row = { tenantId: '01TENANT', vertical: 'callout', provider: 'fortnox' };

  it('a failed, timed call carries each attribute, duration in seconds', () => {
    const record = connectorCallRecord(row, settleConnectionUse('fortnox', 1234, { response: { ok: false, status: 503 } }));
    expect(record).toEqual({
      'substrat.tenant.id': '01TENANT',
      'substrat.vertical': 'callout',
      'substrat.connection.provider': 'fortnox',
      'error.type': '5xx',
      'http.response.status_code': 503,
      'http.client.request.duration': 1.234,
    });
  });

  it('a success sets no error.type, never "ok"', () => {
    const record = connectorCallRecord(row, settleConnectionUse('fortnox', 50, { response: { ok: true, status: 200 } }));
    expect('error.type' in record).toBe(false);
  });

  it('carries no server.address and no url.*', () => {
    const record = connectorCallRecord(
      row,
      settleConnectionUse('fortnox', 10, { error: new Error('GET https://api.invalid/x?access_token=LIVE failed') }),
    );
    expect(Object.keys(record).sort()).toEqual([
      'error.type',
      'http.client.request.duration',
      'substrat.connection.provider',
      'substrat.tenant.id',
      'substrat.vertical',
    ]);
    expect(JSON.stringify(record)).not.toMatch(/access_token|api\.invalid|LIVE/);
  });
});
