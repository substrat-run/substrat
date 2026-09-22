import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_CALL_DATA_POINT_LAYOUT,
  CONNECTOR_CALL_ERROR_TYPES,
  connectorCallDataPoint,
  connectorCallRecord,
  settleConnectionUse,
} from '../src/connector-calls.js';

/**
 * The connector-call data point's published shape (#1691): OpenTelemetry attribute names
 * at fixed Analytics Engine ordinals. The read indexes by ordinal and an OTLP exporter
 * maps by name, so a reorder or a rename must go red here before it reaches either.
 */
describe('connector-call data point — OTel names ↔ ordinals (#1691)', () => {
  it('pins every ordinal to its OTel name, unit and absent value — grow-only', () => {
    expect(CONNECTOR_CALL_DATA_POINT_LAYOUT).toEqual({
      indexes: [{ ordinal: 'index1', name: 'substrat.tenant.id', unit: null, absent: null }],
      blobs: [
        { ordinal: 'blob1', name: 'substrat.connection.provider', unit: null, absent: null },
        { ordinal: 'blob2', name: 'substrat.vertical', unit: null, absent: null },
        { ordinal: 'blob3', name: 'error.type', unit: null, absent: '' },
      ],
      doubles: [
        { ordinal: 'double1', name: 'http.client.request.duration', unit: 's', absent: -1 },
        { ordinal: 'double2', name: 'http.response.status_code', unit: null, absent: 0 },
      ],
    });
  });

  it('pins the closed error.type enum', () => {
    expect(CONNECTOR_CALL_ERROR_TYPES).toEqual(['4xx', '5xx', 'other_status', 'timeout', 'network', '_OTHER']);
  });

  const row = { tenantId: '01TENANT', vertical: 'callout', provider: 'fortnox' };

  it('a failed, timed call lands each attribute at its ordinal, duration in seconds', () => {
    const record = connectorCallRecord(row, settleConnectionUse('fortnox', 1234, { response: { ok: false, status: 503 } }));
    expect(record).toEqual({
      'substrat.tenant.id': '01TENANT',
      'substrat.vertical': 'callout',
      'substrat.connection.provider': 'fortnox',
      'error.type': '5xx',
      'http.response.status_code': 503,
      'http.client.request.duration': 1.234,
    });
    expect(connectorCallDataPoint(record)).toEqual({
      indexes: ['01TENANT'],
      blobs: ['fortnox', 'callout', '5xx'],
      doubles: [1.234, 503],
    });
  });

  it('a success sets no error.type — written as the empty blob, never "ok"', () => {
    const record = connectorCallRecord(row, settleConnectionUse('fortnox', 50, { response: { ok: true, status: 200 } }));
    expect('error.type' in record).toBe(false);
    expect(connectorCallDataPoint(record).blobs[2]).toBe('');
  });

  it('an untimed, statusless settlement writes the absent values: -1 duration, 0 status, _OTHER', () => {
    const record = connectorCallRecord(row, { ok: false, error: 'provider refused' });
    expect(record).toEqual({
      'substrat.tenant.id': '01TENANT',
      'substrat.vertical': 'callout',
      'substrat.connection.provider': 'fortnox',
      'error.type': '_OTHER',
    });
    expect(connectorCallDataPoint(record).doubles).toEqual([-1, 0]);
  });

  it('carries no server.address, url.* or any name outside the layout', () => {
    const record = connectorCallRecord(
      row,
      settleConnectionUse('fortnox', 10, { error: new Error('GET https://api.invalid/x?access_token=LIVE failed') }),
    );
    const named = new Set(
      [...CONNECTOR_CALL_DATA_POINT_LAYOUT.indexes, ...CONNECTOR_CALL_DATA_POINT_LAYOUT.blobs, ...CONNECTOR_CALL_DATA_POINT_LAYOUT.doubles].map(
        (f) => f.name as string,
      ),
    );
    for (const key of Object.keys(record)) expect(named.has(key)).toBe(true);
    expect(JSON.stringify(record)).not.toMatch(/access_token|api\.invalid|LIVE/);
  });
});
