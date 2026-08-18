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
import { mountApi } from '../src/routes.js';
import { calloutEngineRoutes, calloutOperations } from '../src/operations.js';

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
    { ...calloutOperations, ...calloutEngineRoutes },
    async () => ({}) as never,
  );
}

describe('derived routes vs the routes Callout serves', () => {
  it('derives a route for every operation that declares http', () => {
    expect(derivedRoutes().map((r) => r.operation).sort()).toEqual([
      'callout/create-customer',
      'callout/create-facility',
      'callout/instantiate-protocol',
      'callout/list-customers',
      'callout/price-list',
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
