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
 * code for (the 501 "no roster store bound"), or one a relay's own error class carries
 * (`ConnectionRelayError`, `TenantMailRefusal`, …), whose throw sites name a status and no code.
 *
 * `carried` is a member the route answered beside the sentence before #113 and a client
 * still reads: the connection relay's `probe`, which the dashboard's connect form shows. It
 * rides as `control-plane-api`'s `refuseStatus` carries it, outside the declared extensions.
 */
export function refuseStatus(status: number, detail: string, carried?: Readonly<Record<string, unknown>>): Response {
  return problemResponse(problemForStatus(status, detail), carried);
}

/**
 * What a throw no route caught is answered with: `toProblem`'s reading of it, so a typed
 * `SubstratError` keeps its code and anything else is a bare `internal` with no detail —
 * an unreviewed message never reaches the caller. Without it Hono answers a text 500.
 */
export function problemForThrow(err: unknown): Response {
  return problemResponse(toProblem(err));
}

