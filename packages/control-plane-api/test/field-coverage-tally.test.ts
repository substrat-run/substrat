import { afterEach, describe, expect, it, vi } from 'vitest';
import { DECLARED_OUTPUT_FIELDS_MAX } from '@substrat-run/contracts';
import { ROUTER_SCRIPT_NAMES } from '@substrat-run/contracts';
import { FIELD_COVERAGE_OPERATIONS_MAX, tallyFieldCoverage, type FieldCoverageScope } from '../src/field-coverage-tally.js';
import { createCfObservabilityReader } from '../src/cf-observability.js';
import { serviceFamilyMatcher } from '../src/service-family.js';

/**
 * #1923 part (c): `outputFields` is asserted by the vertical, so the one reading of it is
 * tenant-scoped, app-scoped and aggregate-only, and counts a report only for the tenant and app
 * the ROUTER's own line names for its dispatch id. Each rule here has its positive twin.
 */

const TENANT = '01JZ0000000000000000TEN001';
const OTHER = '01JZ0000000000000000TEN002';
const SERVICES = ['acme-widgets'];
/** A value no tally may ever contain: a path naming one record. */
const RECORD_PATH = '/api/customers/cust-4c1d-never-in-a-tally';

const APP = 'acme/widgets';

/** A fresh dispatch id: a ULID, as the router mints one. */
let minted = 0;
const dispatchId = () => `01JZ${String(++minted).padStart(22, '0')}`;

/** A stamped line as Workers Logs returns it, armed with a fresh dispatch id unless given one. */
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
    fieldCoverageId: dispatchId(),
    ...over,
  },
  $metadata: { id: 'ev', requestId: 'req', service },
});

/** The router's own request line for one dispatch, as Workers Logs returns it. */
const routerLine = (id: unknown, tenantId = TENANT, vertical = APP, service = 'substrat-router') => ({
  timestamp: 999,
  source: { router: 'request', tenantId, scopeId: '01JZ0000000000000000SCP001', vertical, status: 200, fieldCoverageId: id },
  $metadata: { id: 'rv', requestId: 'rreq', service },
});

const idOf = (event: unknown) => ((event as { source?: Record<string, unknown> })?.source ?? {})['fieldCoverageId'];

/** The router's lines vouching for every line's id, for `tenantId` and this app. */
const vouched = (events: unknown[], tenantId = TENANT) => events.map((e) => routerLine(idOf(e), tenantId));

const scope: FieldCoverageScope = { tenantId: TENANT, vertical: APP, services: SERVICES };

/** The tally over `events`, with the router having dispatched every one of them for the scope's tenant. */
const tally = (events: unknown[], sc: FieldCoverageScope = scope) => tallyFieldCoverage(events, vouched(events, sc.tenantId), sc);

describe('tallyFieldCoverage (#1923)', () => {
  it('counts per (operation, field), one per response', () => {
    const result = tally(
      [
        line(),
        line({ outputFields: { present: ['id', 'title', 'note'], empty: [], absent: ['owner_email'] } }),
        line({ operation: 'acme/list-cards', outputFields: { present: ['id'], empty: [], absent: [] } }),
      ],
      scope,
    );
    expect(result).toEqual({
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
    const text = JSON.stringify(tally([line(), line()], scope));
    for (const leak of [RECORD_PATH, '01JZ0000000000000000SCP001', '01JZ0000000000000000INV001', 'acme/widgets', '"timestamp"']) {
      expect(text).not.toContain(leak);
    }
  });

  it("drops another tenant's lines without trace — not counted, not refused", () => {
    const result = tally([line({ tenantId: OTHER }), line({ tenantId: OTHER, outputFields: 'junk' })], scope);
    expect(result).toEqual({ tenantId: TENANT, operations: [], refused: 0 });
    // The twin: the same lines, asked about by that tenant, are its own.
    expect(tally([line({ tenantId: OTHER })], { ...scope, tenantId: OTHER }).operations).toHaveLength(1);
  });

  it('has no every-tenant spelling', () => {
    for (const tenantId of ['', undefined, null]) {
      expect(() => tally([line()], { ...scope, tenantId: tenantId as never })).toThrow(/one tenant/);
    }
    // A string is a tenant id like any other, and matches only lines that name it.
    expect(tally([line()], { ...scope, tenantId: '*' }).operations).toEqual([]);
  });

  it("drops a line another app's script wrote, even naming this tenant", () => {
    // A vertical serving the same tenant forges a platform-shaped line: its service is its own.
    const forged = [line({}, 'other-vertical'), line({}, 'acme-widgets-crm'), { ...line(), $metadata: {} }, { source: line().source }];
    expect(tally(forged, scope)).toEqual({ tenantId: TENANT, operations: [], refused: 0 });
    expect(tally([line()], { ...scope, services: [] }).operations).toEqual([]);
    // The family: a per-version and a jurisdictional script are the app's own.
    for (const service of ['acme-widgets-01jz0000000000000000ver001', 'acme-widgets-eu']) {
      expect(tally([line({}, service)], scope).operations, service).toHaveLength(1);
    }
  });

  it('skips a line with no report: unwalked is not "returned nothing"', () => {
    const { outputFields: _, ...unwalked } = line().source;
    expect(tally([{ ...line(), source: unwalked }], scope)).toEqual({ tenantId: TENANT, operations: [], refused: 0 });
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
    const result = tally(
      bad.map((outputFields) => line({ outputFields })),
      scope,
    );
    expect(result).toEqual({ tenantId: TENANT, operations: [], refused: bad.length });
    // A report at the cap is still one.
    const atCap = { present: Array.from({ length: DECLARED_OUTPUT_FIELDS_MAX }, (_, i) => `f${i}`), empty: [], absent: [] };
    expect(tally([line({ outputFields: atCap })], scope).operations[0]!.fields).toHaveLength(DECLARED_OUTPUT_FIELDS_MAX);
  });

  it('refuses a report with no usable operation, or on an async line', () => {
    const result = tally(
      [line({ operation: null }), line({ operation: '' }), line({ operation: 'x'.repeat(129) }), line({ kind: 'consumer' })],
      scope,
    );
    expect(result).toEqual({ tenantId: TENANT, operations: [], refused: 4 });
  });

  it('given the declaration, refuses names and operations outside it', () => {
    const declared = { 'acme/get-card': ['id', 'title', 'note', 'owner_email'] };
    const result = tally(
      [
        line(),
        line({ outputFields: { present: ['id', 'injected'], empty: [], absent: [] } }),
        line({ operation: 'acme/invented' }),
        line({ operation: 'constructor' }),
      ],
      { ...scope, declared },
    );
    expect(result.refused).toBe(3);
    expect(result.operations.map((o) => [o.operation, o.responses])).toEqual([['acme/get-card', 1]]);
  });

  it('bounds the answer however many names a vertical invents', () => {
    // A different field each time cannot grow one operation past one declaration's cap.
    const drifting = Array.from({ length: DECLARED_OUTPUT_FIELDS_MAX + 5 }, (_, i) =>
      line({ outputFields: { present: [`f${i}`], empty: [], absent: [] } }),
    );
    const one = tally(drifting, scope);
    expect(one.operations[0]!.fields).toHaveLength(DECLARED_OUTPUT_FIELDS_MAX);
    expect(one.refused).toBe(5);

    // And inventing operations stops at the operation cap.
    const many = Array.from({ length: FIELD_COVERAGE_OPERATIONS_MAX + 3 }, (_, i) => line({ operation: `acme/op-${i}` }));
    const capped = tally(many, scope);
    expect(capped.operations).toHaveLength(FIELD_COVERAGE_OPERATIONS_MAX);
    expect(capped.refused).toBe(3);
    // A known operation still counts past the cap.
    expect(tally([...many, line({ operation: 'acme/op-0' })], scope).refused).toBe(3);
  });

  it('ignores what is not a stamped line at all', () => {
    const noise = [null, 1, 'x', {}, { source: null }, { source: { substrat: 'other', tenantId: TENANT } }];
    expect(tally(noise, scope)).toEqual({ tenantId: TENANT, operations: [], refused: 0 });
  });
});

/**
 * The provenance join (Codex r1 on #2024): a report counts only for the tenant and app the
 * router's own line names for its dispatch id. A vertical serving tenants A and B can log
 * anything, under its own service — never under the router's.
 */
describe('the router join (#1923)', () => {
  const B = OTHER;

  it("a forged same-service line naming B, written during A's request, is not counted for B", () => {
    // A's real request: the router minted `id` for tenant A and this app.
    const real = line();
    const id = idOf(real);
    // During it, the vertical logs a report naming tenant B and reusing A's id.
    const forged = line({ tenantId: B, fieldCoverageId: id, outputFields: { present: ['id', 'injected'], empty: [], absent: [] } });
    const router = [routerLine(id, TENANT)];
    expect(tallyFieldCoverage([real, forged], router, { ...scope, tenantId: B })).toEqual({ tenantId: B, operations: [], refused: 0 });
    // The twin: the id is A's, so A's tally counts A's real report.
    expect(tallyFieldCoverage([real, forged], router, scope).operations).toHaveLength(1);
  });

  it("a copied id of A's attributes to A, whichever tenant the line names", () => {
    const id = dispatchId();
    // The line names B, the router says the id was A's: only A's tally could see it, and A's
    // tally drops it because the line is not shaped as A's. Nothing reaches B either way.
    const copied = line({ tenantId: B, fieldCoverageId: id });
    expect(tallyFieldCoverage([copied], [routerLine(id, TENANT)], { ...scope, tenantId: B }).operations).toEqual([]);
    expect(tallyFieldCoverage([copied], [routerLine(id, TENANT)], scope).operations).toEqual([]);
    // A line naming A with A's id is A's.
    const own = line({ fieldCoverageId: id });
    expect(tallyFieldCoverage([own], [routerLine(id, TENANT)], scope).operations).toHaveLength(1);
  });

  it('an invented id, a missing id or a malformed one is dropped without trace', () => {
    const lines = [line(), line({ fieldCoverageId: undefined }), line({ fieldCoverageId: 'not-a-ulid' }), line({ fieldCoverageId: 7 })];
    // The router vouched for none of these ids.
    expect(tallyFieldCoverage(lines, [routerLine(dispatchId())], scope)).toEqual({ tenantId: TENANT, operations: [], refused: 0 });
    const { fieldCoverageId: _, ...unstamped } = line().source;
    expect(tallyFieldCoverage([{ ...line(), source: unstamped }], [], scope).operations).toEqual([]);
  });

  it('a replayed id is counted once', () => {
    const id = dispatchId();
    const result = tallyFieldCoverage([line({ fieldCoverageId: id }), line({ fieldCoverageId: id }), line({ fieldCoverageId: id })], [routerLine(id)], scope);
    expect(result.operations.map((o) => o.responses)).toEqual([1]);
    expect(result.refused).toBe(2);
  });

  it("joins to another app's dispatch for the same tenant: dropped", () => {
    const id = dispatchId();
    expect(tallyFieldCoverage([line({ fieldCoverageId: id })], [routerLine(id, TENANT, 'other/app')], scope).operations).toEqual([]);
    expect(tallyFieldCoverage([line({ fieldCoverageId: id })], [routerLine(id, TENANT, APP)], scope).operations).toHaveLength(1);
  });

  it("reads provenance from the router's service only — a vertical's router-shaped line is not one", () => {
    const id = dispatchId();
    const real = line({ fieldCoverageId: id });
    for (const service of ['acme-widgets', 'substrat-router-evil', 'Substrat-Router']) {
      expect(tallyFieldCoverage([real], [routerLine(id, TENANT, APP, service)], scope).operations, service).toEqual([]);
    }
    expect(tallyFieldCoverage([real], [{ ...routerLine(id), $metadata: {} }], scope).operations).toEqual([]);
    for (const service of ROUTER_SCRIPT_NAMES) {
      expect(tallyFieldCoverage([real], [routerLine(id, TENANT, APP, service)], scope).operations, service).toHaveLength(1);
    }
  });

  it("refuses an app whose scripts would be named like the router's (Codex r2's reproduction)", () => {
    // A vertical deployed as `substrat/router` would log router-shaped lines under the router's
    // own service name, for an invented id and any tenant, then a matching report.
    const id = dispatchId();
    const forgedRouter = routerLine(id, B, 'substrat/router', 'substrat-router');
    const report = line({ tenantId: B, vertical: 'substrat/router', fieldCoverageId: id }, 'substrat-router');
    for (const services of [['substrat-router'], ['acme-widgets', 'substrat-router-test']]) {
      expect(
        () => tallyFieldCoverage([report], [forgedRouter], { tenantId: B, vertical: 'substrat/router', services }),
        services.join(),
      ).toThrow(/router/);
    }
    // The twin: the stem `substrat-routers` is its own family, not the router's.
    expect(() => tallyFieldCoverage([], [], { ...scope, services: ['substrat-routers'] })).not.toThrow();
  });

  it('names its app', () => {
    expect(() => tallyFieldCoverage([], [], { ...scope, vertical: '' })).toThrow(/one app/);
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

/**
 * The per-event reads stay without the report: aggregate-only means no request record, tenant
 * log line or service log line carries it (Codex r1 on #2024).
 */
describe('per-event reads never carry outputFields (#1923)', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A backend that answers every query with the given events. */
  function readerAnswering(events: unknown[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: true, result: { events: { events } } }), { status: 200 })),
    );
    return createCfObservabilityReader({ accountId: 'acct', apiToken: 't', routerDataset: 'substrat_router_test' });
  }

  const carriesNoReport = (value: unknown) => {
    const text = JSON.stringify(value);
    expect(text).not.toContain('outputFields');
    expect(text).not.toContain('owner_email');
  };

  it('a request record', async () => {
    const records = await readerAnswering([line()]).tenantRequests!({ tenantId: TENANT, from: 0, to: 10_000, limit: 10 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ operation: 'acme/get-card' });
    carriesNoReport(records);
  });

  it("a tenant log line — the stamped line's raw event included", async () => {
    const events = await readerAnswering([line()]).tenantLogs!({ tenantId: TENANT, hours: 24, limit: 10 });
    expect(events).toHaveLength(1);
    // The rest of the line is still there: only the report is withheld.
    expect((events[0]!.raw as { source: Record<string, unknown> }).source).toMatchObject({ operation: 'acme/get-card', tenantId: TENANT });
    carriesNoReport(events);
  });

  it('a service log line', async () => {
    const events = await readerAnswering([line()]).recentLogs({ services: SERVICES, hours: 24, limit: 10 });
    expect(events).toHaveLength(1);
    carriesNoReport(events);
  });

  it('the tally, reading the unprojected events, still counts it', () => {
    expect(tally([line()], scope).operations).toHaveLength(1);
  });
});
