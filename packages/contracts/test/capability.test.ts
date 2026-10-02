import { describe, expect, it } from 'vitest';
import {
  capabilityFilter,
  capabilityFilterParams,
  capabilityFilterQuery,
  capabilityQuery,
  capabilityRecord,
  capabilityStatus,
} from '../src/capability.js';
import type { Instant } from '../src/ids.js';

/**
 * The operator's capability read, wire and shape (#1686): one encoder, one decoder, and a
 * record that has no field a credential could ride in.
 */
describe('capabilityFilter on the wire', () => {
  const full = capabilityFilter.parse({
    entity: { entityType: 'folder', entityId: 'F1' },
    includeRevoked: true,
    limit: 25,
    cursor: '01JZ0000000000000000CPC001',
  });

  it('round-trips every field the filter declares, through the one encoder and the one decoder', () => {
    const q = Object.fromEntries(capabilityFilterParams(full));
    expect(capabilityFilterQuery.parse(q)).toEqual(full);
    expect(capabilityFilterQuery.parse({})).toEqual({});
    expect(Object.keys(q).sort()).toEqual(['cursor', 'entityId', 'entityType', 'includeRevoked', 'limit']);
  });

  it('an unnarrowed read adds no `?`; a narrowed one carries its params', () => {
    expect(capabilityQuery()).toBe('');
    expect(capabilityQuery({})).toBe('');
    expect(capabilityQuery({ includeRevoked: true })).toBe('?includeRevoked=true');
  });

  it('refuses a half-named entity rather than widening to every capability', () => {
    expect(() => capabilityFilterQuery.parse({ entityType: 'folder' })).toThrow();
    expect(() => capabilityFilterQuery.parse({ entityId: 'F1' })).toThrow();
  });

  it('holds the filter’s own bounds on the wire', () => {
    expect(capabilityFilterQuery.parse({ limit: '200' })).toEqual({ limit: 200 });
    expect(() => capabilityFilterQuery.parse({ limit: '201' })).toThrow();
    expect(() => capabilityFilterQuery.parse({ limit: '0' })).toThrow();
    expect(() => capabilityFilterQuery.parse({ includeRevoked: 'maybe' })).toThrow();
    // A cursor must be a capability id: one that is not is refused, never read as "from the start".
    for (const cursor of ['nope', 'sbcap_x', '01jz0000000000000000cpc001']) {
      expect(() => capabilityFilterQuery.parse({ cursor })).toThrow();
    }
    expect(capabilityFilterQuery.parse({ cursor: '01JZ0000000000000000CPC001' })).toEqual({ cursor: '01JZ0000000000000000CPC001' });
    expect(capabilityFilterQuery.parse({ includeRevoked: 'false' })).toEqual({ includeRevoked: false });
  });
});

describe('capabilityRecord carries no credential', () => {
  it('has no field named for a hash, a secret or a token, in either mode', () => {
    for (const option of capabilityRecord.options) {
      for (const key of Object.keys(option.shape)) expect(key).not.toMatch(/hash|secret|token/i);
    }
  });
});

describe('capabilityStatus', () => {
  const NOW = '2026-10-01T00:00:00.000Z';
  const at = (iso: string) => iso as Instant;
  const base = { revokedAt: null, expiresAt: null, maxUses: null, uses: 0 };

  it('reads each standing, revoked before expired before used-up', () => {
    expect(capabilityStatus(base, NOW)).toBe('live');
    expect(capabilityStatus({ ...base, revokedAt: at(NOW) }, NOW)).toBe('revoked');
    expect(capabilityStatus({ ...base, expiresAt: at(NOW) }, NOW)).toBe('expired');
    expect(capabilityStatus({ ...base, expiresAt: at('2026-10-02T00:00:00.000Z') }, NOW)).toBe('live');
    expect(capabilityStatus({ ...base, maxUses: 2, uses: 2 }, NOW)).toBe('used-up');
    expect(capabilityStatus({ ...base, maxUses: 2, uses: 1 }, NOW)).toBe('live');
    expect(capabilityStatus({ ...base, revokedAt: at(NOW), expiresAt: at(NOW), maxUses: 1, uses: 1 }, NOW)).toBe('revoked');
    expect(capabilityStatus({ ...base, expiresAt: at(NOW), maxUses: 1, uses: 1 }, NOW)).toBe('expired');
  });
});
