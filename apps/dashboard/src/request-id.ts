import type { Context, MiddlewareHandler } from 'hono';
import { ERROR_NAME_PREFIX, REQUEST_ID_HEADER, errorCode, errorCodeOf } from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { ulid } from '@substrat-run/kernel';
import { RouteOutputMismatch, requestIdOf } from '@substrat-run/vertical-host';

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
 *
 * What failed is named by fixed vocabulary only, never by a message. A message is free text,
 * and much of it is not ours: a `ControlPlaneError`'s is the plane's problem detail, which a
 * handler may rethrow inside an `HTTPException`, and no pattern can promise that a detail
 * holds no token or personal data. So the line carries the error's class name (or, for a
 * `SubstratError`, its `Substrat.<code>` name), the declared
 * code (from the error catalog, by `errorCodeOf` or the plane's `problemCode`), the
 * plane's status when the plane was the failure, and, when a declared route answered outside
 * its output, the route and the issue paths. The message stays in the response the caller
 * already holds, where the id now leads to this line.
 */
function logFailedRequest(c: Context, requestId: string): void {
  console.error(
    JSON.stringify({
      event: 'dashboard.request-failed',
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ...failureOf(c.error),
    }),
  );
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/**
 * A class name is code's, unless something assigned `name`: then it is just `Error`. A
 * `SubstratError` assigns one itself, `Substrat.<code>`, so that shape is code's too, but only
 * with a code the catalog declares: the dot is not licence for anything after it.
 */
function isCodeName(name: string): boolean {
  if (name.startsWith(ERROR_NAME_PREFIX)) return errorCode.safeParse(name.slice(ERROR_NAME_PREFIX.length)).success;
  return IDENTIFIER.test(name);
}

function failureOf(err: unknown): {
  errorName?: string;
  errorCode?: string;
  upstreamStatus?: number;
  route?: string;
  outputPaths?: readonly string[];
} {
  if (err === undefined) return {};
  const errorName = err instanceof Error && isCodeName(err.name) ? err.name : 'Error';
  // The plane's failure, thrown as itself or carried as the cause of what a handler rethrew.
  const plane = [err, err instanceof Error ? err.cause : undefined].find((e) => e instanceof ControlPlaneError);
  const code = errorCodeOf(err) ?? plane?.problemCode;
  return {
    errorName,
    ...(code ? { errorCode: code } : {}),
    ...(plane ? { upstreamStatus: plane.status } : {}),
    // #2401: the caller got a bare 500, so this line is where the drift can be found.
    ...(err instanceof RouteOutputMismatch ? { route: err.route, outputPaths: err.issuePaths } : {}),
  };
}

/** A response body carrying this request's id, so a caller who saw only the body can quote it. */
export function withRequestIdOf<T extends object>(body: T, c: Context): T & { requestId?: string } {
  const requestId = requestIdOf(c);
  return requestId === undefined ? body : { ...body, requestId };
}
