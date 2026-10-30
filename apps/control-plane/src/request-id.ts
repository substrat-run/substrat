import type { Context, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import { ERROR_NAME_PREFIX, PROBLEM_CONTENT_TYPE, REQUEST_ID_HEADER, errorCode, errorCodeOf } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';

/**
 * #113, #2192: every `/api` answer the control plane gives carries an id a person can quote —
 * the console, the CLI and a support thread alike.
 *
 * The id is minted HERE, a ULID per request, and never read from the request: an
 * `x-substrat-request-id` the caller sent is a claim, not ours to repeat. It goes on the
 * response as that header after the handler, so a response a route built itself (or an
 * `onError` rendered) carries it too, and into a problem document's body as `requestId`, so a
 * caller who kept only the body can quote it as well. The dashboard does the same for its own
 * worker (`apps/dashboard/src/request-id.ts`).
 *
 * Registered first on `/api/*`, so it sees the answer every later middleware settled on.
 */
export function controlPlaneRequestId(): MiddlewareHandler {
  return async (c, next) => {
    const id = ulid();
    // The API router reuses it as a failure's reference, so detail, log rows and header agree.
    c.set('substratInvocationId', id);
    await next();
    // An upgrade's socket would be dropped by the copy Hono makes of an answered response.
    if (c.res.status === 101) return;
    await stampProblem(c, id);
    c.header(REQUEST_ID_HEADER, id);
    if (c.res.status >= 500) logFailedRequest(c, id);
  };
}

/**
 * Add `requestId` to a problem document that has none. Only an `application/problem+json`
 * body that parses as a JSON object is rewritten; anything else is handed back as it came.
 * Status and headers are kept; `content-length` is dropped, since the body grew.
 */
async function stampProblem(c: Context, requestId: string): Promise<void> {
  const res = c.res;
  if (!(res.headers.get('content-type') ?? '').startsWith(PROBLEM_CONTENT_TYPE)) return;
  const body: unknown = await res
    .clone()
    .json()
    .catch(() => undefined);
  if (typeof body !== 'object' || body === null || Array.isArray(body) || 'requestId' in body) return;
  c.res = new Response(JSON.stringify({ ...body, requestId }), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
  // Hono's setter copies the previous response's headers onto the new one, length included.
  c.res.headers.delete('content-length');
}

/**
 * One line per 5xx, for the operator: the id the caller was shown, and what failed, in fixed
 * vocabulary only. The route is its PATTERN, never the path it was called with, which carries
 * tenant and scope ids and, past the `?`, whatever the caller put there. No message is logged,
 * our own included: a relayed detail is free text nobody here authored.
 */
function logFailedRequest(c: Context, requestId: string): void {
  const err = c.error;
  const code = errorCodeOf(err);
  console.error(
    JSON.stringify({
      event: 'control-plane.request-failed',
      requestId,
      method: c.req.method,
      route: routePath(c),
      status: c.res.status,
      ...(err === undefined ? {} : { errorName: err instanceof Error && isCodeName(err.name) ? err.name : 'Error' }),
      ...(code ? { errorCode: code } : {}),
    }),
  );
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/**
 * A class name is code's, unless something assigned `name`. A `SubstratError` assigns
 * `Substrat.<code>` itself, which counts only with a code the catalog declares.
 */
function isCodeName(name: string): boolean {
  if (name.startsWith(ERROR_NAME_PREFIX)) return errorCode.safeParse(name.slice(ERROR_NAME_PREFIX.length)).success;
  return IDENTIFIER.test(name);
}
