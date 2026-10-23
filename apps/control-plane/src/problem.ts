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
function problemResponse(body: Problem): Response {
  return new Response(JSON.stringify(body), {
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
 * code for (the 501 "no roster store bound").
 */
export function refuseStatus(status: number, detail: string): Response {
  return problemResponse(problemForStatus(status, detail));
}

