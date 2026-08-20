import type { Context, Hono } from 'hono';
import { classifyError } from '@substrat-run/vertical-host';
import type { ScopeStub } from '@substrat-run/kernel';

/**
 * The bike shop's HTTP API — ONE route table, adapter- and auth-agnostic.
 *
 * Both entrypoints mount this: `server.ts` (node, pure-SQLite adapter, `x-principal`
 * dev auth) and `worker.ts` (Cloudflare, Durable-Object adapter, the auth seam). Each
 * supplies a `resolveStub` that authenticates the caller its own way and returns a
 * capability `ScopeStub`; every route here is a thin wrapper over ONE operation, with
 * no business logic — the rules live in an operation or an engine.
 *
 * Sharing the table is the point. A route added to only one entrypoint is a surface
 * that exists in dev and 404s in production (or the reverse), and nothing catches it
 * until deploy: the scenario tests call operations directly and never boot either host.
 * Add a route HERE and it is live on both.
 *
 * What each entrypoint still owns is only what is genuinely its own: how it builds a
 * host, how it resolves a caller, and its own auth-shaped routes (`/api/cast` in dev,
 * `/api/me` in the worker) — those answer "who am I on THIS host" and cannot be shared.
 */
export type ResolveStub = (c: Context) => Promise<ScopeStub>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountApi(app: Hono<any, any, any>, resolveStub: ResolveStub): void {
  const S = resolveStub;
  const body = (c: Context) => c.req.json<Record<string, unknown>>();

  /**
   * One error vocabulary, shared with the platform surface: `classifyError`
   * (@substrat-run/vertical-host) is the same function `mountPlatformSurface` uses, so a
   * permission denial is 403, a missing thing 404, a broken invariant 409, a runtime
   * fault 502 — identically on both hosts. "No opinion" becomes the caller's 400.
   *
   * In `worker.ts` this handler is REPLACED: Hono keeps only the last-registered
   * `onError`, and `mountPlatformSurface` installs its own. That is harmless precisely
   * because both are built on `classifyError` — same input, same answer. Registering it
   * here is what gives `server.ts`, which mounts no platform surface, the same behaviour.
   */
  app.onError((err, c) => {
    const seen = classifyError(err);
    if (seen) return c.json({ error: seen.message }, seen.status);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  });

  // -- generic invoke ---------------------------------------------------------
  // The kernel checks a permission inside EVERY operation, so a generic route is
  // exactly as safe as one route per operation. It is the escape hatch that keeps a
  // new operation reachable before it has a named route — on BOTH hosts, deliberately.
  app.post('/api/invoke', async (c) => {
    const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
    return c.json((await (await S(c)).invoke(op, input)) ?? null);
  });

  // -- customers, bikes, price list (the vertical's own tables) ---------------
  app.get('/api/customers', async (c) => c.json(await (await S(c)).invoke('shop/list-customers')));
  app.post('/api/customers', async (c) =>
    c.json(await (await S(c)).invoke('shop/create-customer', await c.req.json())),
  );
  app.post('/api/customers/:id/bikes', async (c) =>
    c.json(
      await (await S(c)).invoke('shop/register-bike', {
        customerId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );
  app.get('/api/prices', async (c) => c.json(await (await S(c)).invoke('shop/price-list')));
  app.post('/api/prices', async (c) =>
    c.json(await (await S(c)).invoke('shop/upsert-price', await c.req.json())),
  );

  // -- repairs ---------------------------------------------------------------
  // create/complete/close are the VERTICAL's operations (they wrap the engine and own
  // the pricing moment); assign/start/report/get/list are the ENGINE's own, invoked
  // directly. Which is which is the composition boundary, visible right here.
  app.get('/api/repairs', async (c) =>
    c.json(await (await S(c)).invoke('workorder/list', { status: c.req.query('status') })),
  );
  app.post('/api/repairs', async (c) =>
    c.json(await (await S(c)).invoke('shop/create-repair', await c.req.json())),
  );
  app.get('/api/repairs/:id', async (c) =>
    c.json(await (await S(c)).invoke('workorder/get', { orderId: c.req.param('id') })),
  );
  app.get('/api/repairs/:id/timeline', async (c) =>
    c.json(
      await (await S(c)).invoke('shop/timeline', {
        entityType: 'workorder',
        entityId: c.req.param('id'),
      }),
    ),
  );
  app.post('/api/repairs/:id/assign', async (c) =>
    c.json(
      await (await S(c)).invoke('workorder/assign', {
        orderId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );
  app.post('/api/repairs/:id/start', async (c) =>
    c.json(await (await S(c)).invoke('workorder/start', { orderId: c.req.param('id') })),
  );
  app.post('/api/repairs/:id/time', async (c) =>
    c.json(
      await (await S(c)).invoke('workorder/report-time', {
        orderId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );
  app.post('/api/repairs/:id/material', async (c) =>
    c.json(
      await (await S(c)).invoke('workorder/report-material', {
        orderId: c.req.param('id'),
        ...(await body(c)),
      }),
    ),
  );
  app.post('/api/repairs/:id/complete', async (c) =>
    c.json(await (await S(c)).invoke('shop/complete-repair', { orderId: c.req.param('id') })),
  );
  app.post('/api/repairs/:id/close', async (c) =>
    c.json(await (await S(c)).invoke('shop/close-repair', { orderId: c.req.param('id') })),
  );

  // -- the customer portal (the per-entity proof walk) ------------------------
  app.get('/api/portal/repairs', async (c) => c.json(await (await S(c)).invoke('shop/portal-repairs')));

  // -- invoicing (the sibling engine, fed by event) ---------------------------
  app.get('/api/invoicing', async (c) => c.json(await (await S(c)).invoke('invoicing/list')));
  app.get('/api/invoicing/:id', async (c) =>
    c.json(await (await S(c)).invoke('invoicing/get', { underlagId: c.req.param('id') })),
  );
  app.post('/api/invoicing/:id/export', async (c) =>
    c.json(await (await S(c)).invoke('invoicing/export', { underlagId: c.req.param('id') })),
  );
}
