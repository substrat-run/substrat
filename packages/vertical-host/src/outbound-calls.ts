/**
 * The outbound calls a request made, on its invocation line (#2192).
 *
 * A request that failed BECAUSE of an upstream answer — an OAuth callback whose token
 * exchange was refused — used to show a single `request` span: the call that actually
 * failed was nowhere on the timeline. So the platform's entry records every `fetch` the
 * request makes, the way it records its store calls (#2245): the request runs in an
 * `AsyncLocalStorage` holding its record, and a wrapped `globalThis.fetch` adds each call to
 * whichever record is current. Module code cannot fetch (boundary-lint R3); what is recorded
 * is the vertical's host code — its connectors and harness routes.
 *
 * ## What is written, and what never is
 *
 * The host, the method, the status, the time to the response headers, when in the request
 * the call started, and how it ended. Never a header, a body, a query string, a fragment or
 * userinfo, and the path only after {@link redactOutboundPath}: a path segment can be a
 * credential (an API key, a bot token), and a log line is read by a wider audience, for
 * longer, than the call ever had.
 *
 * A refusal by the PLATFORM — the egress worker answering a host the vertical never declared —
 * is recorded as `refused`, read off `x-substrat-egress: refused`. To the vertical's code it is
 * a bare 403, the same as the destination's own; on the line the two read differently.
 *
 * ## What it does not see
 *
 * - A `fetch` made inside a Durable Object (a consumer, a schedule, the drain): no request's
 *   record is current there.
 * - A `fetch` still running after the line was written (`waitUntil` work).
 * - A reference to `fetch` a bundle captured while its modules were evaluated: the entry
 *   installs the wrapper after that, because the vertical's import is evaluated first.
 *
 * ## It cannot fail the call
 *
 * Outside a request the wrapper hands the call straight to the runtime's `fetch`, and inside
 * one it passes the arguments on untouched — the body is never read, the signal never
 * replaced — and hands back the runtime's own response or rejection. Recording is advisory: a
 * throw from it is swallowed, never the call's.
 */
import {
  tallyOutboundCall,
  type OutboundCallLine,
  type OutboundCallOutcome,
  type OutboundCallTally,
} from '@substrat-run/kernel/invocation-line';

/**
 * The response header the egress worker marks its own refusals with — its `EGRESS_HEADER`
 * (`apps/vertical-egress/src/worker.ts`). Spelled twice, because the worker is not a package
 * this one can import; `outbound-calls.test.ts` holds the two equal.
 */
export const EGRESS_REFUSAL_HEADER = 'x-substrat-egress';

/** The scope-store transport's host: those calls are already named, as `storeCalls` (#2245). */
const STORE_CALL_HOST = 'store.substrat.internal';

/** What a redacted segment is written as. */
const REDACTED = '[redacted]';
/** A path longer than this is cut, after redaction. */
const PATH_MAX = 200;

/** Lowercase words, joined by `-` or `_`, each at most 16 letters: `messages`, `oauth_token`. */
const WORDS = /^[a-z]{1,16}(?:[-_][a-z]{1,16})*$/;
/** The same words with a short file extension: `me.json`, `token.json`, `clip.mp4`. */
const WORDS_WITH_EXTENSION = /^[a-z]{1,16}(?:[-_][a-z]{1,16})*\.[a-z][a-z0-9]{0,4}$/;
/** An integer of at most 10 digits: a page number, a small numeric id. */
const SMALL_INTEGER = /^[0-9]{1,10}$/;
/** A version: `v1`, `v2.1`, `v10.0.3`. */
const VERSION = /^v[0-9]{1,3}(?:\.[0-9]{1,3}){0,2}$/;

/**
 * Whether one path segment is kept as it is. Default-deny: a segment is kept ONLY when it is
 * lowercase words (each at most 16 letters, joined by `-` or `_`), optionally with a short file
 * extension, an integer of at most 10 digits, or a version token (`v1`, `v2.1`). Everything else
 * is redacted — every UUID and ULID, any segment mixing letters and digits (`oauth2`, `abc1234`),
 * anything with an uppercase letter (an owner or a repository named `Acme`), and any longer
 * number. An id in a path is not needed to diagnose a failed call: the host, the method, the
 * status, the outcome and the path's shape are.
 *
 * What still survives, stated: a lowercase-letter word of up to 16 letters (per part) and an
 * integer of up to 10 digits are written as they are, whatever they mean to the destination.
 */
export function keepsSegment(segment: string): boolean {
  return (
    segment === '' ||
    WORDS.test(segment) ||
    WORDS_WITH_EXTENSION.test(segment) ||
    SMALL_INTEGER.test(segment) ||
    VERSION.test(segment)
  );
}

/**
 * The path of an outbound URL as the line writes it: each segment that {@link keepsSegment}
 * does not keep is `[redacted]`, and the result is cut at {@link PATH_MAX} characters. The
 * query string and fragment are not part of a pathname and so never reach it.
 */
export function redactOutboundPath(pathname: string): string {
  const path = pathname
    .split('/')
    .map((segment) => (keepsSegment(segment) ? segment : REDACTED))
    .join('/');
  return path.length > PATH_MAX ? `${path.slice(0, PATH_MAX)}…` : path;
}

/**
 * A thrown value's class, when it reads as one — a capitalised name of letters only, ending in
 * `Error` or `Exception` (`TypeError`, `TimeoutError`, `DOMException`) — and `Error` otherwise.
 * Never its message. The name comes from whatever threw, a wrapper library included, so anything
 * else it holds is not written.
 */
const ERROR_CLASS = /^[A-Z][A-Za-z]{0,30}(?:Error|Exception)$/;
function errorName(e: unknown): string {
  const name = (e as { name?: unknown } | null)?.name;
  return typeof name === 'string' && ERROR_CLASS.test(name) ? name : 'Error';
}

/**
 * How a call that answered ended. `refused` only for the platform's own refusal: a 403 carrying
 * exactly `x-substrat-egress: refused`. The egress worker strips the mark from every answer it
 * passes through, and the status is required too, so a destination cannot make its own answer
 * read as the platform's.
 */
function answeredOutcome(response: { status: number; headers?: { get?(name: string): string | null } }): OutboundCallOutcome {
  if (response.status === 403 && response.headers?.get?.(EGRESS_REFUSAL_HEADER) === 'refused') return 'refused';
  return response.status >= 400 ? 'http-error' : 'ok';
}

/** How a call that rejected ended, and the class to name when it is `failed`. */
function rejectedOutcome(e: unknown): { outcome: OutboundCallOutcome; reason?: string } {
  const name = errorName(e);
  if (name === 'TimeoutError') return { outcome: 'timeout' };
  if (name === 'AbortError') return { outcome: 'aborted' };
  return { outcome: 'failed', reason: name };
}

/** The tally a request's calls go on: the invocation record, or anything shaped like it. */
export type OutboundRecording = OutboundCallTally;

/**
 * When each recording's request started — what a call's `atMs` is measured from. Kept beside
 * the record rather than on it, since the record is handed to the vertical's handler chain, and
 * under a GLOBAL symbol, since the copy that starts a request and the copy that recorded the
 * call may be different module instances (the stamp registry's reason).
 */
const SINCE = Symbol.for('substrat.outbound-since');

function sinceMap(): WeakMap<object, number> {
  const g = globalThis as unknown as Record<symbol, WeakMap<object, number> | undefined>;
  return (g[SINCE] ??= new WeakMap());
}

/** Note when the request a recording belongs to started. Never throws. */
export function markRequestStart(recording: OutboundRecording, started: number): void {
  try {
    sinceMap().set(recording, started);
  } catch {
    /* calls then sit at the request's start */
  }
}

/** What the wrapper needs from the platform: the recording of the request now running. */
export type CurrentRecording = () => OutboundRecording | undefined;

/** The destination of a `fetch`'s arguments, read without touching a body. `null` when unreadable. */
function destinationOf(input: unknown, init: unknown): { url: URL; method: string } | null {
  const fromRequest = typeof input === 'object' && input !== null && !(input instanceof URL);
  const raw = fromRequest ? (input as { url?: unknown }).url : input;
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  const initMethod = (init as { method?: unknown } | null | undefined)?.method;
  const requestMethod = fromRequest ? (input as { method?: unknown }).method : undefined;
  const method = typeof initMethod === 'string' ? initMethod : typeof requestMethod === 'string' ? requestMethod : 'GET';
  return { url, method: method.toUpperCase().slice(0, 16) };
}

/** Add one finished call to the recording. Never throws. */
function record(
  recording: OutboundRecording,
  destination: { url: URL; method: string },
  startedAt: number,
  end: { status: number | null; outcome: OutboundCallOutcome; reason?: string },
): void {
  try {
    const call: OutboundCallLine = {
      host: destination.url.host.toLowerCase(),
      path: redactOutboundPath(destination.url.pathname),
      method: destination.method,
      status: end.status,
      outcome: end.outcome,
      durationMs: Math.max(0, Date.now() - startedAt),
      atMs: Math.max(0, startedAt - (sinceMap().get(recording) ?? startedAt)),
      ...(end.reason !== undefined ? { reason: end.reason } : {}),
    };
    tallyOutboundCall(recording, call);
  } catch {
    // Recording is advisory: a call that cannot be recorded is one missing entry.
  }
}

type FetchFn = (input: unknown, init?: unknown) => Promise<{ status: number; headers?: { get?(name: string): string | null } }>;

/** The mark a wrapped `fetch` carries, shared by every copy of this module in the isolate. */
const WRAPPED = Symbol.for('substrat.outbound-fetch');

/**
 * Set while a recorder is handing a call on, synchronously, and cleared before it returns.
 *
 * Something that patches `globalThis.fetch` after the recorder is installed (instrumentation
 * that installs lazily) is wrapped again by the next request's install, so one call can pass
 * through two recorders: recorder → patch → recorder → runtime. The inner one sees this set and
 * hands the call straight on, so the call is recorded once, by the outermost recorder. It spans
 * only the synchronous part of the call, so concurrent calls never see each other's: a patch that
 * reaches the inner recorder only after an `await` is still recorded twice.
 */
const IN_CALL = Symbol.for('substrat.outbound-fetch.in-call');

/**
 * Wrap `fetch` so each call made while a request's recording is current is added to it.
 * Exported for the tests; the platform installs it with {@link installOutboundRecorder}.
 */
export function recordingFetch<F extends FetchFn>(original: F, current: CurrentRecording): F {
  const wrapped = function fetch(input: unknown, init?: unknown) {
    const g = globalThis as unknown as Record<symbol, unknown>;
    // An outer recorder is already recording this call: hand it on, unrecorded.
    if (g[IN_CALL] === true) return original.call(globalThis, input, init);
    let recording: OutboundRecording | undefined;
    let destination: { url: URL; method: string } | null = null;
    try {
      recording = current();
      if (recording) destination = destinationOf(input, init);
    } catch {
      recording = undefined;
    }
    // The runtime's `fetch` is called on `globalThis` — workerd refuses any other receiver.
    if (!recording || !destination || destination.url.hostname.toLowerCase() === STORE_CALL_HOST) {
      return original.call(globalThis, input, init);
    }
    const rec = recording;
    const dest = destination;
    const startedAt = Date.now();
    let pending: ReturnType<F>;
    g[IN_CALL] = true;
    try {
      pending = original.call(globalThis, input, init) as ReturnType<F>;
    } finally {
      g[IN_CALL] = false;
    }
    return pending.then(
      (response) => {
        let status: number | null = null;
        let outcome: OutboundCallOutcome = 'failed';
        try {
          status = response.status;
          outcome = answeredOutcome(response);
        } catch {
          /* recorded as far as it was read */
        }
        record(rec, dest, startedAt, { status, outcome });
        return response;
      },
      (e: unknown) => {
        let end: { outcome: OutboundCallOutcome; reason?: string } = { outcome: 'failed', reason: 'Error' };
        try {
          end = rejectedOutcome(e);
        } catch {
          /* recorded as a plain failure */
        }
        record(rec, dest, startedAt, { status: null, ...end });
        throw e;
      },
    );
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  return wrapped as unknown as F;
}

/**
 * Put the recorder in front of the isolate's `fetch`, once. A `fetch` that already carries the
 * mark — installed by this request's entry, a previous one, or another copy of this module — is
 * left as it is, so evaluating the entry again never wraps twice. Something that replaced
 * `globalThis.fetch` since (a test's mock) is wrapped in turn. Never throws.
 */
export function installOutboundRecorder(current: CurrentRecording): void {
  try {
    const g = globalThis as unknown as { fetch?: unknown };
    const existing = g.fetch as (FetchFn & { [WRAPPED]?: true }) | undefined;
    if (typeof existing !== 'function' || existing[WRAPPED]) return;
    g.fetch = recordingFetch(existing, current);
  } catch {
    // A runtime whose `fetch` cannot be replaced simply has no outbound calls on the line.
  }
}
