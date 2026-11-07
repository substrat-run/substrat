import {
  PROBLEM_CONTENT_TYPE,
  problemForStatus,
  substratError,
  toProblem,
  type ErrorCode,
  type Problem,
} from '@substrat-run/contracts';

/**
 * The control-plane worker's own refusals, as RFC 9457 problem documents (#113).
 *
 * `control-plane-api` answers its routes the same way (`refuse` / `refuseStatus` in its
 * `api.ts`); these are the same two moves for the routes this worker mounts itself — the
 * staff roster, the CLI login broker, the `/api` auth rewrite. They return a plain
 * `Response` so a gate that is not a Hono handler (the members gate) can use them too.
 *
 * The media type is the contract: a body shaped like a problem but labelled
 * `application/json` is not one. The deprecated `error` duplicate rides along (`toProblem`
 * and `problemForStatus` emit it), so a client that still reads `error` keeps working.
 */
function problemResponse(body: Problem, carried?: Readonly<Record<string, unknown>>): Response {
  return new Response(JSON.stringify(carried ? { ...body, ...carried } : body), {
    status: body.status,
    headers: { 'content-type': PROBLEM_CONTENT_TYPE },
  });
}

/** A refusal this worker decided, by its code: the status follows from the catalog. */
export function refuse(code: ErrorCode, detail: string): Response {
  return problemResponse(toProblem(substratError(code, detail)));
}

/**
 * A refusal answered by status alone, as `about:blank`: a status the closed taxonomy has no
 * code for (the 501 "no roster store bound"), or a relay error class's refusal that carries
 * no code (`refuseRelayed`: a 413, 422, 501 or 502, or one constructed without a code).
 *
 * `carried` is a member the route answered beside the sentence before #113: the connection
 * relay's `probe`. No in-repo reader of the relay takes it (the dashboard's connect form reads
 * its probe through `/api`), but the body stays a superset of what it was, so it rides as
 * `control-plane-api`'s `refuseStatus` carries it, outside the declared extensions.
 */
export function refuseStatus(status: number, detail: string, carried?: Readonly<Record<string, unknown>>): Response {
  return problemResponse(problemForStatus(status, detail), carried);
}

/**
 * A relay error class's refusal (#113): by its `code` when it carries one, else by the status
 * alone. The status is the same either way (`codeForRefusalStatus` maps only a status the
 * catalog answers with), and so are the sentence and its `error` duplicate. What differs is
 * `type`, `code` and `title`: the catalog's title replaces the status phrase (400 'Bad request'
 * becomes 'Validation failed', 429 'Too many requests' becomes 'Rate limited').
 */
export function refuseRelayed(
  err: { readonly status: number; readonly message: string; readonly code: ErrorCode | undefined },
  carried?: Readonly<Record<string, unknown>>,
): Response {
  return err.code
    ? problemResponse(toProblem(substratError(err.code, err.message)), carried)
    : refuseStatus(err.status, err.message, carried);
}

/**
 * What a throw no route caught is answered with: `toProblem`'s reading of it, so a typed
 * `SubstratError` keeps its code and anything else is a bare `internal` with no detail —
 * an unreviewed message never reaches the caller. Without it Hono answers a text 500.
 */
export function problemForThrow(err: unknown): Response {
  return problemResponse(toProblem(err));
}

