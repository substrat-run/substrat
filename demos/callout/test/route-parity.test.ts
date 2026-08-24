/**
 * What Callout serves, and what it deliberately does not.
 *
 * This began as a parity test: two tables — the hand-written one and the derived one
 * — mounted on real Hono apps and compared through `app.routes`. That question is
 * settled. `src/routes.ts` now IS the derivation, so asking whether the two agree
 * would be asking whether one thing equals itself, and a test that cannot fail is
 * worse than no test because it still reads like coverage.
 *
 * What is left is the part that was never tautological:
 *
 *  1. The declared surface, pinned as an exact list. Adding or removing a URL is a
 *     change to a published API, and it should be impossible to make without seeing
 *     it here.
 *  2. The two routes that are NOT derived, and the reason — an entity-agnostic
 *     `entityType` a caller must not choose.
 *  3. That the pin actually holds, driven through a real request.
 *  4. That ordering resolves `/customers/search` against its parameter sibling, which
 *     the hand-written table had a comment about and now nothing has to remember.
 *
 * Path parameter NAMES are normalised away: `/customers/:id/facilities` and
 * `/customers/:customerId/facilities` dispatch identically, and the name is internal
 * to the handler.
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

describe('the declared surface', () => {
  it('serves a route for every operation that declares http, and only those', () => {
    // Pinned as a list because each entry is a published URL. Four of these were
    // declared without an `http` block until the client became generated — an
    // operation with no binding is invisible to the emitter, so the SPA hand-wrote
    // the call to a route Callout was already serving.
    expect(mountApi(new Hono(), async () => ({}) as never).map((r) => r.operation).sort()).toEqual([
      'callout/complete-workorder',
      'callout/create-customer',
      'callout/create-facility',
      'callout/create-workorder',
      'callout/get-facility',
      'callout/instantiate-protocol',
      'callout/list-customers',
      'callout/portal-orders',
      'callout/price-list',
      'callout/search-customers',
      'callout/update-facility',
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

  it('serves the two hand-written exceptions alongside the derived table', () => {
    // They are not in the list above — they have no operation binding — so nothing
    // else would notice them disappearing.
    expect(servedRoutes()).toContain('GET /api/workorders/:x/timeline');
    expect(servedRoutes()).toContain('GET /api/workorders/:x/protocols');
  });

  it('registers a static segment ahead of its parameter sibling', () => {
    // `/customers/search` before `/customers/:id/...`: Hono dispatches in
    // registration order, and getting this wrong answers the search endpoint with
    // `id: 'search'` — no error, just a route that silently belongs to its
    // neighbour (#785). The hand-written table carried a comment asking a person to
    // remember; the derivation orders it.
    const paths = mountApi(new Hono(), async () => ({}) as never)
      .filter((r) => r.path.startsWith('/api/customers'))
      .map((r) => r.path);
    expect(paths.indexOf('/api/customers/search')).toBeLessThan(
      paths.indexOf('/api/customers/:customerId/facilities'),
    );
  });
});

describe('what is NOT derived, and why', () => {
  it('leaves the two routes that supply a constant out of the derived table', () => {
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
