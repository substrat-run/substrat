import { describe, expect, it } from 'vitest';
import {
  decodeInvocationRecord,
  encodeInvocationRecord,
  INVOCATION_RECORD_FIELD_MAX,
  invocationLevelOf,
  parentRequestIdOf,
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

describe('parent request id (#2192)', () => {
  const id = '01JABCDEFGHJKMNPQRSTVWXYZ0';

  it('passes exactly one ULID on', () => {
    expect(parentRequestIdOf(id)).toBe(id);
  });

  it('drops anything else whole: a repeated header, an oversized, lowercased or padded value, a non-string', () => {
    expect(parentRequestIdOf(`${id}, ${id}`)).toBeUndefined();
    expect(parentRequestIdOf(`${id}0`)).toBeUndefined();
    expect(parentRequestIdOf(id.toLowerCase())).toBeUndefined();
    expect(parentRequestIdOf(` ${id}`)).toBeUndefined();
    expect(parentRequestIdOf('x'.repeat(10_000))).toBeUndefined();
    expect(parentRequestIdOf('')).toBeUndefined();
    expect(parentRequestIdOf(null)).toBeUndefined();
    expect(parentRequestIdOf(42)).toBeUndefined();
  });
});
