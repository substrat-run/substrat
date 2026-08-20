/**
 * Does the DERIVED route table match the one Callout actually serves?
 *
 * Both tables are mounted on real Hono apps and compared through `app.routes` —
 * a structural comparison of what each would dispatch, not a reading of the
 * source. Only the operations that declare `http` are in scope; the rest of
 * Callout's surface invokes ENGINE operations, which carry no URL shape of
 * their own.
 *
 * Path parameter NAMES are normalised away: `/customers/:id/facilities` and
 * `/customers/:customerId/facilities` dispatch identically, and the name is
 * internal to the handler.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mountOperations } from '@substrat-run/vertical-host';
import { apiCatalogFrom } from '@substrat-run/contracts';
import { workorderOperations } from '@substrat-run/engine-workorder';
import { mountApi } from '../src/routes.js';
import {
  calloutEngineRoutes,
  calloutInvoicingRoutes,
  calloutOperations,
  calloutProtocolRoutes,
} from '../src/operations.js';

/** `/customers/:id/facilities` → `/customers/:x/facilities`. */
const shape = (path: string) => path.replace(/:[A-Za-z0-9_]+/g, ':x');

function servedRoutes(): Set<string> {
  const app = new Hono();
  mountApi(app, async () => ({}) as never);
  return new Set(app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${shape(r.path)}`));
}

function derivedRoutes() {
  const app = new Hono();
  // The vertical's own operations AND the engine operations it gives a place to
  // — one table, one derivation.
  return mountOperations(
    app,
    {
      ...calloutOperations,
      ...calloutEngineRoutes,
      ...calloutProtocolRoutes,
      ...calloutInvoicingRoutes,
    },
    async () => ({}) as never,
  );
}

describe('derived routes vs the routes Callout serves', () => {
  it('derives a route for every operation that declares http', () => {
    expect(derivedRoutes().map((r) => r.operation).sort()).toEqual([
      // Four of these were declared without an `http` block until the client became
      // generated (#client-emit): an operation with no binding is invisible to the
      // emitter, so the SPA had to hand-write the call. Binding them changes nothing
      // at runtime — routes.ts still mounts the table — but the sibling test below
      // proves each path is one Callout already serves.
      'callout/complete-workorder',
      'callout/create-customer',
      'callout/create-facility',
      'callout/create-workorder',
      'callout/instantiate-protocol',
      'callout/list-customers',
      'callout/portal-orders',
      'callout/price-list',
      'callout/search-customers',
      'callout/upsert-price',
      'invoicing/export',
      'invoicing/get',
      'invoicing/list',
      'protocol/define-template',
      'protocol/fill',
      'protocol/get',
      'protocol/list-templates',
      'protocol/sign',
      'protocol/void',
      'workorder/assign',
      'workorder/close',
      'workorder/get',
      'workorder/list',
      'workorder/report-material',
      'workorder/report-time',
      'workorder/start',
    ]);
  });

  it('every derived route is one the hand-written table already serves', () => {
    const served = servedRoutes();
    const missing = derivedRoutes()
      .map((r) => `${r.method} ${shape(r.path)}`)
      .filter((r) => !served.has(r));
    expect(missing).toEqual([]);
  });
});

describe('what is NOT derived, and why', () => {
  it('leaves the two routes that supply a constant to the hand-written table', () => {
    // Callout's policy is that protocols live on work orders, so both
    // `/workorders/{id}/protocols` routes fix `entityType` rather than letting a
    // caller choose it. The POST already has a home — `callout/instantiate-
    // protocol` declares `entityType: z.literal('workorder')`, which
    // `mountOperations` pins. The GET has no wrapper, and binding
    // `protocol/list-for-entity` directly would move `entityType` into the query
    // string, letting a caller list the protocols on any entity in the scope.
    const derived = new Set(derivedRoutes().map((r) => r.operation));
    expect(derived.has('protocol/list-for-entity')).toBe(false);
    expect(derived.has('callout/instantiate-protocol')).toBe(true);
  });

  it('pins the entity type rather than accepting it from the caller', async () => {
    // The guard that makes the POST safe to derive at all, driven rather than
    // read: a caller who puts a different `entityType` in the body must not be
    // able to instantiate a protocol on something that is not a work order.
    // Asserted through a real request, so it tests the protection instead of
    // the schema's internal representation of a literal.
    const seen: { name?: string; payload?: unknown } = {};
    const app = new Hono();
    mountOperations(app, calloutOperations, async () => ({
      invoke: async (name: string, payload: unknown) => {
        seen.name = name;
        seen.payload = payload;
        return {};
      },
    }) as never);

    await app.request('/api/workorders/wo-1/protocols', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateKey: 'tillstandsrapport', entityType: 'customer' }),
    });

    expect(seen.name).toBe('callout/instantiate-protocol');
    expect(seen.payload).toMatchObject({
      templateKey: 'tillstandsrapport',
      entityType: 'workorder',
      entityId: 'wo-1',
    });
  });
});

describe('a binding that names an operation nothing registers', () => {
  it('fails at MOUNT, not as a 404 when somebody calls it', () => {
    const app = new Hono();
    expect(() =>
      mountOperations(
        app,
        { 'workorder/gett': { input: undefined, http: { method: 'GET', path: '/x' } } },
        async () => ({}) as never,
        { knownOperations: Object.keys(calloutOperations) },
      ),
    ).toThrow(/no registered module provides it/);
  });
});

describe('a binding is checked against the engine that owns the operation', () => {
  it('carries the ENGINE\'s input and output, not a restatement', () => {
    // The point of #738: the vertical supplies a path, and everything else —
    // the summary, the schema the handler parses, the shape it returns — comes
    // from the engine. A restatement here is a description held in agreement
    // by nothing.
    const bound = calloutEngineRoutes['workorder/get'];
    expect(bound.summary).toBe(workorderOperations['workorder/get'].summary);
    expect(bound.input).toBe(workorderOperations['workorder/get'].input);
    expect(bound.output).toBe(workorderOperations['workorder/get'].output);
  });

  it('reaches the API document with the engine\'s real schemas', () => {
    const catalog = apiCatalogFrom({ ...calloutOperations, ...calloutEngineRoutes });
    expect(catalog['workorder/get']?.output).toBe(workorderOperations['workorder/get'].output);
    expect(catalog['workorder/get']?.http).toEqual({
      method: 'GET',
      path: '/workorders/{orderId}',
    });
  });
});
