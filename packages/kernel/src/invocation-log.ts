/**
 * One structured log line per invocation, carrying the two dimensions Cloudflare
 * structurally cannot record: which TENANT and which SCOPE a request belonged to
 * (`docs/architecture/observability.md` §4.2/§4.3).
 *
 * ## Why this exists at all
 *
 * Observability is keyed on the deployed unit — a worker script — and one vertical's
 * script serves every tenant that installed it. That makes script-grain data safe for
 * staff and for the vertical's builder, and unsafe for an installer: their own numbers
 * are inseparable from everyone else's (§3). The router already stamps `tenantId` on the
 * datapoints and log lines IT emits, which is why tenant-keyed *metrics* need no code in
 * this package. Logs are the other half, and the router cannot supply it: a trace does
 * not cross the dispatch hop. Verified against production — a router line's `traceId`
 * reaches `substrat-control-plane` (a service binding) but never the dispatched vertical,
 * and every vertical event is a trace of exactly one event. There is nothing to join on,
 * so the line has to be emitted on this side.
 *
 * ## What it makes possible that nothing else does
 *
 * A vertical's successful request emits NO log event whatsoever — the host logs only on a
 * platform fault, and the scope host logs nothing at all. So before this middleware, a
 * vertical's entire log presence was its crashes. The stamped line is therefore not only
 * the correlation key; it is the thing that makes a tenant-facing log view have any rows.
 *
 * ## The correlation contract
 *
 * Every log line emitted during one invocation shares `$metadata.requestId`, so a reader
 * resolves a tenant's lines in two phases: filter on `tenantId` to find the invocations,
 * then fetch every line sharing their request ids. That is what attributes a vertical's
 * OWN `console.log` output — which carries no tenant of its own — to the tenant whose
 * request produced it.
 *
 * The inverse of that contract is a rule, not an optimisation: a line with no `tenantId`
 * is never shown to a tenant (§4.3). An un-routed local invocation has no asserted
 * headers and therefore emits no line — there is no tenant it could be attributed to, and
 * inventing one is the only way this could ever leak.
 */
import type { HeaderReader } from './routed-node.js';

/**
 * The middleware's context, taken STRUCTURALLY — kernel depends on no web framework,
 * not even for a type. The shape below is the subset of a Hono context this reads, so
 * `app.use('*', invocationLog())` type-checks inside a vertical without this package
 * knowing which framework that vertical chose. Same posture as `vertical-host` taking
 * its scope host as `VerticalScopeHost` rather than importing a concrete adapter: the
 * seam is the shape, not the vendor.
 *
 * It is also what puts this code in kernel rather than in `vertical-host`. Kernel owns
 * the router-assertion family (`readRoutedNode`, `assertPlatformCall`) — the code that
 * reads what the router asserted about a request — and this line is the same family
 * seen from the other end: it writes that assertion down so a reader can find it again.
 * Living here means a lean vertical picks it up without also taking on an AI SDK.
 */
export interface InvocationLogContext {
  req: { method: string; raw: { url: string; headers: HeaderReader } };
  res?: { status: number };
}

// Runtime globals, declared rather than imported: this package compiles against
// `lib: ["ES2023"]` with no DOM and no workers types, deliberately, so that nothing here
// assumes a browser. Both are web-standard and present in Node, Workers and browsers
// alike — the same posture `secret-box.ts` takes for `crypto` and `TextEncoder`.
declare const console: { log(message: string): void };
declare const URL: new (input: string) => { pathname: string };

/**
 * The shape of the emitted line. Deliberately a published contract rather than an
 * incidental object: the read proxy filters on these key names, and Workers Logs indexes
 * a `JSON.stringify`ed `console.log` as queryable TOP-LEVEL fields (`tenantId`, not
 * `$metadata.tenantId` nor `source.tenantId` — verified against the live telemetry API).
 * Renaming a key here silently empties a view, because a filter on a key that does not
 * exist returns `success: true` with zero events. Add fields; never rename one.
 */
export interface InvocationLogLine {
  /** Discriminator — what lets a reader tell this line from a vertical's own output. */
  substrat: 'invocation';
  tenantId: string;
  scopeId: string | null;
  vertical: string | null;
  surface: string | null;
  method: string;
  /** Path ONLY — see `pathOf`. */
  path: string;
  /**
   * The response status as the caller received it — including the status `onError`
   * mapped a thrown error to.
   *
   * Hono composes `onError` INSIDE the handler chain, not around it, so a handler that
   * throws does not reject this middleware's `await next()`: the envelope has already
   * turned it into a response by the time control comes back, and `c.res` holds the
   * mapped status. That is worth stating because the opposite is the natural guess, and
   * guessing it would have put `null` on every error line — the exact rows a tenant
   * opens this view to find.
   *
   * `null` therefore survives only for a genuine escape: an error that got past the
   * envelope itself, which `threw` marks.
   */
  status: number | null;
  /** The error escaped even `onError` — rare, and the most interesting line on the page. */
  threw: boolean;
  durationMs: number;
}

/**
 * The path, with the query string DISCARDED.
 *
 * Not a tidiness choice. A vertical that speaks OIDC carries `code`, `state` and
 * `id_token_hint` in its query strings, an invite or magic-link flow carries a
 * single-use token, and the platform's own internal calls carry `tenantId`/`scopeId`.
 * An access log that swallowed those would put live credentials into a store that is
 * read by a wider audience than the request ever had, and keep them there for the
 * backend's whole retention window. Logging the path alone loses nothing a reader
 * needs: which route ran is the question, and the identifiers are already dimensions.
 */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    // A URL the runtime accepted but `URL` will not parse is not worth failing over.
    return '/';
  }
}

/**
 * Mount as the FIRST middleware on a vertical's app:
 *
 * ```ts
 * const app = new Hono<{ Bindings: Env }>();
 * app.use('*', invocationLog());
 * ```
 *
 * First, because Hono composes handlers in registration order and stops at the one that
 * returns a response — middleware registered after a route does not wrap that route. A
 * vertical that mounts this below its own routes gets a log for some of its surface and
 * silence for the rest, which is worse than none, because the silence reads as no
 * traffic. `pnpm lint:invocation-log` refuses that arrangement rather than trusting
 * anyone to remember it.
 *
 * Nothing here can fail a request: the line is written in a `finally`, and a throw from
 * the handler is re-thrown untouched for `onError` to map as it always did.
 */
export function invocationLog(): (
  c: InvocationLogContext,
  next: () => Promise<void>,
) => Promise<void> {
  return async (c, next) => {
    // Host code, so a real clock is correct here — `ctx.now()` is the module-code rule,
    // and this middleware runs outside any operation's transaction.
    const started = Date.now();
    let threw = false;
    try {
      await next();
    } catch (e) {
      threw = true;
      // Always re-thrown: the envelope `mountPlatformSurface` installs is what answers
      // the caller, and swallowing here would turn a fault into a silent 200.
      throw e;
    } finally {
      const headers = c.req.raw.headers;
      const tenantId = headers.get('x-substrat-tenant');
      // No asserted tenant ⇒ no line. The router strips every client-supplied
      // `x-substrat-*` before setting its own, so this header is the platform's
      // assertion and not a caller's claim.
      if (tenantId) {
        const line: InvocationLogLine = {
          substrat: 'invocation',
          tenantId,
          scopeId: headers.get('x-substrat-scope'),
          vertical: headers.get('x-substrat-vertical'),
          surface: headers.get('x-substrat-surface'),
          method: c.req.method,
          path: pathOf(c.req.raw.url),
          status: threw ? null : (c.res?.status ?? null),
          threw,
          durationMs: Date.now() - started,
        };
        console.log(JSON.stringify(line));
      }
    }
  };
}
