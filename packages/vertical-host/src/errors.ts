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
import { HTTPException } from 'hono/http-exception';
import { errorCodeOf, PROBLEM_CATALOG } from '@substrat-run/contracts';
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
