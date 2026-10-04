import { afterEach, describe, expect, it, vi } from 'vitest';
import { DECLARED_OUTPUT_FIELDS_MAX } from '@substrat-run/contracts';
import { FIELD_COVERAGE_OPERATIONS_MAX, tallyFieldCoverage } from '../src/field-coverage-tally.js';
import { createCfObservabilityReader } from '../src/cf-observability.js';
import { serviceFamilyMatcher } from '../src/service-family.js';

/**
 * #1923 part (c): `outputFields` is asserted by the vertical, so the one reading of it is
 * tenant-scoped, app-scoped and aggregate-only. Each rule here has its positive twin.
 */

const TENANT = '01JZ0000000000000000TEN001';
const OTHER = '01JZ0000000000000000TEN002';
const SERVICES = ['acme-widgets'];
/** A value no tally may ever contain: a path naming one record. */
const RECORD_PATH = '/api/customers/cust-4c1d-never-in-a-tally';

/** A stamped line as Workers Logs returns it. */
const line = (over: Record<string, unknown> = {}, service = 'acme-widgets') => ({
  timestamp: 1000,
  source: {
    substrat: 'invocation',
    tenantId: TENANT,
    scopeId: '01JZ0000000000000000SCP001',
    vertical: 'acme/widgets',
    method: 'GET',
    path: RECORD_PATH,
    status: 200,
    invocationId: '01JZ0000000000000000INV001',
    operation: 'acme/get-card',
    outputFields: { present: ['id', 'title'], empty: ['note'], absent: ['owner_email'] },
    ...over,
  },
  $metadata: { id: 'ev', requestId: 'req', service },
});

const scope = { tenantId: TENANT, services: SERVICES };

describe('tallyFieldCoverage (#1923)', () => {
  it('counts per (operation, field), one per response', () => {
    const tally = tallyFieldCoverage(
      [
        line(),
        line({ outputFields: { present: ['id', 'title', 'note'], empty: [], absent: ['owner_email'] } }),
        line({ operation: 'acme/list-cards', outputFields: { present: ['id'], empty: [], absent: [] } }),
      ],
      scope,
    );
    expect(tally).toEqual({
      tenantId: TENANT,
      refused: 0,
      operations: [
        {
          operation: 'acme/get-card',
          responses: 2,
          fields: [
            { field: 'id', present: 2, empty: 0, absent: 0 },
            { field: 'title', present: 2, empty: 0, absent: 0 },
            { field: 'note', present: 1, empty: 1, absent: 0 },
            { field: 'owner_email', present: 0, empty: 0, absent: 2 },
          ],
        },
        { operation: 'acme/list-cards', responses: 1, fields: [{ field: 'id', present: 1, empty: 0, absent: 0 }] },
      ],
    });
  });

  it("keeps nothing per request: no path, scope, id, time or the line's own tenant", () => {
    const text = JSON.stringify(tallyFieldCoverage([line(), line()], scope));
    for (const leak of [RECORD_PATH, '01JZ0000000000000000SCP001', '01JZ0000000000000000INV001', 'acme/widgets', '"timestamp"']) {
      expect(text).not.toContain(leak);
    }
  });

  it("drops another tenant's lines without trace — not counted, not refused", () => {
    const tally = tallyFieldCoverage([line({ tenantId: OTHER }), line({ tenantId: OTHER, outputFields: 'junk' })], scope);
    expect(tally).toEqual({ tenantId: TENANT, operations: [], refused: 0 });
    // The twin: the same lines, asked about by that tenant, are its own.
    expect(tallyFieldCoverage([line({ tenantId: OTHER })], { ...scope, tenantId: OTHER }).operations).toHaveLength(1);
  });

  it('has no every-tenant spelling', () => {
    for (const tenantId of ['', undefined, null]) {
      expect(() => tallyFieldCoverage([line()], { ...scope, tenantId: tenantId as never })).toThrow(/one tenant/);
    }
    // A string is a tenant id like any other, and matches only lines that name it.
    expect(tallyFieldCoverage([line()], { ...scope, tenantId: '*' }).operations).toEqual([]);
  });

  it("drops a line another app's script wrote, even naming this tenant", () => {
    // A vertical serving the same tenant forges a platform-shaped line: its service is its own.
    const forged = [line({}, 'other-vertical'), line({}, 'acme-widgets-crm'), { ...line(), $metadata: {} }, { source: line().source }];
    expect(tallyFieldCoverage(forged, scope)).toEqual({ tenantId: TENANT, operations: [], refused: 0 });
    expect(tallyFieldCoverage([line()], { ...scope, services: [] }).operations).toEqual([]);
    // The family: a per-version and a jurisdictional script are the app's own.
    for (const service of ['acme-widgets-01jz0000000000000000ver001', 'acme-widgets-eu']) {
      expect(tallyFieldCoverage([line({}, service)], scope).operations, service).toHaveLength(1);
    }
  });

  it('skips a line with no report: unwalked is not "returned nothing"', () => {
    const { outputFields: _, ...unwalked } = line().source;
    expect(tallyFieldCoverage([{ ...line(), source: unwalked }], scope)).toEqual({ tenantId: TENANT, operations: [], refused: 0 });
  });

  it('refuses a malformed report whole, and counts it as refused', () => {
    const bad: unknown[] = [
      'not an object',
      null,
      [],
      { present: ['id'] },
      { present: 'id', empty: [], absent: [] },
      { present: [1], empty: [], absent: [] },
      { present: [''], empty: [], absent: [] },
      { present: ['x'.repeat(129)], empty: [], absent: [] },
      { present: ['id', 'id'], empty: [], absent: [] },
      { present: ['id'], empty: ['id'], absent: [] },
      { present: [], empty: [], absent: [] },
      { present: Array.from({ length: DECLARED_OUTPUT_FIELDS_MAX + 1 }, (_, i) => `f${i}`), empty: [], absent: [] },
    ];
    const tally = tallyFieldCoverage(
      bad.map((outputFields) => line({ outputFields })),
      scope,
    );
    expect(tally).toEqual({ tenantId: TENANT, operations: [], refused: bad.length });
    // A report at the cap is still one.
    const atCap = { present: Array.from({ length: DECLARED_OUTPUT_FIELDS_MAX }, (_, i) => `f${i}`), empty: [], absent: [] };
    expect(tallyFieldCoverage([line({ outputFields: atCap })], scope).operations[0]!.fields).toHaveLength(DECLARED_OUTPUT_FIELDS_MAX);
  });

  it('refuses a report with no usable operation, or on an async line', () => {
    const tally = tallyFieldCoverage(
      [line({ operation: null }), line({ operation: '' }), line({ operation: 'x'.repeat(129) }), line({ kind: 'consumer' })],
      scope,
    );
    expect(tally).toEqual({ tenantId: TENANT, operations: [], refused: 4 });
  });

  it('given the declaration, refuses names and operations outside it', () => {
    const declared = { 'acme/get-card': ['id', 'title', 'note', 'owner_email'] };
    const tally = tallyFieldCoverage(
      [
        line(),
        line({ outputFields: { present: ['id', 'injected'], empty: [], absent: [] } }),
        line({ operation: 'acme/invented' }),
        line({ operation: 'constructor' }),
      ],
      { ...scope, declared },
    );
    expect(tally.refused).toBe(3);
    expect(tally.operations.map((o) => [o.operation, o.responses])).toEqual([['acme/get-card', 1]]);
  });

  it('bounds the answer however many names a vertical invents', () => {
    // A different field each time cannot grow one operation past one declaration's cap.
    const drifting = Array.from({ length: DECLARED_OUTPUT_FIELDS_MAX + 5 }, (_, i) =>
      line({ outputFields: { present: [`f${i}`], empty: [], absent: [] } }),
    );
    const one = tallyFieldCoverage(drifting, scope);
    expect(one.operations[0]!.fields).toHaveLength(DECLARED_OUTPUT_FIELDS_MAX);
    expect(one.refused).toBe(5);

    // And inventing operations stops at the operation cap.
    const many = Array.from({ length: FIELD_COVERAGE_OPERATIONS_MAX + 3 }, (_, i) => line({ operation: `acme/op-${i}` }));
    const capped = tallyFieldCoverage(many, scope);
    expect(capped.operations).toHaveLength(FIELD_COVERAGE_OPERATIONS_MAX);
    expect(capped.refused).toBe(3);
    // A known operation still counts past the cap.
    expect(tallyFieldCoverage([...many, line({ operation: 'acme/op-0' })], scope).refused).toBe(3);
  });

  it('ignores what is not a stamped line at all', () => {
    const noise = [null, 1, 'x', {}, { source: null }, { source: { substrat: 'other', tenantId: TENANT } }];
    expect(tallyFieldCoverage(noise, scope)).toEqual({ tenantId: TENANT, operations: [], refused: 0 });
  });
});

describe('serviceFamilyMatcher', () => {
  it('is the anchored family the telemetry filter uses', () => {
    const own = serviceFamilyMatcher(SERVICES);
    expect(own('acme-widgets')).toBe(true);
    expect(own('acme-widgets-us')).toBe(true);
    expect(own('acme-widgets-crm')).toBe(false);
    expect(own('xacme-widgets')).toBe(false);
    expect(own(undefined)).toBe(false);
    expect(serviceFamilyMatcher([])('acme-widgets')).toBe(false);
    // A stem is matched as text, never as a pattern.
    expect(serviceFamilyMatcher(['acme.widgets'])('acmeXwidgets')).toBe(false);
  });
});

/** The per-request view stays without the report: aggregate-only means no request record carries it. */
describe('request records never carry outputFields (#1923)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a stamped line with a report lists as a request record without it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, result: { events: { events: [line()] } } }), { status: 200 }),
      ),
    );
    const reader = createCfObservabilityReader({ accountId: 'acct', apiToken: 't', routerDataset: 'substrat_router_test' });
    const records = await reader.tenantRequests!({ tenantId: TENANT, from: 0, to: 10_000, limit: 10 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ operation: 'acme/get-card' });
    expect(records[0]).not.toHaveProperty('outputFields');
    expect(JSON.stringify(records)).not.toContain('owner_email');
  });
});
