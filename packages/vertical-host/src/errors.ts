/**
 * One vocabulary for "what HTTP status does this throw deserve".
 *
 * The platform surface (`mountPlatformSurface`) has answered that question since
 * #510: a refused permission is 403, a missing thing 404, a broken invariant 409,
 * a runtime fault 502, anything else the caller's 400. The operations mount
 * (`mountOperations`) answered it not at all — every failure reached Hono's
 * default handler as a bare 500, so a permission denial was indistinguishable
 * from a crash (#791). Two surfaces on the same worker, disagreeing about the
 * same kernel errors, is one classification too many; this module is it.
 *
 * Errors are recognised BY SHAPE, not by `instanceof`. A `ScopeStub` call may
 * cross a Durable Object boundary, where the error is re-created from its wire
 * form and no class survives — and even in-process, two copies of `@substrat-run/kernel`
 * make `instanceof` a coin toss. So: the class when it is there, the `name` when
 * it is not, and the message last.
 */
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  errorCodeOf,
  PROBLEM_CATALOG,
  PROBLEM_CONTENT_TYPE,
  problemForStatus,
  toProblem,
  type Problem,
} from '@substrat-run/contracts';
import { PermissionDenied } from '@substrat-run/kernel';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** A classified failure: the status it deserves and the message to relay. */
export interface ErrorClassification {
  readonly status: ContentfulStatusCode;
  readonly message: string;
  /** The runtime failed, not the request — the caller may retry (#559). */
  readonly platformFault?: boolean;
}

/** The message a thrown value carries, whatever kind of value it is. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A throw that names the RUNTIME failing, not the request (#559). Two signals, either
 * sufficient: the flags workerd sets on transient Durable Object errors (`retryable`,
 * `overloaded`), and the message shapes the runtime is known to emit — foremost DO
 * SQLite's redacted `internal error; reference = <id>`, whose reference resolves only at
 * Cloudflare support. The patterns are anchored/specific on purpose: an APP error that
 * merely mentions "internal error" mid-sentence is still the caller's 400.
 */
const PLATFORM_FAULT_PATTERNS = [
  /^internal error(?:;|$)/i,
  /^durable object reset/i,
  /^durable object storage operation/i,
  /transient (?:issue|error)/i,
  /^network connection lost/i,
];

export function isPlatformFault(err: unknown, message: string): boolean {
  const flags = err as { retryable?: unknown; overloaded?: unknown } | null;
  if (flags?.retryable === true || flags?.overloaded === true) return true;
  return PLATFORM_FAULT_PATTERNS.some((p) => p.test(message));
}

/** A refused permission, however it reached us. */
function isPermissionDenied(err: unknown, message: string): boolean {
  return (
    err instanceof PermissionDenied ||
    (err as { name?: unknown } | null)?.name === 'PermissionDenied' ||
    /permission denied/i.test(message)
  );
}

/**
 * An input that failed to parse — a `ZodError`, read structurally for the same
 * reason `mountOperations` reads schemas structurally: `instanceof` does not
 * survive a duplicate copy of the library or a serialising boundary. `issues`
 * is Zod's own array and nothing else in this path carries one.
 */
function isParseFailure(err: unknown): boolean {
  const e = err as { name?: unknown; issues?: unknown } | null;
  return e?.name === 'ZodError' || Array.isArray(e?.issues);
}

/**
 * The status a throw deserves, or `undefined` when this vocabulary has no
 * opinion about it.
 *
 * "No opinion" is a real answer, and callers depend on it: `mountOperations`
 * re-throws an unclassified error untouched so a vertical's own `app.onError`
 * still gets to map its own domain errors, exactly as it does today. Only
 * `mountPlatformSurface` — which owns its whole surface — turns no-opinion into
 * the caller's 400.
 *
 * An explicit `HTTPException` status is authoritative EXCEPT for 400: that is
 * the status a generic throw acquires on the way here, so it stays open to the
 * patterns below. A route that means "400, final" gets 400 either way.
 */
export function classifyError(err: unknown): ErrorClassification | undefined {
  const message = messageOf(err);
  const explicit = err instanceof HTTPException ? err.status : undefined;
  if (explicit !== undefined && explicit !== 400) return { status: explicit, message };
  if (isPlatformFault(err, message)) return { status: 502, message, platformFault: true };

  // The taxonomy first (#113): a throw that declared what it is outranks every guess
  // below it. This reads the code by SHAPE — the live property in-process, the `name`
  // once it has crossed the ScopeDO hop — so it is the same answer on both paths,
  // which is exactly what the message patterns underneath could never manage.
  const code = errorCodeOf(err);
  if (code !== undefined) {
    return { status: PROBLEM_CATALOG[code].status as ContentfulStatusCode, message };
  }

  if (isPermissionDenied(err, message)) return { status: 403, message };
  if (isParseFailure(err)) return { status: 400, message };
  if (/not found|unknown scope/i.test(message)) return { status: 404, message };
  if (/invalid transition|immutable/i.test(message)) return { status: 409, message };
  return explicit === undefined ? undefined : { status: explicit, message };
}

/** A classified failure, rendered — the status to answer with and the body to send. */
export interface ClassifiedProblem {
  readonly status: ContentfulStatusCode;
  readonly body: Problem;
  /** The runtime failed, not the request — the caller may retry (#559). */
  readonly platformFault?: boolean;
}

/**
 * The typed error underneath a wrapper, when there is one.
 *
 * `mountOperations` re-throws what it classifies as `new HTTPException(status, {
 * message, cause: err })` — deliberately, so an app that owns an error envelope keeps
 * owning the body. That wrapper carries no code, so reading the OUTER error would
 * answer `about:blank` for exactly the failures the taxonomy describes best: a refused
 * permission loses its `permission`, a parse failure loses its `errors[]`. The cause is
 * where they still are.
 */
function typedCause(err: unknown): unknown {
  if (!(err instanceof HTTPException)) return err;
  const cause = err.cause;
  return cause !== undefined && errorCodeOf(cause) !== undefined ? cause : err;
}

/**
 * What a throw becomes on the wire — #113 phase 4.
 *
 * **The status is `classifyError`'s, unchanged.** This function decides the BODY, not
 * the blame: every status this surface answers with today it still answers with,
 * including the two the taxonomy would have argued about — an unrecognised throw's 400
 * (#559) and a Durable Object fault's 502.
 *
 * The body then carries a `code` only when the classified status is what that code
 * MEANS. Where they disagree the status won and the code did not survive the
 * disagreement, so claiming it would describe the failure as something the response
 * line contradicts; `about:blank` says the honest thing instead (`problemForStatus`).
 */
export function problemFor(err: unknown, instance?: string): ClassifiedProblem {
  const seen = classifyError(err) ?? {
    status: 400 as ContentfulStatusCode,
    message: messageOf(err),
  };
  return problemOf(seen, err, instance);
}

/**
 * The same rendering, for a caller that already decided the status.
 *
 * `mountPlatformSurface`'s `deps.mapError` is one: a vertical may map its own throws to
 * a status before this vocabulary is consulted, and its answer must still become a
 * problem body rather than the only `{ error }` left on the surface.
 */
export function problemOf(
  seen: ErrorClassification,
  err: unknown,
  instance?: string,
): ClassifiedProblem {
  const inner = typedCause(err);
  const code = errorCodeOf(inner);
  const body =
    code !== undefined && PROBLEM_CATALOG[code].status === seen.status
      ? toProblem(inner, instance)
      : problemForStatus(seen.status, seen.message, instance);
  return { status: seen.status, body, ...(seen.platformFault ? { platformFault: true } : {}) };
}

/**
 * The whole of a vertical's error envelope, in one call.
 *
 * `c.body` rather than `c.json`: the media type is `application/problem+json` and a
 * response that says `application/json` is not a problem document, whatever its shape.
 *
 * An `HTTPException` that already carries its own `res` is handed back untouched — a
 * route that attached a response meant it, and re-rendering it would drop headers
 * (a redirect, a `WWW-Authenticate`) the route chose.
 *
 * **Recognised structurally, not by `instanceof`.** A pushed vertical is a bundle, and a
 * bundle can hold two copies of `hono/http-exception` — one resolved for this package,
 * one for the vertical. `err instanceof HTTPException` is then false for a genuine
 * exception, this promise silently stops being kept, and the response the route
 * carefully attached is discarded in favour of a document rebuilt from an exception that
 * usually carries no message. That is not hypothetical: it shipped, and production
 * answered a 401 with an empty `detail` and no `WWW-Authenticate` while every test
 * passed — because a test has exactly one copy of Hono.
 */
export function problemResponse(c: Context, err: unknown): Response {
  const attached = (err as { res?: unknown } | null)?.res;
  if (attached instanceof Response) return attached;
  if (err instanceof HTTPException && err.res) return err.getResponse();
  const { status, body } = problemFor(err, c.req.path);
  return c.body(JSON.stringify(body), status, { 'content-type': PROBLEM_CONTENT_TYPE });
}
