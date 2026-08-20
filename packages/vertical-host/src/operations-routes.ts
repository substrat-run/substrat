/**
 * The route table, derived from the declared operations.
 *
 * A vertical's `http` declarations already say method, path and which input
 * fields the path carries — checked at compile time (`{var}` must name an input
 * field). Writing the Hono routes again by hand is a second description of the
 * same fact, and the two drift the moment an operation is renamed.
 *
 * This is a runtime derivation rather than a code generator on purpose: the
 * model is TypeScript, so `operations` is a live object. There is nothing to
 * emit, nothing to regenerate, and nothing to keep disposable.
 *
 * **Scope.** It mounts the operations THIS module declares. A composed engine's
 * operations carry no `http` — the engine is entity-agnostic and does not own a
 * URL shape, so the vertical decides theirs and mounts them itself.
 *
 * Three things a hand-written table did for free, and this derivation therefore
 * has to do deliberately: a query string carries no types (§ `queryCoercers`),
 * registration ORDER decides which of two overlapping paths wins
 * (§ `comparePaths`), and a THROW has to become a status (§ `mountOperations`).
 * All three were found by the same production vertical with 195 declared routes:
 * 29 of its 81 reads carried a `limit` the model declares as a number (#785),
 * and every failure — a permission denial foremost — came back as a bare 500
 * with no seam to correct it (#791).
 */
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  isPage,
  nextPageLink,
  PAGE_LINK_HEADER,
  PAGE_TOTAL_HEADER,
} from '@substrat-run/contracts';
import type { ScopeStub } from '@substrat-run/kernel';
import { classifyError } from './errors.js';

export type ResolveStub = (c: Context) => Promise<ScopeStub>;

/**
 * The `http` fragment this derivation needs, read structurally.
 *
 * Not accepted as a parameter type: every property is optional, and
 * TypeScript's weak-type rule then rejects an operation sharing NONE of them —
 * which `callout/whoami` (narrows, no input, no http) genuinely does. Same
 * reason `permissionsUsedBy` takes `Record<string, object>`.
 */
interface HttpDecl {
  readonly http?: { readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; readonly path: string };
  readonly input?: { readonly shape?: Record<string, unknown> };
  /** Declared by a paged read (#811). Its presence is what turns on the projection below. */
  readonly paged?: { readonly sortKey?: string; readonly total?: boolean };
}

/** Zod's internal definition, across the layouts this reads structurally. */
interface ZodDef {
  readonly type?: string;
  readonly values?: unknown[];
  readonly value?: unknown;
  readonly innerType?: unknown;
  readonly in?: unknown;
}

/**
 * Read a schema's definition without `instanceof`, which fails across duplicate
 * copies of the library — the same reason the rest of this file reads Zod
 * structurally.
 */
function defOf(schema: unknown): ZodDef | undefined {
  return ((schema as { _zod?: { def?: unknown } })?._zod?.def ??
    (schema as { _def?: unknown })?._def) as ZodDef | undefined;
}

/**
 * Input fields the model pins to a single value — supplied by the route rather
 * than by the caller.
 *
 * The case that motivated it: `callout/instantiate-protocol` declares
 * `entityType: z.literal('workorder')`, and its hand-written route supplied that
 * string as a literal alongside the path parameter. That looked like a shape the
 * declaration could not express — but the declaration already said it. Reading
 * it here removes a whole category of "route that cannot be derived" without
 * adding any vocabulary, which is the better kind of fix: the model was not
 * missing information, the emitter was not listening.
 */
function pinnedFields(input: HttpDecl['input']): Record<string, unknown> {
  const shape = input?.shape;
  if (!shape) return {};
  const out: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(shape)) {
    const def = defOf(schema);
    if (def?.type !== 'literal') continue;
    // Zod 4 carries `values` (a literal may name several); older layouts carry
    // `value`. Only a SINGLE permitted value is a constant — a choice is not.
    const values = def.values ?? (def.value === undefined ? undefined : [def.value]);
    if (Array.isArray(values) && values.length === 1) out[field] = values[0];
  }
  return out;
}

/**
 * A URL carries no types: `?limit=100` arrives as the string `'100'`, and an
 * operation declaring `limit: z.number().int().optional()` rejects it with
 * "expected number, received string". Every read with a non-string field is
 * affected — in a production vertical that was most paged reads, plus every
 * year/month filter (#785).
 *
 * The fix reads the declared shape and coerces only the fields whose declared
 * type cannot be a string: number, boolean, bigint. That is deliberately
 * narrower than coercing by JSON grammar, which would have to guess — `?q=123`
 * is a number to the grammar and a search term to the caller — and narrower
 * than telling verticals to declare `z.coerce.number()`, which pushes an HTTP
 * transport detail into a model that has to stay transport-agnostic (the same
 * schema the handler parses).
 *
 * A value the declared type cannot accept is passed through UNCHANGED, so the
 * error the caller reads still names what they actually sent.
 *
 * Unions are skipped: `z.union([z.number(), z.string()])` has no single answer,
 * and guessing is what this function exists to avoid.
 */
function queryCoercers(input: HttpDecl['input']): Record<string, (raw: string) => unknown> {
  const shape = input?.shape;
  if (!shape) return {};
  const out: Record<string, (raw: string) => unknown> = {};
  for (const [field, schema] of Object.entries(shape)) {
    const coerce = coercerFor(schema);
    if (coerce) out[field] = coerce;
  }
  return out;
}

/**
 * The coercion a declared field wants, looking through the wrappers that do not
 * change its type — `optional`, `nullable`, `default`, `catch`, `readonly`, and
 * a pipe's input side (`z.coerce.number()` is one, and coercing ahead of it is
 * idempotent rather than wrong).
 */
function coercerFor(schema: unknown, depth = 0): ((raw: string) => unknown) | undefined {
  if (depth > 8) return undefined; // a cycle cannot happen in a Zod schema, but a bound is cheap
  const def = defOf(schema);
  switch (def?.type) {
    case 'number':
      return (raw) => {
        if (raw.trim() === '') return raw;
        const n = Number(raw);
        return Number.isFinite(n) ? n : raw;
      };
    case 'bigint':
      return (raw) => (/^[+-]?\d+$/.test(raw.trim()) ? BigInt(raw.trim()) : raw);
    case 'boolean':
      // Only the two spellings a URL can mean unambiguously. `?flag` with no
      // value arrives as '' and stays '' — "present" is not "true" here.
      return (raw) => (raw === 'true' ? true : raw === 'false' ? false : raw);
    case 'optional':
    case 'nullable':
    case 'nullish':
    case 'default':
    case 'prefault':
    case 'catch':
    case 'readonly':
    case 'nonoptional':
      return coercerFor(def.innerType, depth + 1);
    case 'pipe':
      return coercerFor(def.in, depth + 1);
    default:
      return undefined;
  }
}

export interface MountOperationsOptions {
  /** Prefix for every derived path. `/api` matches the fleet's convention. */
  readonly basePath?: string;
  /**
   * Every operation name the host actually registers, if the caller can supply
   * it — the vertical's own plus each composed engine's.
   *
   * Bindings for a composed engine name their operation as a STRING, because
   * `ModuleRegistration` erases its operation keys before a vertical can see
   * them. Given this set, a typo fails at mount with a message naming it; given
   * nothing, it fails as a 404 the first time somebody calls that endpoint.
   */
  readonly knownOperations?: Iterable<string>;
  /**
   * Turn an operation's result into the response. Omit ⇒ `c.json(result)`, the
   * raw result, which is what every route did before this option existed.
   *
   * It exists because the mount had already decided the SUCCESS shape while
   * leaving the failure shape to the vertical, so an adopting vertical's
   * envelope ended up defined in two places in two vocabularies (#791). A
   * vertical that answers `{ ok: true, result }` says so here, once.
   *
   * It is also the honest home for per-request work that belongs BETWEEN the
   * invoke and the response — stripping a field the operation returns but the
   * caller may not see, relaying a credential, sending mail. The alternative
   * verticals were reaching for is a `resolveStub` whose `invoke` returns an
   * envelope instead of the operation's result, which makes `ScopeStub` a lie.
   *
   * **It also owns a paged read's wire shape.** The default path projects a
   * `Page<T>` into an entries body plus `Link`/`X-Total-Count` (#829); a vertical
   * that supplies `respond` receives the `Page` whole and answers however its own
   * envelope requires. Two mounts cannot both decide the body, and the vertical's
   * own statement is the one that should win.
   */
  readonly respond?: (c: Context, result: unknown, operation: string) => Response | Promise<Response>;
  /**
   * Turn a thrown error into the response. Return `undefined` to fall through
   * to the default (§ `mountOperations`), so a vertical maps only what it
   * actually knows about.
   *
   * Give it the same envelope as `respond` — a client that reads `ok` off every
   * reply is the reason both options are here.
   */
  readonly onError?: (
    c: Context,
    error: unknown,
    operation: string,
  ) => Response | Promise<Response> | undefined | Promise<undefined>;
}

/** A request body, or the 400 it deserves. */
function parseBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new HTTPException(400, { message: 'request body is not valid JSON' });
  }
}

/** `{listId}` in the model is `:listId` to Hono. */
function toHonoPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1');
}

/** The `{var}` names a path carries, in declaration order. */
function pathParams(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
}

/**
 * Order two declared paths so the more specific one is registered first.
 *
 * Hono dispatches in REGISTRATION order, so `/users/{id}` registered before
 * `/users/invites` answers `/users/invites` with `id: 'invites'` and the static
 * route is unreachable — no error, no warning, just an endpoint that silently
 * belongs to its neighbour. Registering in alphabetical OPERATION order (what
 * this did until #785) decides that by a name that has nothing to do with
 * routing: `support/get` sorts before `support/list-mine`, and a live
 * `GET /support/issues/mine` disappeared behind `GET /support/issues/{id}`.
 *
 * So compare the paths instead, segment by segment, static before parameter —
 * a lexicographic order over the key `[isParam, text]` per segment, which makes
 * it a real total order (transitive, and the same table every time) rather than
 * a pile of pairwise special cases. Paths that cannot overlap are unaffected;
 * paths that can, resolve the way a reader of the URLs expects.
 *
 * **Why order rather than refuse.** #785 argued for detecting the collision and
 * refusing to mount, on the grounds that the silence is the real defect and the
 * vertical should decide. The silence is the defect — but a reserved word in an
 * id slot has one correct reading, not an ambiguous one, and it is the reading
 * every path-template spec already writes down: OpenAPI resolves a concrete
 * path ahead of a templated one for exactly this case. Refusing would make a
 * soluble collision a boot failure and force live URLs to be renamed to satisfy
 * a router that had the whole table in front of it. What ordering CANNOT
 * resolve still throws (`assertNoUnreachable`), so nothing stays silent.
 */
function comparePaths(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const x = as[i] as string;
    const y = bs[i] as string;
    if (x === y) continue;
    const xParam = x.startsWith('{');
    const yParam = y.startsWith('{');
    if (xParam !== yParam) return xParam ? 1 : -1;
    return x < y ? -1 : 1;
  }
  return as.length - bs.length;
}

/**
 * The shape a path DISPATCHES as: parameter names are internal to the handler,
 * so `/users/{id}` and `/users/{slug}` are one route to any router.
 */
function dispatchShape(path: string): string {
  return path.replace(/\{\w+\}/g, '{}');
}

/**
 * Refuse a table where one operation can never be reached.
 *
 * Ordering resolves a static path against its parameter sibling (§
 * `comparePaths`). What it cannot resolve is two declarations that dispatch
 * IDENTICALLY — same method, same shape, different parameter names — because
 * there is no reading under which both are live. That is the case #785 is
 * really about: an endpoint that quietly stops existing. Here it fails at
 * mount, naming both operations, rather than at the first request nobody makes.
 */
function assertNoUnreachable(declared: readonly (readonly [string, { http: { method: string; path: string } }])[]): void {
  const claimed = new Map<string, string>();
  for (const [name, op] of declared) {
    const key = `${op.http.method} ${dispatchShape(op.http.path)}`;
    const first = claimed.get(key);
    if (first !== undefined) {
      throw new Error(
        `mountOperations: '${first}' and '${name}' both declare ${key} — they dispatch ` +
          'identically, so one of them can never be reached; give one a distinct path',
      );
    }
    claimed.set(key, name);
  }
}

/**
 * Mount one route per declared operation. Returns what it mounted — a caller
 * can assert on it, and a test that expects N routes fails loudly at zero
 * rather than passing over an empty table.
 *
 * The returned table is in registration order, which is the order that decides
 * dispatch: read it to see which of two overlapping paths wins.
 *
 * **What a failure answers.** A permission denial is the most common non-success
 * outcome in a permissioned system and the kernel raises it as a typed error, so
 * a route answering it with the same 500 as a crash is wrong in the way that
 * matters most — a client cannot tell "you may not" from "we broke" (#791).
 * The kernel's own vocabulary is therefore mapped here, and nothing else is:
 *
 * | thrown | status |
 * |---|---|
 * | `PermissionDenied` (or a message saying so) | 403 |
 * | a `ZodError` — the input failed to parse | 400 |
 * | a body that is not JSON | 400 |
 * | an `HTTPException` — e.g. `resolveStub` refusing an anonymous call | its own |
 * | a Durable Object / runtime fault (#559) | 502 |
 * | anything else | re-thrown UNCHANGED |
 *
 * The last row is the point: a vertical's domain errors are not this mount's to
 * guess at, so they reach `app.onError` exactly as they did before. And what IS
 * mapped is re-thrown as an `HTTPException`, so an app that owns an error
 * envelope still writes the body — this decides the status, not the shape.
 * A vertical that wants the shape too passes `respond` and `onError`.
 */
export function mountOperations(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  operations: Readonly<Record<string, object>>,
  resolveStub: ResolveStub,
  options: MountOperationsOptions = {},
): { operation: string; method: string; path: string }[] {
  const base = options.basePath ?? '/api';
  const known = options.knownOperations ? new Set(options.knownOperations) : undefined;
  const mounted: { operation: string; method: string; path: string }[] = [];

  const declared = Object.keys(operations)
    .map((name) => [name, operations[name] as HttpDecl | undefined] as const)
    .filter((entry): entry is readonly [string, HttpDecl & { http: NonNullable<HttpDecl['http']> }] =>
      Boolean(entry[1]?.http),
    )
    // Path specificity decides dispatch; method and name only keep the table
    // deterministic for two operations that share a path (`GET`/`POST /lists`).
    .sort(
      ([aName, a], [bName, b]) =>
        comparePaths(a.http.path, b.http.path) ||
        (a.http.method < b.http.method ? -1 : a.http.method > b.http.method ? 1 : 0) ||
        (aName < bName ? -1 : aName > bName ? 1 : 0),
    );

  assertNoUnreachable(declared);

  for (const [name, op] of declared) {
    if (known && !known.has(name)) {
      throw new Error(
        `mountOperations: '${name}' is bound to ${op.http.method} ${op.http.path} but no ` +
          'registered module provides it — check the name against the engine that owns it',
      );
    }
    const { method, path } = op.http;
    const params = pathParams(path);
    const full = `${base}${toHonoPath(path)}`;
    const takesBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
    const pinned = pinnedFields(op.input);
    const coercers = queryCoercers(op.input);

    /** Types the values a URL hands over as strings, per the declared shape. */
    const typed = (values: Record<string, string | undefined>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [field, raw] of Object.entries(values)) {
        const coerce = coercers[field];
        out[field] = coerce && raw !== undefined ? coerce(raw) : raw;
      }
      return out;
    };

    const invoke = async (c: Context) => {
      const stub = await resolveStub(c);
      const fromPath: Record<string, string | undefined> = {};
      for (const p of params) fromPath[p] = c.req.param(p);

      // A body is merged when the method carries one; query params fill the
      // rest for reads. Absent both, an operation with no declared input is
      // invoked with no argument at all — `z.object({})` cannot say "no body",
      // so a handler typed for `undefined` would reject `{}`.
      let payload: Record<string, unknown> | undefined;
      // Pinned fields go in FIRST so a caller cannot talk the route out of them:
      // a literal in the model is the model's statement, not a default.
      if (takesBody) {
        const raw = await c.req.text();
        // A body that is not JSON is the caller's 400, not a crash: `JSON.parse`
        // throws a bare SyntaxError that no error vocabulary can recognise.
        const body = raw ? (parseBody(raw) as Record<string, unknown>) : {};
        // A body is JSON and already typed; only the URL's own values need it.
        payload = { ...body, ...pinned, ...typed(fromPath) };
      } else {
        payload = { ...typed(c.req.query()), ...pinned, ...typed(fromPath) };
      }
      if (!op.input && params.length === 0) payload = undefined;

      const result = await stub.invoke(name, payload);
      if (options.respond) return await options.respond(c, result, name);
      // A paged read's BODY is the entries; the walk rides in headers (#829).
      //
      // The kernel-side shape stays `Page<T>` — an operation is transport-agnostic, and
      // an in-process caller (a test, a seed, another operation) must be able to walk a
      // list with no HTTP response to read headers off. So this is a PROJECTION at the
      // wire, not a change to what an operation returns.
      //
      // Why it is worth a projection at all: wrapping the body renames a live endpoint's
      // response — `[…]` or `{ customers: […] }` becomes `{ entries: […] }` — so adopting
      // paging broke every consumer a vertical could not see, and the rational move was
      // to leave an unbounded list unbounded. It also could not be done AT ALL for a list
      // whose published shape was a bare array: a body cannot be an array and an object
      // at once. In headers, the body is what it always was.
      //
      // `isPage` is checked rather than assumed: a declaration whose handler has not
      // adopted `pageOf` yet must reach the client unchanged, not be emptied into a body
      // of `undefined`.
      if (op.paged && isPage(result)) {
        const link = nextPageLink(c.req.url, result.nextCursor);
        if (link) c.header(PAGE_LINK_HEADER, link);
        const total = (result as { total?: unknown }).total;
        if (typeof total === 'number') c.header(PAGE_TOTAL_HEADER, String(total));
        return c.json(result.entries);
      }
      return c.json(result);
    };

    const handler = async (c: Context) => {
      try {
        return await invoke(c);
      } catch (err) {
        const mapped = await options.onError?.(c, err, name);
        if (mapped) return mapped;
        const seen = classifyError(err);
        // No opinion means exactly that: re-throw UNTOUCHED so the vertical's own
        // `app.onError` still gets the error it has always got, and can still map
        // its own domain vocabulary. Only what the kernel itself names — a refused
        // permission, an input that failed to parse, a runtime fault — is decided
        // here, because those are not a vertical's to guess at (#791).
        if (!seen) throw err;
        // One that already IS an HTTPException travels on as itself — re-wrapping
        // would drop a custom `res` a route deliberately attached to it.
        if (err instanceof HTTPException) throw err;
        // Re-thrown as an HTTPException rather than answered directly, so an app
        // that owns an error envelope keeps owning it — `mountPlatformSurface`'s
        // handler reads the status and wraps the message. An app with no handler
        // gets Hono's own response at the right status instead of a bare 500.
        throw new HTTPException(seen.status, { message: seen.message, cause: err });
      }
    };

    if (method === 'GET') app.get(full, handler);
    else if (method === 'POST') app.post(full, handler);
    else if (method === 'PUT') app.put(full, handler);
    else if (method === 'PATCH') app.patch(full, handler);
    else app.delete(full, handler);

    mounted.push({ operation: name, method, path: full });
  }

  return mounted;
}
