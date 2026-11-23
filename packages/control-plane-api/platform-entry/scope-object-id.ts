/**
 * The platform entry's answer to `/internal/scope-object-id` (#3316), for a vertical that cannot
 * give one itself.
 *
 * The cost rollup maps Cloudflare's billed Durable Object rows to a scope by the object id the
 * script holding the scope's data derives for it (`SCOPE.idFromName(scopeId)`), which nothing
 * outside that script can compute. vertical-host answers the route, but only a vertical built
 * against a release that has it: every deployment pushed before it, and every preview fork of
 * one, answers 404 or 501, so its objects stayed `unmapped` and the tenant that paid for them saw
 * none of it. The entry is uploaded in front of every vertical whatever its packages, so it can
 * answer for all of them.
 *
 * **The vertical's own answer wins.** The request goes to the vertical first, as it came; only
 * when that is not an object id (a refusal, a route it does not have, a catch-all page) does the
 * entry derive one, from the namespace the scope host is built on (`env.SCOPE` in the template and
 * every demo). A vertical that binds its scope store under another name keeps its own answer,
 * whatever that is: the entry never names an object from a namespace it was not told is the
 * scope's.
 *
 * The entry answers only a valid platform call, judged as the wire gate judges one, and only for
 * a ULID scope id. An id is all that crosses: deriving it wakes no object.
 *
 * Bundled into the entry by `tools/platform-entry-emit.mts`, so it imports nothing at run time but
 * contracts' zero-import `wire-auth` subpath.
 */
import { assertPlatformCall } from '@substrat-run/contracts/wire-auth';

/** The route the control plane's scope-object phase asks (`VerticalClient.scopeObjectId`). */
export const SCOPE_OBJECT_ID_PATH = '/internal/scope-object-id';

const OBJECT_ID = /^[0-9a-f]{64}$/;

/** The module worker's handlers besides `fetch`: vertical-host's `withInvocationLog` list. */
const OTHER_HANDLERS = ['scheduled', 'queue', 'email', 'tail', 'trace', 'alarm', 'test'] as const;

/** A module worker, structurally: the same shape the wire gate wraps. */
export interface EntryWorker<Env> {
  fetch?: (request: Request, env: Env, ctx: unknown) => unknown;
  [handler: string]: unknown;
}

export interface ScopeObjectIdOptions<Env> {
  /** The platform's legacy call credential as this deployment holds it. */
  readonly platformSecret: (env: Env) => string | undefined;
  /** The namespace the vertical's scope host derives its objects from, or undefined. */
  readonly namespace: (env: Env) => unknown;
  /** Whether a string is a scope id: the routed-node ULID check. */
  readonly isScopeId: (value: string) => boolean;
}

interface NamespaceLike {
  idFromName(name: string): { toString(): string };
}

const isNamespace = (value: unknown): value is NamespaceLike =>
  typeof value === 'object' && value !== null && typeof (value as { idFromName?: unknown }).idFromName === 'function';

/** Whether the vertical's answer is an object id: a 200 whose JSON names one. Never a throw. */
async function namesObject(answer: unknown): Promise<boolean> {
  if (!(answer instanceof Response) || answer.status !== 200) return false;
  try {
    const body = (await answer.clone().json()) as { objectId?: unknown } | null;
    return typeof body?.objectId === 'string' && OBJECT_ID.test(body.objectId);
  } catch {
    return false;
  }
}

/** The id the entry derives for `request`, or null when it may not or cannot. */
function derived<Env>(request: Request, env: Env, options: ScopeObjectIdOptions<Env>): string | null {
  try {
    assertPlatformCall(request.headers, { expectedSecret: options.platformSecret(env) });
  } catch {
    return null;
  }
  const scopeId = new URL(request.url).searchParams.get('scopeId');
  if (!scopeId || !options.isScopeId(scopeId)) return null;
  const ns = options.namespace(env);
  if (!isNamespace(ns)) return null;
  const id = ns.idFromName(scopeId).toString();
  return OBJECT_ID.test(id) ? id : null;
}

/**
 * Wrap a worker's `fetch` so `GET /internal/scope-object-id` names the scope's object even when the
 * vertical cannot. Every other request, and every other handler, is the worker's own. A worker with
 * no `fetch` comes back untouched, as the stamp and the gate do.
 */
export function withScopeObjectId<Env>(worker: EntryWorker<Env>, options: ScopeObjectIdOptions<Env>): EntryWorker<Env> {
  const inner = (worker as EntryWorker<Env> | undefined)?.fetch;
  if (typeof inner !== 'function') return worker;
  const wrapped: EntryWorker<Env> = {};
  // By name, through the prototype, as the stamp reads them: a class instance's handlers are not own properties.
  for (const name of OTHER_HANDLERS) {
    const h = worker[name];
    if (typeof h === 'function') wrapped[name] = (h as (...a: unknown[]) => unknown).bind(worker);
  }
  wrapped.fetch = async (request: Request, env: Env, ctx: unknown) => {
    const answer = await inner.call(worker, request, env, ctx);
    if (request.method !== 'GET' || new URL(request.url).pathname !== SCOPE_OBJECT_ID_PATH) return answer;
    if (await namesObject(answer)) return answer;
    const objectId = derived(request, env, options);
    return objectId === null ? answer : Response.json({ objectId });
  };
  return wrapped;
}
