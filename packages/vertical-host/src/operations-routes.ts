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
 */
import type { Context, Hono } from 'hono';
import type { ScopeStub } from '@substrat-run/kernel';

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
 *
 * Read structurally across Zod's internal layouts rather than with `instanceof`,
 * which fails across duplicate copies of the library.
 */
function pinnedFields(input: HttpDecl['input']): Record<string, unknown> {
  const shape = input?.shape;
  if (!shape) return {};
  const out: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(shape)) {
    const def = ((schema as { _zod?: { def?: unknown } })._zod?.def ??
      (schema as { _def?: unknown })._def) as
      | { type?: string; values?: unknown[]; value?: unknown }
      | undefined;
    if (def?.type !== 'literal') continue;
    // Zod 4 carries `values` (a literal may name several); older layouts carry
    // `value`. Only a SINGLE permitted value is a constant — a choice is not.
    const values = def.values ?? (def.value === undefined ? undefined : [def.value]);
    if (Array.isArray(values) && values.length === 1) out[field] = values[0];
  }
  return out;
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
 * Mount one route per declared operation. Returns what it mounted — a caller
 * can assert on it, and a test that expects N routes fails loudly at zero
 * rather than passing over an empty table.
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

  for (const name of Object.keys(operations).sort()) {
    const op = operations[name] as HttpDecl | undefined;
    if (!op?.http) continue;
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

    const handler = async (c: Context) => {
      const stub = await resolveStub(c);
      const fromPath: Record<string, unknown> = {};
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
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        payload = { ...body, ...pinned, ...fromPath };
      } else {
        const query = c.req.query();
        payload = { ...query, ...pinned, ...fromPath };
      }
      if (!op.input && params.length === 0) payload = undefined;

      return c.json(await stub.invoke(name, payload));
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
