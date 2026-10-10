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
 *
 * ## The tenant is a VERIFIED assertion, never a header
 *
 * Which is why the line is written from `readRoutedNode`'s answer and not from
 * `headers.get('x-substrat-tenant')`. The two look interchangeable — behind the router
 * they are — and they are not, for exactly the reason #966 made `readRoutedNode` itself
 * fail closed: K-26's boundary is that a vertical's script has no public route, and that
 * is a DEPLOYMENT fact, with `workers.dev` on by default. Reading the header directly
 * meant anyone who could reach the script could name any tenant they liked and have the
 * line filed under it — a request the vertical then refuses with a 400, since `nodeFor`
 * does verify, while this middleware's `finally` had already written the forged line.
 *
 * That is not a cosmetic wrong row. The read path uses the stamped line as PROOF that an
 * invocation was a given tenant's, and admits that invocation's other log lines — which
 * carry no tenant of their own — into that tenant's view on the strength of it. A forged
 * stamp is therefore a way to put chosen text on somebody else's dashboard. So the same
 * verification the vertical does for its own routing happens here, with the same secret
 * and the same dev opt-out, and a failed one writes nothing at all.
 */
// The subpath, not the root: this module is bundled into every vertical's upload (the
// platform entry, #1893), and the root carries every schema in the vocabulary.
// The same holds for the kernel, whose two zero-import subpaths this reaches it through.
import {
  encodeInvocationRecord,
  FIELD_COVERAGE_HEADER,
  INVOCATION_RECORD_HEADER,
  invocationLevelOf,
} from '@substrat-run/contracts/invocation-record';
import type { EmittedReport } from '@substrat-run/kernel';
import { invocationLine, type OutputFieldsReport } from '@substrat-run/kernel/invocation-line';
import { ulid } from '@substrat-run/kernel/ulid';
import { readRoutedNode, ROUTED_ID, RouterAssertionError } from './routed-node.js';
import type { HeaderReader } from './routed-node.js';

// The line's grammar stays in the kernel, whose scope host writes the async lines with it
// (#1901); exported here too, beside the middleware that writes the request line.
export type { InvocationLogLine, OutputFieldsReport } from '@substrat-run/kernel/invocation-line';

/**
 * The per-request store key the middleware parks its {@link InvocationRecord} under (#1746).
 * A published name, like `substratInvocationId`: `mountOperations` reads it in another
 * package, and a vertical's own routes may fill it in too.
 */
export const INVOCATION_RECORD_KEY = 'substratInvocationRecord';

/**
 * What the handler chain learns about a request that the middleware cannot see from
 * outside it (#1746): which operation ran, who it ran as, how it failed, and what it
 * touched. The middleware creates one per request, hands it down through the context, and
 * writes whatever was filled in when the request ends.
 *
 * Mutable on purpose. The alternative was reading several context keys back in the
 * `finally`, which would add a `get` to the structural context below and make every field
 * a string-keyed lookup; one object handed down and written back is the smaller seam.
 *
 * Every field is optional, and an unfilled one is written as `null`: a custom route that
 * never reaches an operation is still logged, it just has nothing to say about these.
 */
export interface InvocationRecord {
  /** The operation name `mountOperations` dispatched to. */
  operation?: string;
  /** The `errorCode` a failed call was classified with, when the kernel's vocabulary names it. */
  problemCode?: string;
  /** The kind of subject the stub acted as — `ScopeStub.subjectKind`. */
  principalKind?: string;
  /** What the operation itself emitted — `InvokeOptions.onEmitted`. */
  emitted?: EmittedReport;
  /**
   * #1331: which of the operation's DECLARED output fields its response carried. Filled
   * only on a request the router armed the walk for ({@link fieldCoverageArmed}), and absent
   * otherwise — never an empty report, so "not walked" cannot read as "returned nothing".
   */
  outputFields?: OutputFieldsReport;
}

/**
 * The middleware's context, taken STRUCTURALLY — the line is not tied to a web framework,
 * not even for a type. The shape below is the subset of a Hono context this reads, so
 * `app.use('*', invocationLog())` type-checks inside a vertical without this module
 * knowing which framework that vertical chose. Same posture as `vertical-host` taking
 * its scope host as `VerticalScopeHost` rather than importing a concrete adapter: the
 * seam is the shape, not the vendor.
 *
 * This line belongs with the router-assertion family (`readRoutedNode`,
 * `assertPlatformCall`) — the code that reads what the router asserted about a request —
 * because it is the same family seen from the other end: it writes that assertion down so
 * a reader can find it again. The family moved here from the kernel (#1978); this package
 * keeps its AI SDK behind the `./model` subpath, so a vertical importing this from its root
 * bundles none of it.
 */
export interface InvocationLogContext<Env = unknown> {
  req: { method: string; raw: { url: string; headers: HeaderReader } };
  res?: { status: number };
  /**
   * The framework's per-request store (#1237). Hono's `Context` has one; the type is
   * structural and narrow on purpose, so it is declared optional — a caller that does
   * not provide it simply gets no invocation id on the scope's events, which reads as
   * unrecorded exactly like every other absent stamp.
   */
  set?: {
    (key: 'substratInvocationId', value: string): void;
    /** #1746: the record the handler chain fills in. See {@link InvocationRecord}. */
    (key: typeof INVOCATION_RECORD_KEY, value: InvocationRecord): void;
  };
  /** The worker's bindings — read ONLY through the options below, never otherwise. */
  env: Env;
}

/**
 * How this middleware verifies the router's assertion, in the vertical's own terms.
 *
 * Both are functions of the env rather than plain values because a Worker's bindings
 * arrive per-request, while `app.use(...)` runs once at module scope. They are the same
 * two knobs the vertical already passes to `readRoutedNode` in its `nodeFor`, and they
 * must be given the same answers: a log that trusts more than the router does is the
 * forged-tenant hole, and one that trusts less is silently empty.
 */
export interface InvocationLogOptions<Env = unknown> {
  /**
   * The router's shared secret as this worker holds it — `(env) => env.ROUTER_SECRET`.
   *
   * Omitting it is not a shortcut: with no secret to check against, an assertion can
   * only be accepted by `allowUnsigned`, so a bare `invocationLog()` in a deployed
   * vertical writes NOTHING. `pnpm lint:invocation-log` refuses that arrangement rather
   * than leaving a vertical to discover it from an empty log view.
   */
  routerSecret?: (env: Env) => string | undefined;
  /**
   * The vertical's own `ALLOW_DEV_NODE` — an un-routed local instance behind a dev
   * router that holds no secret either. Anywhere else this must stay false, or the
   * header is a claim again.
   */
  allowUnsigned?: (env: Env) => boolean;
}

/**
 * The platform's version binding, read straight off the env.
 *
 * The one exception to "bindings only through the options": `SUBSTRAT_VERSION_ID` is not
 * the vertical's binding to name, the platform attaches it to every pushed script, and a
 * vertical that had to pass it through would be one more line to forget with no way for
 * it to be wrong. Read defensively — the env is typed `unknown` here.
 */
function versionIdOf(env: unknown): string | null {
  const v = (env as { SUBSTRAT_VERSION_ID?: unknown } | null | undefined)?.SUBSTRAT_VERSION_ID;
  return typeof v === 'string' && v.length > 0 ? v : null;
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
 * #1893: one request's stamp — the id minted for it and the record the handler chain fills
 * in — shared by whichever layer started it.
 */
export interface InvocationStamp {
  invocationId: string;
  record: InvocationRecord;
  /**
   * #1923: the dispatch id the router armed this request's field walk with, when it did and
   * the request's router assertion verified. Decided once, when the stamp begins — see
   * {@link armedFieldCoverageId}. Written on the line beside the report, as its provenance.
   */
  fieldCoverageId?: string;
}

/**
 * The registry of stamps, keyed by the incoming `Request`, on `globalThis` under a GLOBAL
 * symbol. Global rather than module state, because two copies of this code meet in one
 * request: the platform's entry (`withInvocationLog`, prebuilt into the upload) and the
 * copy the vertical bundled (this package, or a kernel from before #1978) — different
 * module instances, one `Symbol.for`. Weak, so a
 * finished request's stamp goes with its `Request`.
 */
const STAMPS = Symbol.for('substrat.invocation-stamp');

function stamps(): WeakMap<object, InvocationStamp> {
  const g = globalThis as unknown as Record<symbol, WeakMap<object, InvocationStamp> | undefined>;
  return (g[STAMPS] ??= new WeakMap());
}

/**
 * The stamp a request already carries, if a layer outside this one started it (#1893).
 * `vertical-host` reads the record through this when the Hono context has none, which is
 * the case when the platform's entry stamped the request and the vertical mounts nothing.
 */
export function invocationStampOf(request: object): InvocationStamp | undefined {
  return stamps().get(request);
}

/**
 * #1923: whether the per-response field walk is armed for this request — the one question the
 * walk's two callers in `vertical-host` (the operation routes and the MCP door) ask.
 *
 * `false` for a request no stamp covers, and for a stamp begun by a layer that predates the
 * switch: every version skew between the platform's entry and a vertical's bundled copy
 * reads as off, never as on.
 */
export function fieldCoverageArmed(request: object): boolean {
  return typeof stamps().get(request)?.fieldCoverageId === 'string';
}

function beginStamp<Env>(request: { headers: HeaderReader }, env: Env, options: InvocationLogOptions<Env>): InvocationStamp {
  const stamp: InvocationStamp = { invocationId: ulid(), record: {} };
  const fieldCoverageId = armedFieldCoverageId(request.headers, env, options);
  if (fieldCoverageId) stamp.fieldCoverageId = fieldCoverageId;
  stamps().set(request, stamp);
  return stamp;
}

/**
 * #1923: the dispatch id the ROUTER armed the field walk with for this request, or `undefined`.
 *
 * The header alone is a claim. It is honoured only when its value is a ULID and the request's
 * router assertion verifies, with the same secret and the same dev opt-out as the tenant on
 * the line, because it is trusted for the same reason: the router strips every inbound
 * `x-substrat-*` header, and a caller that reaches the script some other way holds no secret.
 * An unrouted request, or one whose assertion fails, is never armed.
 *
 * The header is read first, so a request the router did not sample — almost all of them —
 * pays one header read and no verification.
 */
function armedFieldCoverageId<Env>(
  headers: HeaderReader,
  env: Env,
  options: InvocationLogOptions<Env>,
): string | undefined {
  let id: string | null;
  try {
    id = headers.get(FIELD_COVERAGE_HEADER);
  } catch {
    return undefined;
  }
  if (id === null || !ROUTED_ID.test(id)) return undefined;
  return routedNodeOrNull(headers, env, options) !== null ? id : undefined;
}

/** What a finished request looked like, for the line. */
interface Finished<Env> {
  request: { method: string; url: string; headers: HeaderReader };
  env: Env;
  status: number | null;
  threw: boolean;
  started: number;
}

/**
 * Write the line for a finished request — the one place it is written, whichever layer
 * started the stamp.
 *
 * No VERIFIED tenant ⇒ no line, and the three ways that happens are all silence here: no
 * assertion at all (an un-routed call), an assertion this worker cannot verify or that is
 * not the router's (`RouterAssertionError`), and — defensively — anything else the read
 * throws. Writing a line for any of them would be filing one caller's request under a
 * tenant of their choosing.
 */
function writeInvocationLine<Env>(stamp: InvocationStamp, done: Finished<Env>, options: InvocationLogOptions<Env>): void {
  // Called from a `finally`: a throw here would replace the vertical's answer, or its own
  // error, with a logging failure. The platform wraps every uploaded script in this (#1893),
  // so nothing in it may escape — a line that cannot be written is one missing line.
  try {
    writeLineOrThrow(stamp, done, options);
  } catch (e) {
    try {
      console.log(JSON.stringify({ substrat: 'invocation-log-fault', detail: String(e) }));
    } catch {
      /* the console itself is gone; there is nowhere left to say so */
    }
  }
}

function writeLineOrThrow<Env>(stamp: InvocationStamp, done: Finished<Env>, options: InvocationLogOptions<Env>): void {
  const node = routedNodeOrNull(done.request.headers, done.env, options);
  if (!node) return;
  const { record, invocationId } = stamp;
  const line = invocationLine({
    tenantId: node.tenantId,
    scopeId: node.scopeId,
    vertical: node.verticalSlug,
    surface: node.surface,
    method: done.request.method,
    path: pathOf(done.request.url),
    status: done.status,
    threw: done.threw,
    durationMs: Date.now() - done.started,
    invocationId,
    level: invocationLevelOf(done.status, done.threw, record.problemCode),
    operation: record.operation,
    problemCode: record.problemCode,
    principalKind: record.principalKind,
    ...(record.emitted ? { emitted: record.emitted } : {}),
    versionId: versionIdOf(done.env),
    ...(record.outputFields ? { outputFields: record.outputFields } : {}),
    ...(stamp.fieldCoverageId ? { fieldCoverageId: stamp.fieldCoverageId } : {}),
  });
  console.log(JSON.stringify(line));
}

/**
 * Mount as the FIRST middleware on a vertical's app, with the same two answers the
 * vertical gives `readRoutedNode` in its own `nodeFor`:
 *
 * ```ts
 * const app = new Hono<{ Bindings: Env }>();
 * app.use(
 *   '*',
 *   invocationLog<Env>({
 *     routerSecret: (env) => env.ROUTER_SECRET,
 *     allowUnsigned: (env) => env.ALLOW_DEV_NODE === 'true',
 *   }),
 * );
 * ```
 *
 * First, because Hono composes handlers in registration order and stops at the one that
 * returns a response — middleware registered after a route does not wrap that route.
 *
 * **Since #1893 the platform stamps every deployed request itself**, by wrapping the
 * uploaded entry with `withInvocationLog`. A vertical that still mounts this middleware
 * then finds the request already stamped and steps aside — it hands the platform's stamp
 * to the handler chain through the context, as it always did, and writes no second line.
 * Mounted where no platform entry runs (a dev server behind a dev router), it stamps as
 * before.
 *
 * Nothing here can fail a request: the line is written in a `finally`, and a throw from
 * the handler is re-thrown untouched for `onError` to map as it always did.
 */
export function invocationLog<Env = unknown>(
  options: InvocationLogOptions<Env> = {},
): (c: InvocationLogContext<Env>, next: () => Promise<void>) => Promise<void> {
  return async (c, next) => {
    // Stamped already by the platform's entry: pass the stamp down, write nothing.
    const existing = invocationStampOf(c.req.raw);
    if (existing) {
      c.set?.('substratInvocationId', existing.invocationId);
      c.set?.(INVOCATION_RECORD_KEY, existing.record);
      await next();
      return;
    }
    // Host code, so a real clock is correct here — `ctx.now()` is the module-code rule,
    // and this middleware runs outside any operation's transaction.
    const started = Date.now();
    // Minted per request, before anything can emit. A ULID so it sorts by time like
    // every other id on the spine.
    const stamp = beginStamp(c.req.raw, c.env, options);
    c.set?.('substratInvocationId', stamp.invocationId);
    c.set?.(INVOCATION_RECORD_KEY, stamp.record);
    let threw = false;
    try {
      await next();
    } catch (e) {
      threw = true;
      // Always re-thrown: the envelope `mountPlatformSurface` installs is what answers
      // the caller, and swallowing here would turn a fault into a silent 200.
      throw e;
    } finally {
      writeInvocationLine(
        stamp,
        { request: { method: c.req.method, url: c.req.raw.url, headers: c.req.raw.headers }, env: c.env, status: threw ? null : (c.res?.status ?? null), threw, started },
        options,
      );
    }
  };
}

/** The request a module worker's `fetch` receives, as far as the stamp reads it. */
export interface IncomingRequest {
  method: string;
  url: string;
  headers: HeaderReader;
}

/**
 * The module-worker shape `withInvocationLog` wraps: a default export with handlers. Typed
 * structurally, with no workers types, so a Hono app, a plain `{ fetch }` object and
 * anything else with the method all fit.
 */
export interface ModuleWorker<Env = unknown> {
  fetch?: (request: IncomingRequest, env: Env, ctx: unknown) => { status: number } | Promise<{ status: number }>;
  [handler: string]: unknown;
}

/** The handlers a module worker may export besides `fetch`, passed through untouched. */
const OTHER_HANDLERS = ['scheduled', 'queue', 'email', 'tail', 'trace', 'alarm', 'test'] as const;

/**
 * The platform's half of the stamp (#1893): wrap a module worker's `fetch` so every request
 * it serves is stamped, whatever framework the worker is written in and whether or not it
 * mounts the middleware.
 *
 * The control plane builds this into the entry it uploads in front of every vertical's
 * bundle (`platform-entry.generated.ts`), which is what makes the stamp the platform's
 * rather than a line each vertical has to remember. A request the vertical's own
 * middleware already stamped — possible only if something wrapped this one — is passed
 * straight through. The other handlers (`scheduled`, `queue`, …) are passed through
 * untouched, bound to the worker, since a stamp is about a routed request.
 *
 * Nothing here can fail a request: the line is written in a `finally`, and a throw is
 * re-thrown untouched.
 */
export function withInvocationLog<Env = unknown>(
  worker: ModuleWorker<Env>,
  options: InvocationLogOptions<Env> = {},
): ModuleWorker<Env> {
  // The platform wraps whatever a bundle's default export is (#1893): a class entrypoint or
  // no default at all has no `fetch` to stamp, and is handed back untouched.
  const inner = (worker as ModuleWorker<Env> | undefined)?.fetch;
  if (typeof inner !== 'function') return worker;
  const wrapped: ModuleWorker<Env> = {
    async fetch(request: IncomingRequest, env: Env, ctx: unknown): Promise<{ status: number }> {
      if (invocationStampOf(request)) return inner.call(worker, request, env, ctx);
      const started = Date.now();
      const stamp = beginStamp(request, env, options);
      let status: number | null = null;
      let threw = false;
      try {
        const response = await inner.call(worker, request, env, ctx);
        status = response.status;
        handRecordToRouter(response, stamp.record, request, env, options);
        return response;
      } catch (e) {
        threw = true;
        throw e;
      } finally {
        writeInvocationLine(stamp, { request, env, status, threw, started }, options);
      }
    },
  };
  for (const name of OTHER_HANDLERS) {
    const h = worker[name];
    if (typeof h === 'function') wrapped[name] = (h as (...a: unknown[]) => unknown).bind(worker);
  }
  return wrapped;
}

/**
 * #1904: hand the record back to the router on the response, which meters the request with
 * it and strips the header before the response leaves (`INVOCATION_RECORD_HEADER`).
 *
 * Only on a request the router vouched for: a direct caller gets no header, and the router
 * is the only reader. Never a throw — a response whose headers are immutable (one passed
 * straight through from a `fetch`) reached no operation and has nothing to hand back, and
 * metering must not fail a request either way.
 */
function handRecordToRouter<Env>(
  response: unknown,
  record: InvocationRecord,
  request: IncomingRequest,
  env: Env,
  options: InvocationLogOptions<Env>,
): void {
  try {
    const value = encodeInvocationRecord(record);
    if (value === null || !routedNodeOrNull(request.headers, env, options)) return;
    (response as { headers?: { set?: (name: string, value: string) => void } }).headers?.set?.(
      INVOCATION_RECORD_HEADER,
      value,
    );
  } catch {
    /* immutable headers: see above */
  }
}

/**
 * The verified node, or `null` — never a throw.
 *
 * `readRoutedNode` is deliberately loud: present-but-wrong headers are a
 * misconfiguration or an attack and a caller that routes on them must hear about it.
 * This caller does not route on them; it writes a log line in a `finally`, where a throw
 * would replace the vertical's real answer with a logging failure. So the loudness is
 * swallowed HERE and only here, and the request is unaffected either way.
 */
function routedNodeOrNull<Env>(headers: HeaderReader, env: Env, options: InvocationLogOptions<Env>) {
  try {
    return readRoutedNode(headers, {
      expectedSecret: options.routerSecret?.(env),
      allowUnsigned: options.allowUnsigned?.(env) ?? false,
    });
  } catch (e) {
    // `RouterAssertionError` is the expected shape — a bad, missing or unverifiable
    // secret, or a malformed id. Anything else would be a bug in the read, and a bug in
    // the LOGGER must not become a failed request either.
    if (!(e instanceof RouterAssertionError)) console.log(JSON.stringify({ substrat: 'invocation-log-fault', detail: String(e) }));
    return null;
  }
}
