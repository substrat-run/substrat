import {
  PROBLEM_CONTENT_TYPE,
  SubstratError,
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
 * staff roster, the CLI login broker, the `/api` auth rewrite, the `/internal` relays (email,
 * connections, connect URLs and links, mail-in, drain-scope), the connector callbacks and the
 * relay gateway — plus what its `onError` answers. They return a plain `Response` so a gate
 * that is not a Hono handler (the members gate, the gateway) can use them too.
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
 * `carried` is a member the route answered beside the sentence before #113: the connection
 * relay's `probe`. No in-repo reader of the relay takes it (the dashboard's connect form reads
 * its probe through `/api`), but the body stays a superset of what it was, so it rides as
 * `control-plane-api`'s `refuseStatus` carries it, outside the declared extensions.
 */
export function refuseStatus(status: number, detail: string, carried?: Readonly<Record<string, unknown>>): Response {
  return problemResponse(problemForStatus(status, detail), carried);
}

/**
 * A relay error class's refusal (#113): by its `code` when its status carries one, else by
 * the status alone. The status is the same either way (`codeForRefusalStatus` maps only a
 * status the catalog answers with), and so is the sentence; only `type` and `code` differ.
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
 * What a throw no route caught is answered with. A `SubstratError` (the kernel's
 * `PermissionDenied` and `SecretBoxUnconfiguredError` included, and one `fromWireFailure`
 * rebuilt) declared what it is, so it keeps its code, its status and its sentence. Anything
 * else is a bare `internal` 500 with no detail, so an unreviewed message never reaches the
 * caller. That includes a `ZodError`, which here is the SERVER failing to parse its own data (a
 * stored binding's options, a provider's answer, an output schema), never the caller's input:
 * `toProblem` alone would read it by shape as `validation_failed` and blame the caller with a
 * 400, and would read any plain error carrying a taxonomy `code` the same way.
 *
 * Without this, Hono answers a text 500.
 */
export function problemForThrow(err: unknown): Response {
  return problemResponse(toProblem(err instanceof SubstratError ? err : undefined));
}

