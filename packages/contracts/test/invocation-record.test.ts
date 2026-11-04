import { describe, expect, it } from 'vitest';
import {
  decodeInvocationRecord,
  encodeInvocationRecord,
  INVOCATION_RECORD_FIELD_MAX,
  invocationLevelOf,
  joinEntityTypes,
  joinProcessStates,
  parentRequestIdOf,
  splitEntityTypes,
} from '../src/invocation-record.js';

describe('invocation record header (#1904)', () => {
  it('round-trips the fields, including names a raw header could not carry', () => {
    const record = { operation: 'bokning/avboka – återbetala', problemCode: 'conflict', principalKind: 'user', entityTypes: 'bokning,kund', route: 'POST /api/bokningar/:id', processStates: 'bokning:avbokad' };
    const value = encodeInvocationRecord(record)!;
    expect(value).toMatch(/^[\x20-\x7e]+$/);
    expect(decodeInvocationRecord(value)).toEqual(record);
  });

  it('encodes nothing when the record names nothing', () => {
    expect(encodeInvocationRecord({})).toBeNull();
    expect(encodeInvocationRecord({ operation: '', problemCode: null })).toBeNull();
  });

  it('reads a missing, malformed or oversized value without throwing, and ignores unknown keys', () => {
    const empty = { operation: null, problemCode: null, principalKind: null, entityTypes: null, route: null, processStates: null };
    expect(decodeInvocationRecord(null)).toEqual(empty);
    expect(decodeInvocationRecord('%%%')).toEqual(empty);
    expect(decodeInvocationRecord('tenantId=someone-else')).toEqual(empty);
    const long = decodeInvocationRecord(`operation=${'x'.repeat(1000)}`);
    expect(long.operation).toHaveLength(INVOCATION_RECORD_FIELD_MAX);
  });

  it('#2762: cuts a set of entity types between two types, never inside one, on both ends of the header', () => {
    const types = Array.from({ length: 30 }, (_, i) => `type${String(i).padStart(2, '0')}`).join(',');
    const encoded = new URLSearchParams(encodeInvocationRecord({ entityTypes: types })!).get('entityTypes')!;
    const decoded = decodeInvocationRecord(`entityTypes=${types}`).entityTypes!;
    for (const cut of [encoded, decoded]) {
      expect(cut.length).toBeLessThanOrEqual(INVOCATION_RECORD_FIELD_MAX);
      expect(types.startsWith(`${cut},`)).toBe(true);
    }
    // One type longer than the cap has no boundary to cut at, so nothing is carried.
    expect(encodeInvocationRecord({ entityTypes: 'x'.repeat(INVOCATION_RECORD_FIELD_MAX + 1) })).toBeNull();
  });

  it('#2762: joins entity types sorted and distinct, without a type holding the separator, and splits them back', () => {
    expect(joinEntityTypes(['visit', 'repair', 'visit', '', 'a,b'])).toBe('repair,visit');
    expect(joinEntityTypes([])).toBeNull();
    expect(joinEntityTypes(['', 'a,b'])).toBeNull();
    expect(splitEntityTypes('repair,visit')).toEqual(['repair', 'visit']);
    expect(splitEntityTypes(null)).toEqual([]);
    expect(splitEntityTypes('')).toEqual([]);
  });

  it('#2762: a process state is a type and the state reached, never an id; a set of them is cut between two', () => {
    expect(
      joinProcessStates([
        { entity: 'ticket:01J:a', to: 'resolved' },
        { entity: 'assignment:01K', to: 'active' },
        { entity: 'ticket:01M', to: 'resolved' },
        { entity: 'noref', to: 'open' },
        { entity: 'a,b:1', to: 'open' },
      ]),
    ).toBe('assignment:active,ticket:resolved');
    expect(joinProcessStates([])).toBeNull();
    const moves = Array.from({ length: 12 }, (_, i) => ({ entity: `type${String(i).padStart(2, '0')}:1`, to: 'state' }));
    const states = joinProcessStates(moves)!;
    const cut = decodeInvocationRecord(new URLSearchParams({ processStates: states }).toString()).processStates!;
    expect(cut.length).toBeLessThanOrEqual(INVOCATION_RECORD_FIELD_MAX);
    expect(states.startsWith(`${cut},`)).toBe(true);
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
