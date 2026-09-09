import type { Context, Hono } from 'hono';
import { problemResponse } from '@substrat-run/vertical-host';
import {
  isPage,
  listPageQuery,
  LIST_SORT_PARAM,
  nextPageLink,
  PAGE_LINK_HEADER,
  PAGE_TOTAL_HEADER,
} from '@substrat-run/contracts';
import type { ScopeStub } from '@substrat-run/kernel';

/**
 * The bike shop's HTTP API — ONE route table, adapter- and auth-agnostic.
 *
 * Both entrypoints mount this: `server.ts` (node, pure-SQLite adapter, OIDC against the
 * local dev issuer) and `worker.ts` (Cloudflare, Durable-Object adapter, the auth seam). Each
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

/**
 * The page trio, off the query string — what a route hands a PAGED operation.
 *
 * A paged read takes `limit`/`cursor` (and, where its declaration offers them,
 * `order`/`sort`) as ordinary input, so a route that forwards nothing pins its
 * endpoint to page one forever: the operation still pages, the caller just has
 * no way to say which page it wants. Parsed with the platform's own
 * `listPageQuery`, so this endpoint's default page size and its ceiling are the
 * same numbers every other list read on the platform uses — a hand-written route
 * table is not a licence to invent a second convention.
 *
 * `order` and `sort` travel only when asked for, so the DECLARATION's own
 * defaults stay the answer when a caller says nothing.
 */
function pageInput(c: Context): Record<string, unknown> {
  const q = c.req.query();
  const page = listPageQuery.parse({ limit: q['limit'], cursor: q['cursor'], order: q['order'] });
  return {
    limit: page.limit,
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
    ...(page.order === undefined ? {} : { order: page.order }),
    ...(q[LIST_SORT_PARAM] === undefined ? {} : { sort: q[LIST_SORT_PARAM] }),
  };
}

/**
 * A page's answer on the WIRE: the entries are the body, the walk rides in
 * headers (`Link: <…?cursor=…>; rel="next"`, RFC 8288).
 *
 * The operation's own shape stays `Page<T>` — a test, a seed or another
 * operation must be able to walk a list with no HTTP response to read headers
 * off — so this is a projection at the edge, not a change to what the operation
 * returns. Adopting paging then costs a client nothing: a list endpoint returns
 * the array it always returned and gains a walk it did not have.
 *
 * `isPage` is CHECKED rather than assumed, so an operation that has not adopted
 * `pageOf` yet reaches the client unchanged instead of being emptied into a body
 * of `undefined`.
 *
 * This is the same projection `mountOperations` (@substrat-run/vertical-host)
 * performs for a declared surface. This route table is hand-written, so it does
 * it here — one helper, used by every paged read below.
 */
function pageJson(c: Context, result: unknown): Response {
  if (!isPage(result)) return c.json(result as never);
  const link = nextPageLink(c.req.url, result.nextCursor);
  if (link) c.header(PAGE_LINK_HEADER, link);
  const total = (result as { total?: unknown }).total;
  if (typeof total === 'number') c.header(PAGE_TOTAL_HEADER, String(total));
  return c.json(result.entries as never);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountApi(app: Hono<any, any, any>, resolveStub: ResolveStub): void {
  const S = resolveStub;
  const body = (c: Context) => c.req.json<Record<string, unknown>>();

  /**
   * One error vocabulary, shared with the platform surface: `problemResponse`
   * (@substrat-run/vertical-host) is built on the same `classifyError` that
   * `mountPlatformSurface` uses, so a permission denial is 403, a missing thing 404, a
   * broken invariant 409, a runtime fault 502 — identically on both hosts. "No opinion"
   * becomes the caller's 400.
   *
   * The body is RFC 9457 `application/problem+json`: a `code` from the closed taxonomy
   * when your throw declared one (`substratError('conflict', …)`), `about:blank` when it
   * did not. `{ error }` rides along for one deprecation window, so a client reading it
   * keeps working while you move to `code`.
   *
   * In `worker.ts` this handler is REPLACED: Hono keeps only the last-registered
   * `onError`, and `mountPlatformSurface` installs its own. That is harmless precisely
   * because both are built on the same vocabulary — same input, same answer. Registering
   * it here is what gives `server.ts`, which mounts no platform surface, the same
   * behaviour.
   */
  app.onError((err, c) => problemResponse(c, err));

  // -- generic invoke ---------------------------------------------------------
  // The kernel checks a permission inside EVERY operation, so a generic route is
  // exactly as safe as one route per operation. It is the escape hatch that keeps a
  // new operation reachable before it has a named route — on BOTH hosts, deliberately.
  app.post('/api/invoke', async (c) => {
    const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
    return c.json((await (await S(c)).invoke(op, input)) ?? null);
  });

  // -- customers, bikes, price list (the vertical's own tables) ---------------
  app.get('/api/customers', async (c) =>
    pageJson(c, await (await S(c)).invoke('shop/list-customers', pageInput(c))),
  );
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
  app.get('/api/prices', async (c) =>
    pageJson(c, await (await S(c)).invoke('shop/price-list', pageInput(c))),
  );
  app.post('/api/prices', async (c) =>
    c.json(await (await S(c)).invoke('shop/upsert-price', await c.req.json())),
  );

  // -- repairs ---------------------------------------------------------------
  // create/complete/close are the VERTICAL's operations (they wrap the engine and own
  // the pricing moment); assign/start/report/get/list are the ENGINE's own, invoked
  // directly. Which is which is the composition boundary, visible right here.
  app.get('/api/repairs', async (c) =>
    pageJson(
      c,
      await (await S(c)).invoke('workorder/list', {
        status: c.req.query('status'),
        ...pageInput(c),
      }),
    ),
  );
  app.post('/api/repairs', async (c) =>
    c.json(await (await S(c)).invoke('shop/create-repair', await c.req.json())),
  );
  app.get('/api/repairs/:id', async (c) =>
    c.json(await (await S(c)).invoke('workorder/get', { orderId: c.req.param('id') })),
  );
  app.get('/api/repairs/:id/timeline', async (c) =>
    pageJson(
      c,
      await (await S(c)).invoke('shop/timeline', {
        entityType: 'workorder',
        entityId: c.req.param('id'),
        ...pageInput(c),
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
  app.get('/api/portal/repairs', async (c) =>
    pageJson(c, await (await S(c)).invoke('shop/portal-repairs', pageInput(c))),
  );

  // -- invoicing (the sibling engine, fed by event) ---------------------------
  app.get('/api/invoicing', async (c) =>
    pageJson(c, await (await S(c)).invoke('invoicing/list', pageInput(c))),
  );
  app.get('/api/invoicing/:id', async (c) =>
    c.json(await (await S(c)).invoke('invoicing/get', { underlagId: c.req.param('id') })),
  );
  app.post('/api/invoicing/:id/export', async (c) =>
    c.json(await (await S(c)).invoke('invoicing/export', { underlagId: c.req.param('id') })),
  );
}
