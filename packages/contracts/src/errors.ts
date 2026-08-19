import { z } from 'zod';
import { entityRef } from './events.js';

/**
 * The ONE error model for every surface on the platform (`docs/rfc/error-model.md`,
 * issue #113): RFC 9457 `application/problem+json`, a CLOSED code taxonomy, and one
 * mapper — replacing the seven hand-rolled `onError` handlers that today choose a
 * status by matching on error message TEXT.
 *
 * Three properties this is built for:
 *
 * - **Machine-readable.** `validation_failed on field 'email'` is recoverable by a
 *   client — or by a build agent — without a person reading a log. `500 Something
 *   went wrong` is not.
 * - **Documentable.** The same schema that validates a problem body is emitted into
 *   `/openapi.json` (`openapi.ts`), so the API surface finally describes how it can
 *   FAIL and not only how it succeeds. Decision 22 cashed in again.
 * - **Additive to adopt.** Nothing throws these yet. `toProblem` maps an unrecognised
 *   throw to `internal` exactly as today's transports do, so this module can land,
 *   ship and be reviewed before a single call site changes.
 *
 * ## Phase 1 of four
 *
 * This is the contracts layer only. The kernel throwing typed errors, and the
 * `ScopeDO` RPC hop preserving them (Workers RPC rebuilds a thrown error as a plain
 * `Error`, which is why `instanceof PermissionDenied` is false in production today),
 * are phase 2 — see the RFC's §3 and §5.
 */

/**
 * The base for `type` URIs.
 *
 * DERIVED from the code rather than written per entry, deliberately: whether we
 * actually serve a page at each of these URLs is still open (RFC §6 Q2), and nothing
 * throws a problem yet, so no `type` value has reached a client. Flipping the
 * decision stays a one-line change here for exactly as long as that holds.
 */
export const PROBLEM_TYPE_BASE = 'https://substrat.net/errors';

/**
 * The taxonomy. CLOSED — an open one is a suggestion.
 *
 * A module never invents a code. It narrows an existing one with a `reason` slug it
 * owns (`conflict` + `reason: 'already_exported'`), which is the star topology
 * applied to failure: a vertical branches on an engine's reason without importing
 * the engine's types.
 */
export const errorCode = z.enum([
  'unauthenticated',
  'permission_denied',
  'forbidden',
  'not_found',
  'conflict',
  'validation_failed',
  'precondition_failed',
  'rate_limited',
  'unavailable',
  'internal',
]);
export type ErrorCode = z.infer<typeof errorCode>;

/** `permission_denied` → `https://substrat.net/errors/permission-denied`. */
export function problemTypeFor(code: ErrorCode): string {
  return `${PROBLEM_TYPE_BASE}/${code.replaceAll('_', '-')}`;
}

/**
 * Status and human title per code. `Record<ErrorCode, …>` on purpose: adding a code
 * without deciding what it means to HTTP is then a compile error, not a 500 found in
 * production.
 */
export const PROBLEM_CATALOG = {
  unauthenticated: { status: 401, title: 'Unauthenticated' },
  permission_denied: { status: 403, title: 'Permission denied' },
  forbidden: { status: 403, title: 'Forbidden' },
  not_found: { status: 404, title: 'Not found' },
  conflict: { status: 409, title: 'Conflict' },
  validation_failed: { status: 400, title: 'Validation failed' },
  precondition_failed: { status: 412, title: 'Precondition failed' },
  rate_limited: { status: 429, title: 'Rate limited' },
  unavailable: { status: 503, title: 'Service unavailable' },
  internal: { status: 500, title: 'Internal error' },
} as const satisfies Record<ErrorCode, { status: number; title: string }>;

/** One field-level complaint, mapped from a Zod issue. */
export const validationIssue = z.object({
  /** Dotted path into the input: `lines.0.quantity`. Empty for a root-level issue. */
  path: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof validationIssue>;

/**
 * The extension members each code may carry — declared per entry, never free-form.
 *
 * These are enforced where it matters: at the THROW site, by `substratError`, which
 * both types and parses them. The wire schema below is one flat object rather than a
 * ten-way discriminated union, because a `oneOf` of ten variants documents worse than
 * one object does and buys a narrowing no client asked for. Per-code narrowing of the
 * emitted document is RFC §6 Q1, deferred with the model layer that would own it.
 */
export const PROBLEM_EXTENSIONS = {
  unauthenticated: z.strictObject({}),
  permission_denied: z.object({
    /** The permission key the check refused. */
    permission: z.string().min(1).optional(),
    /** Set when the refusal was a per-entity check rather than a node-level one. */
    entity: entityRef.optional(),
  }),
  forbidden: z.object({ reason: z.string().min(1).optional() }),
  not_found: z.strictObject({}),
  conflict: z.object({ reason: z.string().min(1).optional() }),
  validation_failed: z.object({ errors: z.array(validationIssue).optional() }),
  precondition_failed: z.strictObject({}),
  rate_limited: z.object({ retryAfter: z.number().int().nonnegative().optional() }),
  unavailable: z.strictObject({}),
  internal: z.strictObject({}),
} as const satisfies Record<ErrorCode, z.ZodType>;

/** The extensions legal on one code, as a type — what `substratError` accepts. */
export type ExtensionsFor<C extends ErrorCode> = z.infer<(typeof PROBLEM_EXTENSIONS)[C]>;

/**
 * The wire body. RFC 9457 members, plus `code`, plus every declared extension.
 *
 * `errors.test.ts` asserts this object carries every field any entry of
 * `PROBLEM_EXTENSIONS` declares — the join between the two is checked in CI rather
 * than by remembering to edit both.
 */
export const problem = z.object({
  /** Canonical identifier. Resolves — an error that documents itself. */
  type: z.string().min(1),
  /** Short, human, and STABLE per code — clients may group on it, so it does not vary. */
  title: z.string().min(1),
  /** Duplicated from the HTTP status line, per RFC 9457 §3.1.2. */
  status: z.number().int(),
  /** What went wrong THIS time. Absent on `internal`, always — see `toProblem`. */
  detail: z.string().optional(),
  /** The request this refers to, when a transport knows it. */
  instance: z.string().optional(),
  /**
   * DEPRECATED duplicate of `detail`, for one migration window.
   *
   * Every SPA in the repo reads `{ error }` today. RFC 9457 permits extension
   * members, so carrying this lets the transports adopt problem+json without
   * breaking a single client — which is what makes the rollout's phase 3 a
   * non-event. Removed once the clients are moved, not "eventually".
   */
  error: z.string().optional(),
  code: errorCode,
  // -- declared extensions (see PROBLEM_EXTENSIONS) ---------------------------
  permission: z.string().min(1).optional(),
  entity: entityRef.optional(),
  reason: z.string().min(1).optional(),
  errors: z.array(validationIssue).optional(),
  retryAfter: z.number().int().nonnegative().optional(),
});
export type Problem = z.infer<typeof problem>;

/**
 * How a code crosses a boundary that keeps only `name`, `message` and `stack`.
 *
 * The `ScopeDO` RPC hop is that boundary: the adapter rebuilds a thrown error as a
 * plain `Error`, so the class and every own property are gone by the time a transport
 * sees it — which is why `instanceof PermissionDenied` is false in production.
 *
 * The RFC proposed a sentinel prefix on `message`. `name` is the better carrier and
 * this supersedes that: `message` is read by humans, printed in logs, and asserted on
 * by ~30 contract-suite patterns, while `name` is already preserved by Workers RPC and
 * already exists to say what kind of error this is. The messages stay pristine.
 *
 * The cost, stated plainly: `name` carries the CODE and not the extensions, so
 * `permission` / `reason` / `errors` do not survive that hop. In-process — the SQLite
 * adapter, and any handler in the same isolate — the real class arrives and they do.
 * Carrying extensions across too means an envelope on `ScopeDO.invoke` rather than a
 * throw, which is the RFC §3 successor and is not this change.
 */
export const ERROR_NAME_PREFIX = 'Substrat.';

/**
 * Class names that predate the taxonomy and already mean a code.
 *
 * Keeping `PermissionDenied` named `PermissionDenied` rather than renaming it to the
 * generic form is deliberate: `vertical-host`'s classifier and several verticals match
 * on that exact string today, and a rename would be a silent behaviour change bundled
 * into a refactor. `ZodError` earns its row because a parse failure crossing the hop
 * loses its `issues` array — the code is all that is left, and `validation_failed`
 * without fields still beats `internal`.
 */
const CODE_BY_ERROR_NAME: Readonly<Record<string, ErrorCode>> = {
  PermissionDenied: 'permission_denied',
  SecretBoxUnconfiguredError: 'unavailable',
  ZodError: 'validation_failed',
};

/**
 * A throw that already knows what it means.
 *
 * `message` stays the human sentence and nothing more, so logs, stack traces and the
 * contract suite's message assertions all read exactly as they do today. The code
 * rides in `name`, which is what lets it survive the hop.
 */
export class SubstratError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly extensions: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, extensions: Record<string, unknown> = {}) {
    super(message);
    this.name = `${ERROR_NAME_PREFIX}${code}`;
    this.code = code;
    this.status = PROBLEM_CATALOG[code].status;
    this.extensions = extensions;
  }
}

/**
 * The code a throw carries, however little of it survived.
 *
 * Three readings, in order of fidelity: the live `code` property (same isolate), the
 * `Substrat.<code>` name (crossed a boundary), and the legacy class names above. A
 * throw this cannot classify is not ours, and `toProblem` answers `internal` for it.
 */
export function errorCodeOf(err: unknown): ErrorCode | undefined {
  if (err === null || typeof err !== 'object') return undefined;

  const own = (err as { code?: unknown }).code;
  if (typeof own === 'string') {
    const parsed = errorCode.safeParse(own);
    if (parsed.success) return parsed.data;
  }

  const name = (err as { name?: unknown }).name;
  if (typeof name !== 'string') return undefined;
  if (name.startsWith(ERROR_NAME_PREFIX)) {
    const parsed = errorCode.safeParse(name.slice(ERROR_NAME_PREFIX.length));
    if (parsed.success) return parsed.data;
  }
  return CODE_BY_ERROR_NAME[name];
}

/**
 * Build a typed error. The extensions are checked against the code at COMPILE time
 * and parsed at runtime, so a `retryAfter` on a `not_found` is caught at the throw
 * site rather than discovered in a response body.
 */
export function substratError<C extends ErrorCode>(
  code: C,
  message: string,
  extensions?: ExtensionsFor<C>,
): SubstratError {
  const parsed = PROBLEM_EXTENSIONS[code].parse(extensions ?? {}) as Record<string, unknown>;
  return new SubstratError(code, message, parsed);
}

/**
 * Recognise one of ours — by shape, never by `instanceof` alone.
 *
 * Two copies of a package in one build already make `instanceof` a coin toss; a
 * serialising boundary makes it a certainty in the wrong direction.
 */
export function isSubstratError(err: unknown): err is SubstratError {
  return err instanceof Error && errorCodeOf(err) !== undefined;
}

/** Zod's issue list, flattened to the wire shape. */
export function validationIssuesFrom(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/**
 * Map any throw onto a problem body and its status — the one function replacing every
 * hand-rolled `onError` and the control plane's regex table.
 *
 * **`internal` never carries `detail`.** An unrecognised throw is by definition one
 * whose message nobody reviewed for what it discloses, and these surfaces have
 * cross-tenant reach. The existing posture is right; this preserves it rather than
 * quietly widening it in the name of better errors.
 */
export function toProblem(err: unknown, instance?: string): Problem {
  if (err instanceof z.ZodError) {
    return build('validation_failed', 'the input did not parse', instance, {
      errors: validationIssuesFrom(err),
    });
  }
  const code = errorCodeOf(err);
  if (code !== undefined && err instanceof Error) {
    // `internal` is still generic even when a throw asked for it by name: the rule is
    // about what reaches a client, not about who chose the code.
    if (code === 'internal') return build('internal', undefined, instance);
    const extensions = (err as SubstratError).extensions ?? {};
    return build(code, err.message, instance, extensions);
  }
  return build('internal', undefined, instance);
}

function build(
  code: ErrorCode,
  detail: string | undefined,
  instance: string | undefined,
  extensions: Readonly<Record<string, unknown>> = {},
): Problem {
  const { status, title } = PROBLEM_CATALOG[code];
  return problem.parse({
    type: problemTypeFor(code),
    title,
    status,
    ...(detail === undefined ? {} : { detail, error: detail }),
    ...(instance === undefined ? {} : { instance }),
    code,
    ...extensions,
  });
}

/**
 * The statuses an operation can actually answer with today, for the emitted document.
 *
 * `precondition_failed` (412) and `rate_limited` (429) are declared in the taxonomy
 * so that `If-Match` (#129) and rate limiting (#130) add no vocabulary when they
 * land — but nothing raises them yet, and documenting a failure that cannot occur is
 * worse than documenting none. They join this list with the features that raise them.
 *
 * This narrows the RFC's §6 Q1 leaning ("emit the full set") on the same reasoning
 * that motivated the question.
 */
export const DOCUMENTED_ERROR_CODES: readonly ErrorCode[] = [
  'validation_failed',
  'unauthenticated',
  'permission_denied',
  'forbidden',
  'not_found',
  'conflict',
  'unavailable',
  'internal',
];
