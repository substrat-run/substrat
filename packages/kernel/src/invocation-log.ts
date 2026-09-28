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
import { ulid } from './ulid.js';
import { readRoutedNode, RouterAssertionError } from './routed-node.js';
import type { HeaderReader } from './routed-node.js';
import type { EmittedReport } from './scope-host.js';

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
}

/** The level a stamped line is filed under (#1746). See {@link invocationLevelOf}. */
export type InvocationLevel = 'error' | 'warn' | 'info';

/**
 * The level of an invocation, from how it ended.
 *
 * A stamped line is pure JSON, so the log platform sets no level on it (the reader's
 * comments in `cf-observability.ts` found this out the hard way). The level histogram
 * still needs one per request, so the line carries its own: a 5xx or an escaped throw is
 * an error, a 4xx is a warning (the request was refused, which the caller may need to
 * hear about, and nothing broke), a success carrying a problem code is a warning too, and
 * anything else is info.
 */
export function invocationLevelOf(
  status: number | null,
  threw: boolean,
  problemCode?: string | null,
): InvocationLevel {
  if (threw || status === null || status >= 500) return 'error';
  if (status >= 400) return 'warn';
  // A failure answered IN-BAND — an MCP tool error is a 200 carrying `isError` — is still
  // a refused call, and filing it as info would hide it from the one filter that looks.
  if (problemCode) return 'warn';
  return 'info';
}

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
  /**
   * The K-26 surface that answered. Taken from the verified node, so an assertion that
   * named none reads as `readRoutedNode`'s documented default (`app`) rather than as a
   * null only this writer would produce — one representation across the platform.
   */
  surface: string | null;
  method: string;
  /** Path ONLY — see `pathOf`. */
  path: string;
  /**
   * #1237: the id every event this invocation emitted is stamped with.
   *
   * The join nothing could make before. `$metadata.requestId` correlates the LINES of
   * one invocation, and it is stamped by the log platform at ingestion — no code here
   * can read it, and the spine could not have been given it. So the platform mints its
   * own, writes it here, and carries it to the scope on `InvokeOptions`.
   *
   * Which makes this line the other half of a trace: the events say what happened and
   * in what order, and this says how long the whole call took and how it ended.
   */
  invocationId: string;
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
  /*
   * #1746: the per-request record. Everything below is ADDITIVE to the line above and is
   * `null` (or empty) when nothing filled it in — a custom route, an older vertical-host,
   * an older scope host. A reader treats `null` as "not recorded", never as a value.
   */
  /** {@link invocationLevelOf}. Always present: it is derived from the two fields above. */
  level: InvocationLevel;
  /** The operation that ran. `null` for a route that is not a mounted operation. */
  operation: string | null;
  /** The kernel `errorCode` of a failed call, when it has one. */
  problemCode: string | null;
  /** Who the call ran as: `principal`, `connection`, `system`, `capability` or `vertical`. */
  principalKind: string | null;
  /**
   * How many events the operation itself emitted. `null` when not recorded, which is
   * different from `0`: a read emits nothing, and that is a fact about it.
   */
  eventCount: number | null;
  /** The distinct types among those events, in emission order (capped, see `entities`). */
  eventTypes: string[];
  /**
   * The distinct entities those events were about, as `<entityType>:<entityId>`. Taken from
   * at most `EMITTED_REPORT_CAP` events, so a bulk operation's line names the first few and
   * `eventCount` says how many there were.
   */
  entities: string[];
  /**
   * The registry id of the version that served the call — the platform's
   * `SUBSTRAT_VERSION_ID` binding, the same identity the spine stamps on events. `null`
   * locally and on a script pushed before the binding existed.
   */
  versionId: string | null;
}

/** Distinct values, first occurrence wins — the order a reader expects to see them in. */
function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
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
}

/**
 * The registry of stamps, keyed by the incoming `Request`, on `globalThis` under a GLOBAL
 * symbol. Global rather than module state, because two copies of this code meet in one
 * request: the platform's entry (`withInvocationLog`, prebuilt into the upload) and the
 * kernel the vertical bundled — different module instances, one `Symbol.for`. Weak, so a
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

function beginStamp(request: object): InvocationStamp {
  const stamp: InvocationStamp = { invocationId: ulid(), record: {} };
  stamps().set(request, stamp);
  return stamp;
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
  const node = routedNodeOrNull(done.request.headers, done.env, options);
  if (!node) return;
  const { record, invocationId } = stamp;
  const emitted = record.emitted;
  const line: InvocationLogLine = {
    substrat: 'invocation',
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
    operation: record.operation ?? null,
    problemCode: record.problemCode ?? null,
    principalKind: record.principalKind ?? null,
    eventCount: emitted ? emitted.total : null,
    eventTypes: emitted ? distinct(emitted.events.map((e) => e.type)) : [],
    entities: emitted ? distinct(emitted.events.map((e) => e.entity)) : [],
    versionId: versionIdOf(done.env),
  };
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
    const stamp = beginStamp(c.req.raw);
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
 * structurally — kernel compiles with no DOM and no workers types — so a Hono app, a plain
 * `{ fetch }` object and anything else with the method all fit.
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
      const stamp = beginStamp(request);
      let status: number | null = null;
      let threw = false;
      try {
        const response = await inner.call(worker, request, env, ctx);
        status = response.status;
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
