import { describe, expect, it } from 'vitest';
import {
  decodeInvocationRecord,
  encodeInvocationRecord,
  fieldCoverageSampled,
  fieldCoverageSampleRate,
  INVOCATION_RECORD_FIELD_MAX,
  invocationLevelOf,
} from '../src/invocation-record.js';

describe('invocation record header (#1904)', () => {
  it('round-trips the three fields, including names a raw header could not carry', () => {
    const record = { operation: 'bokning/avboka – återbetala', problemCode: 'conflict', principalKind: 'user' };
    const value = encodeInvocationRecord(record)!;
    expect(value).toMatch(/^[\x20-\x7e]+$/);
    expect(decodeInvocationRecord(value)).toEqual(record);
  });

  it('encodes nothing when the record names nothing', () => {
    expect(encodeInvocationRecord({})).toBeNull();
    expect(encodeInvocationRecord({ operation: '', problemCode: null })).toBeNull();
  });

  it('reads a missing, malformed or oversized value without throwing, and ignores unknown keys', () => {
    const empty = { operation: null, problemCode: null, principalKind: null };
    expect(decodeInvocationRecord(null)).toEqual(empty);
    expect(decodeInvocationRecord('%%%')).toEqual(empty);
    expect(decodeInvocationRecord('tenantId=someone-else')).toEqual(empty);
    const long = decodeInvocationRecord(`operation=${'x'.repeat(1000)}`);
    expect(long.operation).toHaveLength(INVOCATION_RECORD_FIELD_MAX);
  });

  it('files a level from status, throw and problem code', () => {
    expect(invocationLevelOf(200, false)).toBe('info');
    expect(invocationLevelOf(200, false, 'tool-error')).toBe('warn');
    expect(invocationLevelOf(404, false)).toBe('warn');
    expect(invocationLevelOf(503, false)).toBe('error');
    expect(invocationLevelOf(200, true)).toBe('error');
  });
});

describe('field-coverage sampling (#1923)', () => {
  it('reads a decimal rate in (0, 1]', () => {
    expect(fieldCoverageSampleRate('0.01')).toBe(0.01);
    expect(fieldCoverageSampleRate(' 0.5 ')).toBe(0.5);
    expect(fieldCoverageSampleRate('1')).toBe(1);
    expect(fieldCoverageSampleRate(0.25)).toBe(0.25);
  });

  it('reads every doubtful value as off, above one included', () => {
    for (const v of [undefined, null, '', ' ', 'on', 'NaN', NaN, 'Infinity', Infinity, '-0.1', -1, '0', 0, '1.0001', '50', 2, {}, true]) {
      expect(fieldCoverageSampleRate(v), String(v)).toBe(0);
    }
  });

  it('samples by the rate: never at 0, always at 1, and below the draw in between', () => {
    const never = () => {
      throw new Error('drew a number at a rate that cannot sample');
    };
    expect(fieldCoverageSampled(0, never)).toBe(false);
    expect(fieldCoverageSampled(NaN, never)).toBe(false);
    expect(fieldCoverageSampled(1.5, never)).toBe(false);
    expect(fieldCoverageSampled(1, never)).toBe(true);
    expect(fieldCoverageSampled(0.25, () => 0.2499)).toBe(true);
    expect(fieldCoverageSampled(0.25, () => 0.25)).toBe(false);
    expect(fieldCoverageSampled(0.25, () => 0.9)).toBe(false);
  });

  it('samples about the rate over many draws', () => {
    let seed = 7;
    const lcg = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let hits = 0;
    for (let i = 0; i < 20_000; i++) if (fieldCoverageSampled(0.1, lcg)) hits++;
    expect(hits / 20_000).toBeGreaterThan(0.09);
    expect(hits / 20_000).toBeLessThan(0.11);
  });
});
