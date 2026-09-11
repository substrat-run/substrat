import { describe, expect, it } from 'vitest';
import { domainEvent, drainedEvent } from '../src/events.js';

/**
 * The schema a drain publishes (#1334). It exists to carry two facts the envelope
 * deliberately does not — the emitting operation as a NULLABLE column, and the
 * version the host ran as — and it was first written as an intersection with
 * `domainEvent`, which made the null it exists for unrepresentable: an intersection
 * demands a value satisfy both sides, and `domainEvent.operation` is
 * `z.string().min(1).optional()`, which no null passes.
 */
const base = {
  id: '01J0000000000000000000000A',
  type: 'test.happened',
  schemaVersion: 1,
  occurredAt: '2026-09-11T10:00:00.000Z',
  tenantId: '01J0000000000000000000000D',
  scopeId: '01J0000000000000000000000B',
  actor: '01J0000000000000000000000C',
  entity: { entityType: 'thing', entityId: 'x1' },
  piiClass: 'none' as const,
  payload: { hello: 'world' },
};

describe('drainedEvent', () => {
  it('parses a null operation — the case it exists for', () => {
    // Two facts the spine cannot separate afterwards: a CONSUMER emitted this (no
    // operation ran), or the row predates the column. Both adapters return null for
    // them, so a schema that rejects it rejects real rows.
    const parsed = drainedEvent.parse({ ...base, operation: null, version: null });
    expect(parsed.operation).toBeNull();
    expect(parsed.version).toBeNull();
  });

  it('parses a stamped operation and version too', () => {
    const parsed = drainedEvent.parse({ ...base, operation: 'test/emit-event', version: 'v-7' });
    expect(parsed.operation).toBe('test/emit-event');
    expect(parsed.version).toBe('v-7');
  });

  it('keeps the envelope’s PII rule — a classified event must name its subject', () => {
    // The reason the first attempt reached for an intersection at all: `domainEvent`
    // carries a refinement, and rebuilding the shape must not drop it. Losing it
    // would let personal data into the lake with no key an erasure could follow.
    expect(() =>
      drainedEvent.parse({ ...base, piiClass: 'direct', operation: null, version: null }),
    ).toThrow(/subjectId is required/);
    expect(
      drainedEvent.parse({
        ...base,
        piiClass: 'direct',
        subjectId: '01J0000000000000000000000E',
        operation: null,
        version: null,
      }).subjectId,
    ).toBe('01J0000000000000000000000E');
  });

  it('refuses an empty operation or version — null is how absence is spelled', () => {
    // The drain WIDENS `operation` from absent to null; widening past that would
    // admit `''`, which is neither a fact about the event nor a value anything can
    // group by, and which `domainEvent` has always rejected.
    expect(() => drainedEvent.parse({ ...base, operation: '', version: null })).toThrow();
    expect(() => drainedEvent.parse({ ...base, operation: null, version: '' })).toThrow();
  });

  it('leaves the envelope itself unchanged — operation stays optional there', () => {
    // `domainEvent` is the shape as it ENTERS the spine, where an operation is
    // absent rather than null. The two schemas disagree on this field on purpose,
    // which is exactly why neither can be built from the other by extension.
    expect(domainEvent.parse(base).operation).toBeUndefined();
    expect(() => domainEvent.parse({ ...base, operation: null })).toThrow();
  });
});
