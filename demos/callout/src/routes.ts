import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PermissionDenied, type ScopeStub } from '@substrat-run/kernel';

/**
 * The Callout (fsm) HTTP API — one route table, adapter- and auth-agnostic.
 *
 * Both entrypoints mount this: `server.ts` (node, on the pure-SQLite adapter,
 * `x-principal` dev auth) and `worker.ts` (Cloudflare, on the Durable-Object
 * adapter, Better Auth). Each supplies a `resolveStub` that authenticates the
 * caller and returns a capability `ScopeStub`; every route is a thin wrapper over
 * a single operation, with no business logic. Sharing this table is D-14 made
 * concrete — the SAME vertical surface runs on both adapters, so the two entries
 * cannot drift apart.
 */
export type ResolveStub = (c: Context) => Promise<ScopeStub>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountApi(app: Hono<any, any, any>, resolveStub: ResolveStub): void {
  const S = resolveStub;
  const body = (c: Context) => c.req.json<Record<string, unknown>>();

  // Shared error mapping: auth (HTTPException 401), permission (403), missing
  // entity / scope / operation (404), everything else a validation 400.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof PermissionDenied) return c.json({ error: err.message }, 403);
    if (/not found|unknown scope|unknown operation|not entitled/.test(err.message)) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: err.message }, 400);
  });

  // -- customers + facilities ------------------------------------------------
  app.get('/api/customers', async (c) => c.json(await (await S(c)).invoke('callout/list-customers')));
  // #827. BEFORE any `/api/customers/:id` route: Hono dispatches in registration
  // order, so a parameter sibling registered first would swallow this and answer
  // with `id: 'search'`. `mountOperations` orders declared paths for exactly this
  // (#785); a hand-written table has to do it by hand.
  //
  // `limit` arrives as a string and the operation declares a number, so it is
  // coerced here — the same coercion `mountOperations` derives from the schema.
  app.get('/api/customers/search', async (c) => {
    const limit = c.req.query('limit');
    return c.json(
      await (await S(c)).invoke('callout/search-customers', {
        q: c.req.query('q') ?? '',
        ...(limit === undefined ? {} : { limit: Number(limit) }),
      }),
    );
  });
  app.post('/api/customers', async (c) =>
    c.json(await (await S(c)).invoke('callout/create-customer', await c.req.json())),
  );
  app.post('/api/customers/:id/facilities', async (c) =>
    c.json(
      await (await S(c)).invoke('callout/create-facility', {
        customerId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );

  // -- price list ------------------------------------------------------------
  app.get('/api/prices', async (c) => c.json(await (await S(c)).invoke('callout/price-list')));
  app.post('/api/prices', async (c) =>
    c.json(await (await S(c)).invoke('callout/upsert-price', await c.req.json())),
  );

  // -- work orders -----------------------------------------------------------
  app.get('/api/workorders', async (c) =>
    c.json(await (await S(c)).invoke('workorder/list', { status: c.req.query('status') })),
  );
  app.post('/api/workorders', async (c) =>
    c.json(await (await S(c)).invoke('callout/create-workorder', await c.req.json())),
  );
  app.get('/api/workorders/:id', async (c) =>
    c.json(await (await S(c)).invoke('workorder/get', { orderId: c.req.param('id') })),
  );
  app.get('/api/workorders/:id/timeline', async (c) =>
    c.json(
      await (await S(c)).invoke('callout/timeline', {
        entityType: 'workorder',
        entityId: c.req.param('id'),
      }),
    ),
  );
  app.post('/api/workorders/:id/assign', async (c) =>
    c.json(
      await (await S(c)).invoke('workorder/assign', {
        orderId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );
  app.post('/api/workorders/:id/start', async (c) =>
    c.json(await (await S(c)).invoke('workorder/start', { orderId: c.req.param('id') })),
  );
  app.post('/api/workorders/:id/time', async (c) =>
    c.json(
      await (await S(c)).invoke('workorder/report-time', {
        orderId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );
  app.post('/api/workorders/:id/material', async (c) =>
    c.json(
      await (await S(c)).invoke('workorder/report-material', {
        orderId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );
  app.post('/api/workorders/:id/complete', async (c) =>
    c.json(await (await S(c)).invoke('callout/complete-workorder', { orderId: c.req.param('id') })),
  );
  app.post('/api/workorders/:id/close', async (c) =>
    c.json(await (await S(c)).invoke('workorder/close', { orderId: c.req.param('id') })),
  );

  // -- protocols -------------------------------------------------------------
  app.get('/api/protocol-templates', async (c) =>
    c.json(await (await S(c)).invoke('protocol/list-templates')),
  );
  app.post('/api/protocol-templates', async (c) =>
    c.json(await (await S(c)).invoke('protocol/define-template', await c.req.json())),
  );
  app.get('/api/workorders/:id/protocols', async (c) =>
    c.json(
      await (await S(c)).invoke('protocol/list-for-entity', {
        entityType: 'workorder',
        entityId: c.req.param('id'),
      }),
    ),
  );
  app.post('/api/workorders/:id/protocols', async (c) =>
    c.json(
      await (await S(c)).invoke('callout/instantiate-protocol', {
        entityType: 'workorder',
        entityId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );
  app.get('/api/protocols/:id', async (c) =>
    c.json(await (await S(c)).invoke('protocol/get', { instanceId: c.req.param('id') })),
  );
  app.post('/api/protocols/:id/responses', async (c) =>
    c.json(
      await (await S(c)).invoke('protocol/fill', {
        instanceId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );
  app.post('/api/protocols/:id/sign', async (c) =>
    c.json(await (await S(c)).invoke('protocol/sign', { instanceId: c.req.param('id') })),
  );
  app.post('/api/protocols/:id/void', async (c) =>
    c.json(
      await (await S(c)).invoke('protocol/void', {
        instanceId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );

  // -- portal + invoicing ----------------------------------------------------
  app.get('/api/portal/orders', async (c) =>
    c.json(await (await S(c)).invoke('callout/portal-orders')),
  );
  app.get('/api/invoicing', async (c) => c.json(await (await S(c)).invoke('invoicing/list')));
  app.get('/api/invoicing/:id', async (c) =>
    c.json(await (await S(c)).invoke('invoicing/get', { underlagId: c.req.param('id') })),
  );
  app.post('/api/invoicing/:id/export', async (c) =>
    c.json(await (await S(c)).invoke('invoicing/export', { underlagId: c.req.param('id') })),
  );
}
