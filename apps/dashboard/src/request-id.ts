import type { Context, MiddlewareHandler } from 'hono';
import { REQUEST_ID_HEADER } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { requestIdOf } from '@substrat-run/vertical-host';

/**
 * #2192: every answer the dashboard worker gives carries an id a person can quote.
 *
 * The id is minted HERE, a ULID per request, and never read from the request: an
 * `x-substrat-request-id` the caller sent is a claim, and echoing it would let anyone put a
 * chosen string into the dashboard's responses and its log. It is set on the context under
 * the same key the platform's `invocationLog` uses, so `requestIdOf(c)` reads it here as it
 * does in a vertical, and goes on the response after the handler, so a response a route built
 * itself (or one `onError` rendered) carries it too.
 *
 * The id has the platform request id's shape, but it names a request to the DASHBOARD's own
 * worker. That worker writes no invocation line, and its log lines are filtered out of every
 * tenant's Observability view (only services the tenant owns are read), so pasting one into
 * an app's Requests view finds nothing there. It is for an operator reading the dashboard
 * worker's own logs, where {@link logFailedRequest}'s line carries it.
 *
 * Registered before every route, so the OIDC routes and the API alike are covered.
 */
export function dashboardRequestId(): MiddlewareHandler {
  return async (c, next) => {
    const id = ulid();
    c.set('substratInvocationId', id);
    await next();
    // An upgrade's socket would be dropped by the copy Hono makes of an answered response.
    if (c.res.status !== 101) c.header(REQUEST_ID_HEADER, id);
    if (c.res.status >= 500) logFailedRequest(c, id);
  };
}

/**
 * One line per 5xx, for the operator: the id the caller was shown, and what failed. The path
 * carries no query string, because a callback's query holds a consent code or a state token.
 */
function logFailedRequest(c: Context, requestId: string): void {
  const err = c.error;
  const error = err === undefined ? undefined : (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 500);
  console.error(
    JSON.stringify({ event: 'dashboard.request-failed', requestId, method: c.req.method, path: c.req.path, status: c.res.status, error }),
  );
}

/** A response body carrying this request's id, so a caller who saw only the body can quote it. */
export function withRequestIdOf<T extends object>(body: T, c: Context): T & { requestId?: string } {
  const requestId = requestIdOf(c);
  return requestId === undefined ? body : { ...body, requestId };
}
