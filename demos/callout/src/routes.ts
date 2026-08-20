import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { mountOperations, type ResolveStub } from '@substrat-run/vertical-host';
import {
  calloutEngineRoutes,
  calloutInvoicingRoutes,
  calloutOperations,
  calloutProtocolRoutes,
} from './operations.js';

/**
 * The Callout (fsm) HTTP API — derived from the declared operations, plus the two
 * routes that cannot be.
 *
 * Both entrypoints mount this: `server.ts` (node, pure-SQLite adapter, `x-principal`
 * dev auth) and `worker.ts` (Cloudflare, Durable-Object adapter, OIDC). Each supplies
 * a `resolveStub` that authenticates the caller and returns a capability `ScopeStub`.
 * Sharing this table is D-14 made concrete — the SAME vertical surface runs on both
 * adapters, so the two entries cannot drift apart.
 *
 * ## Why there is no table here any more
 *
 * There was one, 180 lines of it, and every line restated something the operations
 * already declare: the method, the path, which input fields the path carries. The
 * comments it accumulated are the argument against it — one explaining that
 * `/customers/search` must be registered before any `/customers/:id` route or Hono
 * will answer it with `id: 'search'`, another explaining that `limit` arrives as a
 * string and has to be coerced because the operation declares a number. Both are
 * real, and `mountOperations` derives both from the same declarations (#785): it
 * orders static segments ahead of their parameter siblings, and it coerces query
 * values per the declared shape. A hand-written table has to remember, and it had
 * already drifted once.
 */
export type { ResolveStub };

/** Every operation that carries a URL: this vertical's own, and the three engines it composes. */
const ROUTED = {
  ...calloutOperations,
  ...calloutEngineRoutes,
  ...calloutProtocolRoutes,
  ...calloutInvoicingRoutes,
};

export function mountApi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
): { operation: string; method: string; path: string }[] {
  const S = resolveStub;

  // The mount decides the STATUS for everything the kernel itself names — a refused
  // permission, an input that failed to parse, `resolveStub` refusing an anonymous
  // call (#791) — and re-throws the rest untouched. This turns the status into THIS
  // app's `{ error }` body.
  //
  // `c.json(...)` rather than `err.getResponse()`, which is what the hand-written
  // table did: Hono's own response body is not `{ error }`, and the SPA reads
  // `error` off every failure to decide between "not allowed" and "we broke".
  app.onError((err, c: Context) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    // What is left is PLATFORM vocabulary the mount has no opinion on: a missing
    // entity, an unknown scope or operation, a feature this tenant does not hold.
    if (/not found|unknown scope|unknown operation|not entitled/.test(err.message)) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: err.message }, 400);
  });

  // ---------------------------------------------------------------------------
  // The two routes that supply a CONSTANT the caller must not choose.
  //
  // Both invoke an operation whose `entityType` is an ordinary `z.string()`, because
  // both belong to entity-agnostic surfaces — `callout/timeline` reads the event
  // spine, `protocol/list-for-entity` belongs to an engine that knows nothing about
  // work orders. Binding either to a URL would put `entityType` in the query string
  // and let a caller list the timeline, or the protocols, of anything at all. This is
  // exactly where the vertical is supposed to stop being entity-agnostic, so it says
  // 'workorder' here and the operations stay unbound.
  //
  // Registered BEFORE the derived table. Neither can actually be shadowed by it — no
  // declared route dispatches at their shape — but "the hand-written exception wins"
  // is the only ordering that stays safe as the declared table grows.
  // ---------------------------------------------------------------------------
  app.get('/api/workorders/:id/timeline', async (c) =>
    c.json(
      await (await S(c)).invoke('callout/timeline', {
        entityType: 'workorder',
        entityId: c.req.param('id'),
      }),
    ),
  );
  app.get('/api/workorders/:id/protocols', async (c) =>
    c.json(
      await (await S(c)).invoke('protocol/list-for-entity', {
        entityType: 'workorder',
        entityId: c.req.param('id'),
      }),
    ),
  );

  return mountOperations(app, ROUTED, resolveStub);
}
