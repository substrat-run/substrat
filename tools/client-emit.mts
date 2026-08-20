#!/usr/bin/env tsx
/**
 * The browser-client checkpoint — a vertical's typed fetch client, emitted from
 * its model instead of written beside it.
 *
 * ## What this replaces
 *
 * `demos/todo/app/src/api.ts` was 100 hand-written lines, and every fact in it
 * already existed in `spec/model.ts`: the `List`/`Item`/`Share` interfaces are
 * the entities' `fields`, the paths and methods are the `http` blocks, the
 * request bodies are the `input` schemas. It was a second description of a
 * declared thing, which is the defect this repo already refuses everywhere else
 * — the route table (`mountOperations`), the OpenAPI document (`lint:api`), the
 * permission surface (`lint:permissions`), the migrations.
 *
 * It drifted exactly the way a second description does. #811 declared
 * `todo/list-items` paged and #827 added two search reads; the client learned
 * about none of them, so the app silently rendered the first twenty items of a
 * list as though that were the whole list, and shipped no search at all. Nothing
 * was red. Nothing could be — there was no gate over a file a person maintained
 * by remembering to.
 *
 * ## Emitted, not derived at runtime
 *
 * `mountOperations` derives the SERVER's route table live, and argues in its own
 * header that a code generator would be the wrong shape there: the model is
 * TypeScript, the operations are a live object, so there is nothing to emit. The
 * client is the opposite case and for one reason — it runs in a browser, in a
 * separate Vite package that depends on neither `@substrat-run/contracts` nor
 * zod, and must keep depending on neither (`tools/declared-deps.mjs` walks
 * `demos/*` and would rightly refuse an undeclared import; a bundle that pulls
 * zod in to describe types it erases at build is worse again).
 *
 * So the output is standalone TypeScript with no imports at all. That is also
 * what makes the checked-in artifact reviewable: a reader diffs the actual
 * types, not a re-export whose meaning lives in another package.
 *
 * ## Opting in
 *
 * A vertical opts in from its `package.json`, naming the model and where the
 * client lands:
 *
 * ```json
 * "substrat": {
 *   "client": {
 *     "model": "spec/model.ts",
 *     "entities": "todoEntities",
 *     "operations": "todoOperations",
 *     "out": "app/src/api.generated.ts",
 *     "name": "Todo"
 *   }
 * }
 * ```
 *
 * Named rather than discovered by shape: two exports that both look like a bag
 * of entities is a coin flip, and a generator that guesses is a generator whose
 * output nobody trusts.
 *
 * ## What it refuses
 *
 * A schema it cannot print is exit 2 naming the operation and the field — never
 * `unknown`, never a skipped method. A generated client that quietly degrades to
 * `any` is more dangerous than the hand-written one it replaced, because the
 * green light is now mechanical.
 *
 *   pnpm lint:client            re-emit every opted-in client
 *   pnpm lint:client --check    CI: exit 1 if an emitted client has drifted
 *
 * Exit codes follow boundary-lint's: 0 = fine, 1 = drift, 2 = cannot run.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

/** Exit 2: the tool cannot do its job. Always names the remedy. */
function cannot(message: string): never {
  console.error(`client-emit: ${message}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Reading Zod structurally.
// ---------------------------------------------------------------------------

/**
 * Zod's internal definition, read WITHOUT `instanceof`.
 *
 * The same reason `vertical-host/src/operations-routes.ts` reads it this way:
 * `instanceof` fails across two copies of the library, and a workspace with a
 * hoisted zod plus a package-local one has two. A generator that silently
 * printed `unknown` for every schema from the wrong copy would be the worst
 * possible failure here.
 */
interface ZodDef {
  readonly type?: string;
  readonly shape?: Record<string, unknown>;
  readonly element?: unknown;
  readonly innerType?: unknown;
  readonly options?: unknown[];
  readonly values?: unknown[];
  readonly entries?: Record<string, unknown>;
  readonly keyType?: unknown;
  readonly valueType?: unknown;
  readonly in?: unknown;
}

function defOf(schema: unknown): ZodDef | undefined {
  return ((schema as { _zod?: { def?: unknown } })?._zod?.def ??
    (schema as { _def?: unknown })?._def) as ZodDef | undefined;
}

/** The wrappers that do not change a type, only its optionality or its parsing. */
const TRANSPARENT = new Set(['default', 'prefault', 'catch', 'readonly', 'nonoptional', 'pipe']);

/** A field is optional when its own outermost wrapper says so — `a?: T`, not `a: T | undefined`. */
function isOptional(schema: unknown): boolean {
  const def = defOf(schema);
  if (def?.type === 'optional' || def?.type === 'nullish') return true;
  if (def && TRANSPARENT.has(def.type ?? '')) {
    // A defaulted field is optional TO THE CALLER — the server fills it in.
    return def.type === 'default' || def.type === 'prefault' || isOptional(def.innerType ?? def.in);
  }
  return false;
}

/**
 * The type a `?` property carries, with the optionality itself taken off.
 *
 * `limit?: number | undefined` says the same thing twice and reads as though the
 * two halves might differ. A `nullish` field keeps its `| null`, because that half
 * is a value the server can actually send.
 */
function unwrapOptional(schema: unknown): unknown {
  const def = defOf(schema);
  if (def?.type === 'optional') return unwrapOptional(def.innerType);
  if (def?.type === 'default' || def?.type === 'prefault') return unwrapOptional(def.innerType);
  return schema;
}

function literalOf(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return cannot(`a literal of type ${typeof value} has no TypeScript spelling here`);
}

// ---------------------------------------------------------------------------
// Printing a schema as TypeScript.
// ---------------------------------------------------------------------------

interface PrintContext {
  /** Entity `fields` schema → the interface name it was printed as. */
  readonly named: Map<unknown, string>;
  /** Where we are, for a diagnostic that names the actual defect. */
  readonly where: string;
  /**
   * Declared type overrides, keyed by the SAME path the refusal prints.
   *
   * The escape hatch, shaped like `boundary-lint-allow`: explicit, named, and in the
   * PR diff. It exists because a schema can be unprintable for a good reason —
   * `protocol/define-template`'s `content` is a `z.preprocess`, whose inferred input
   * type is `unknown` by construction, which is exactly why the engine hand-writes
   * `ProtocolTemplateContentInput` beside it. A generator cannot recover that, and
   * guessing would be worse than saying so.
   */
  readonly overrides: Map<string, string>;
  /** Which overrides were actually reached — an unused one is a stale hatch. */
  readonly used: Set<string>;
}

/**
 * A schema as a TypeScript type.
 *
 * An entity's `fields` object is matched by IDENTITY, not by shape: `spec/model.ts`
 * writes `output: todoEntities.item.fields`, so the very same object arrives here
 * and prints as `Item`. Two entities that happen to share a shape stay two names,
 * and an inline object that happens to match an entity stays inline — which is
 * what the model actually said in both cases.
 */
function tsType(schema: unknown, ctx: PrintContext): string {
  const override = ctx.overrides.get(ctx.where);
  if (override !== undefined) {
    ctx.used.add(ctx.where);
    return override;
  }

  const named = ctx.named.get(schema);
  if (named) return named;

  const def = defOf(schema);
  switch (def?.type) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'bigint':
      return 'bigint';
    case 'unknown':
    case 'any':
      return 'unknown';
    case 'null':
      return 'null';
    case 'literal': {
      const values = def.values ?? [];
      if (values.length === 0) return cannot(`${ctx.where}: a literal with no values`);
      return values.map(literalOf).join(' | ');
    }
    case 'enum': {
      const values = Object.values(def.entries ?? {});
      if (values.length === 0) return cannot(`${ctx.where}: an enum with no members`);
      return values.map(literalOf).join(' | ');
    }
    case 'array':
      return `${maybeParen(tsType(def.element, ctx), ctx)}[]`;
    case 'object':
      return tsObject(def.shape ?? {}, ctx);
    case 'record':
      return `Record<${tsType(def.keyType, ctx)}, ${tsType(def.valueType, ctx)}>`;
    case 'union': {
      const options = def.options ?? [];
      if (options.length === 0) return cannot(`${ctx.where}: a union with no options`);
      return [...new Set(options.map((o) => tsType(o, ctx)))].join(' | ');
    }
    case 'optional':
      // Reached only where optionality has no key to hang off — inside an array,
      // say. As a property it is spelled `a?: T` by `tsObject` instead.
      return `${tsType(def.innerType, ctx)} | undefined`;
    case 'nullable':
      return `${tsType(def.innerType, ctx)} | null`;
    case 'nullish':
      return `${tsType(def.innerType, ctx)} | null | undefined`;
    case 'default':
    case 'prefault':
    case 'catch':
    case 'readonly':
    case 'nonoptional':
      return tsType(def.innerType, ctx);
    case 'pipe':
      // `z.coerce.number()` is a pipe; the caller supplies its INPUT side.
      return tsType(def.in, ctx);
    default:
      return cannot(
        `${ctx.where}: no TypeScript spelling for a Zod '${def?.type ?? 'unrecognised'}' schema.\n` +
          `  A generator that answered 'unknown' here would hand the app a green light over a\n` +
          `  type it never checked.\n` +
          `  Remedy, in order of preference: teach tsType() this case; declare the field with a\n` +
          `  shape the client can carry; or, when the schema genuinely has no inferable input\n` +
          `  type (a preprocess does not), state the type yourself in package.json —\n` +
          `    "substrat": { "client": { "types": { ${JSON.stringify(ctx.where.split('.').slice(1).join('.'))}: "unknown" } } }`,
      );
  }
}

/** Parenthesise a union before `[]`, so `(A | B)[]` never prints as `A | B[]`. */
function maybeParen(printed: string, _ctx: PrintContext): string {
  return printed.includes('|') && !printed.startsWith('(') ? `(${printed})` : printed;
}

function tsObject(shape: Record<string, unknown>, ctx: PrintContext): string {
  const keys = Object.keys(shape);
  if (keys.length === 0) return 'Record<string, never>';
  const fields = keys.map((key) => {
    const optional = isOptional(shape[key]);
    const value = optional ? unwrapOptional(shape[key]) : shape[key];
    return `${key}${optional ? '?' : ''}: ${tsType(value, { ...ctx, where: `${ctx.where}.${key}` })}`;
  });
  return `{ ${fields.join('; ')} }`;
}

/** An entity's fields printed as a multi-line interface body. */
function interfaceBody(shape: Record<string, unknown>, ctx: PrintContext): string {
  return Object.keys(shape)
    .map((key) => {
      const optional = isOptional(shape[key]);
      const value = optional ? unwrapOptional(shape[key]) : shape[key];
      return `  ${key}${optional ? '?' : ''}: ${tsType(value, { ...ctx, where: `${ctx.where}.${key}` })};`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Names.
// ---------------------------------------------------------------------------

const pascal = (s: string) => s.replace(/(^|[-_/])(\w)/g, (_, __, c: string) => c.toUpperCase());
const camel = (s: string) => {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

/**
 * `todo/create-list` → `createList`; `protocol/get` → `protocolGet`.
 *
 * The vertical's OWN prefix is dropped — it is the client's identity and repeating it
 * on every method says nothing (`api.callout.calloutCreateOrder()`). A composed
 * engine's prefix stays, and has to: callout binds `workorder/get`, `protocol/get` and
 * `invoicing/get` at three URLs, and a client with one `get()` would reach whichever
 * bag was read last. Renaming an engine's operation to suit a vertical's client is not
 * a thing a vertical may do, so the disambiguation belongs here.
 */
const methodName = (operation: string, ownPrefix: string) => {
  const [prefix, ...rest] = operation.split('/');
  const tail = rest.join('/');
  return prefix === ownPrefix ? camel(tail) : camel(`${prefix}/${tail}`);
};

// ---------------------------------------------------------------------------
// The emitted file.
// ---------------------------------------------------------------------------

interface HttpOp {
  readonly summary?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly http?: { readonly method: string; readonly path: string };
  readonly paged?: { readonly sortKey?: string; readonly total?: boolean };
}

const pathParams = (path: string) => [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);

/**
 * The fixed runtime, which is a template rather than a derivation — but it is
 * emitted rather than shipped as a package for the same reason the types are:
 * the app depends on nothing, and one file is one thing to review.
 */
function preamble(name: string, source: string, anyPaged: boolean, stated: string[]): string {
  return `// GENERATED by tools/client-emit.mts from ${source} — do not edit by hand.${
    stated.length
      ? `
//
// HAND-STATED TYPES (substrat.client.types). These schemas have no inferable input
// type — a \`z.preprocess\` infers \`unknown\` by construction — so the type below was
// decided by a person, not derived, and is not checked against the schema:
${stated.map((line) => `//   ${line}`).join('\n')}`
      : ''
  }
//
// Re-emit with \`pnpm lint:client\`; CI runs \`pnpm lint:client --check\` and fails on
// drift, so the client cannot fall behind the model the way a hand-written one did.
//
// Standalone on purpose: no imports, so the browser bundle carries no schema library
// and \`tools/declared-deps.mjs\` has nothing to object to.

/** A failed request. \`status\` is the interesting field — 403 is the permission model answering. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
${
  anyPaged
    ? `
/**
 * One page of a paged read, reassembled from the response.
 *
 * The BODY is the entries and always was; the walk rides in headers (#829), which is
 * what let paging be adopted without renaming a live endpoint's response. This puts
 * the two back together so a caller sees a page rather than a header protocol.
 *
 * \`next\` is an absolute URL to FOLLOW (RFC 8288), not a cursor to reassemble — this
 * request's filters and page size travel with it. Its absence is how the walk ends.
 */
export interface Paged<T> {
  entries: T[];
  /** Hand back to \`follow()\`. \`null\` when there is no next page. */
  next: string | null;
  /** From \`X-Total-Count\`, and only for a read that declares \`total\`. */
  total: number | null;
}
`
    : ''
}
export interface ClientOptions {
  /** Prefixed to every declared path. Matches \`mountOperations\`' own default. */
  baseUrl?: string;
  /** Per-request headers — an auth token, or this demo's \`x-principal\` persona seam. */
  headers?: () => Record<string, string>;
  /** Injectable so the client works under a test harness, not only in a browser. */
  fetch?: typeof globalThis.fetch;
  /**
   * Pull a message out of an error body.
   *
   * The one thing here the model does NOT declare: a vertical picks its error
   * envelope in its own \`app.onError\`, so this is a best effort over the shapes in
   * use — \`{ error }\`, and problem+json's \`detail\`/\`title\` — and an app that
   * answers something else says so here rather than being guessed at.
   */
  errorMessage?: (body: unknown, response: Response) => string | undefined;
}

function defaultErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  for (const key of ['error', 'detail', 'title', 'message']) {
    if (typeof b[key] === 'string') return b[key] as string;
  }
  return undefined;
}
`;
}

function emit(
  vertical: string,
  config: ClientConfig,
  source: string,
  entities: Record<string, unknown>,
  operations: Record<string, unknown>,
  extras: Record<string, unknown>,
): string {
  const named = new Map<unknown, string>();
  const claimedBy = new Map<string, string>();
  const claim = (schema: unknown, name: string, origin: string) => {
    const already = claimedBy.get(name);
    if (already !== undefined && named.get(schema) !== name) {
      cannot(
        `${vertical}: two different schemas both want the interface name \`${name}\` ` +
          `(${already}, ${origin}).\n` +
          `  Remedy: rename one in substrat.client.schemas.`,
      );
    }
    claimedBy.set(name, origin);
    named.set(schema, name);
  };
  for (const [key, def] of Object.entries(entities)) {
    const fields = (def as { fields?: unknown })?.fields;
    if (!fields) cannot(`${vertical}: entity '${key}' has no \`fields\` schema`);
    claim(fields, pascal(key), `entity ${key}`);
  }
  for (const [name, exportName] of Object.entries(config.schemas ?? {})) {
    const schema = extras[exportName];
    if (schema === undefined) cannot(`${vertical}: substrat.client.schemas names \`${exportName}\`, which nothing exports`);
    claim(schema, name, `schema ${exportName}`);
  }

  // Keys are declared relative to the operation, so the vertical's own name is not
  // repeated in every entry; `where` carries the prefix, so add it here.
  const overrides = new Map(Object.entries(config.types ?? {}).map(([k, v]) => [`${vertical}.${k}`, v]));
  const used = new Set<string>();
  const ctx: PrintContext = { named, where: vertical, overrides, used };

  // Every named type gets a block: an entity's `fields`, and each extra schema. A name
  // in the identity map with no interface behind it is a file that references a type it
  // never declares — which typechecks nowhere and would only be found by building.
  const blocks: { name: string; note: string; schema: unknown; where: string }[] = [
    ...Object.entries(entities).map(([key, def]) => ({
      name: pascal(key),
      note: `\`${(def as { table?: string }).table ?? key}\` — declared in ${source}`,
      schema: (def as { fields: unknown }).fields,
      where: `${vertical}.${key}`,
    })),
    ...Object.entries(config.schemas ?? {}).map(([name, exportName]) => ({
      name,
      note: `\`${exportName}\` — a published schema, not a stored row`,
      schema: extras[exportName],
      where: `${vertical}.${exportName}`,
    })),
  ];

  const entityBlocks = blocks.map(({ name, note, schema, where }) => {
    const def = defOf(schema);
    if (def?.type !== 'object') {
      cannot(
        `${vertical}: \`${name}\` is not an object schema, so it cannot be an interface.\n` +
          `  Remedy: drop it from substrat.client.schemas — a union or an array is spelled\n` +
          `  inline where it is used.`,
      );
    }
    // Printed with this schema temporarily UNNAMED, or the body would be `Foo` referring
    // to itself. Every other reference to it still resolves to the name.
    const named2 = new Map(ctx.named);
    named2.delete(schema);
    return `/** ${note}. */\nexport interface ${name} {\n${interfaceBody(def.shape ?? {}, { ...ctx, named: named2, where })}\n}`;
  });

  // Then one method per operation that declares an HTTP binding. An operation
  // without one is not part of this app's surface — a composed engine's, say.
  const declared = Object.entries(operations)
    .map(([operation, op]) => [operation, op as HttpOp] as const)
    .filter((entry): entry is readonly [string, HttpOp & { http: NonNullable<HttpOp['http']> }] =>
      Boolean(entry[1]?.http),
    )
    .sort(([a], [b]) => a.localeCompare(b));

  if (declared.length === 0) cannot(`${vertical}: no operation declares an \`http\` binding — a client over nothing`);

  // The first named bag is the vertical's own `defineOperations`; the rest are engine
  // route bindings. Taken from INSERTION order (the bags are merged in the order
  // package.json names them), never from `declared`, which is sorted for a stable
  // artifact — reading it there would make the answer depend on the alphabet, and it
  // happens to be right for callout, which is the worst way for it to be wrong.
  const ownPrefix = Object.keys(operations)[0]?.split('/')[0] ?? '';

  const seen = new Map<string, string>();
  const methods: string[] = [];
  const impls: string[] = [];
  let anyPaged = false;

  for (const [operation, op] of declared) {
    const method = methodName(operation, ownPrefix);
    const clash = seen.get(method);
    if (clash) {
      cannot(
        `${vertical}: '${clash}' and '${operation}' both name the client method \`${method}\`.\n` +
          `  Two methods with one name is a call site that silently reaches the wrong\n` +
          `  endpoint. A composed engine's prefix is kept precisely to avoid this, so a\n` +
          `  collision here means two operations of the SAME module share a name.\n` +
          `  Remedy: rename one of them.`,
      );
    }
    seen.set(method, operation);

    const where = `${vertical}.${operation}`;
    const params = pathParams(op.http.path);
    const inputShape = (defOf(op.input)?.shape ?? {}) as Record<string, unknown>;
    const hasInput = op.input !== undefined || params.length > 0;

    // The parameter type is the input schema WHOLE — path parameters included.
    // `mountOperations` reads them off the URL, but they are declared input fields
    // and the compile-checked `{var}` join says so, so the caller passes one object.
    const inputType = op.input ? tsObject(inputShape, { ...ctx, where: `${where}.input` }) : '{}';

    const entryType = tsType(op.output, { ...ctx, where: `${where}.output` });
    const returnType = op.paged ? `Paged<${maybeParen(entryType, ctx)}>` : entryType;
    if (op.paged) anyPaged = true;

    const signature = hasInput ? `input: ${inputType}` : '';
    const doc = [
      '  /**',
      `   * ${op.summary ?? operation}`,
      '   *',
      `   * \`${op.http.method} ${op.http.path}\` — \`${operation}\``,
      ...(op.paged ? ['   *', '   * Paged: walk it with `follow(page.next)` until `next` is `null`.'] : []),
      '   */',
    ].join('\n');

    methods.push(`${doc}\n  ${method}(${signature}): Promise<${returnType}>;`);

    // Path parameters are spliced out of the payload; what is left is a body for a
    // writing method and a query string for a read — exactly what mountOperations
    // expects on the other side, which is the only reason this can be derived.
    const takesBody = ['POST', 'PUT', 'PATCH'].includes(op.http.method);
    const pathExpr = params.length
      ? '`' + op.http.path.replace(/\{(\w+)\}/g, (_, p: string) => `\${encodeURIComponent(String(input.${p}))}`) + '`'
      : JSON.stringify(op.http.path);
    const rest = params.length ? `omit(input, ${JSON.stringify(params)})` : hasInput ? 'input' : 'undefined';
    const call = op.paged ? 'page' : 'send';
    impls.push(
      `    ${method}: (${hasInput ? 'input: Args' : ''}) =>\n` +
        `      ${call}(${pathExpr}, ${JSON.stringify(op.http.method)}, ${takesBody ? `${rest}, undefined` : `undefined, ${rest}`}),`,
    );
  }

  const runtime = `
/**
 * The plumbing below is deliberately untyped against the interface above, and cast
 * once at the end.
 *
 * \`send\` cannot know an operation's return type — it has a \`Response\`, not a schema
 * — so every method would otherwise need its own \`as\` and the file would carry
 * fourteen casts instead of one. The interface is what a caller sees, and it IS
 * derived from the model; this is the seam where a runtime that speaks \`unknown\`
 * meets it.
 */
type Args = Record<string, unknown>;

const omit = (input: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input ?? {})) if (!keys.includes(k)) out[k] = v;
  return out;
};

/** Declared fields become a query string; \`undefined\` is absent rather than the string "undefined". */
const query = (values: Record<string, unknown> | undefined): string => {
  if (!values) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? \`?\${s}\` : '';
};
${
  anyPaged
    ? `
/**
 * The \`rel="next"\` URL out of an RFC 8288 \`Link\` header, or null.
 *
 * Only \`next\` is looked for because only \`next\` is sent: keyset paging walks one
 * way and does not know its own offset, so there is no \`prev\`, \`first\` or \`last\`
 * to honour. A header naming some other relation is not this walk's.
 */
const nextFrom = (header: string | null): string | null => {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /^\\s*<([^>]+)>\\s*;\\s*(.+)$/.exec(part);
    if (match && /rel\\s*=\\s*"?next"?/.test(match[2] as string)) return match[1] as string;
  }
  return null;
};
`
    : ''
}
export function createClient(options: ClientOptions = {}): ${config.name}Client {
  const baseUrl = options.baseUrl ?? '/api';
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const readMessage = options.errorMessage ?? defaultErrorMessage;

  /** One request, against a path that is ALREADY prefixed and query-stringed. */
  const raw = async (fullPath: string, method: string, body: unknown): Promise<Response> => {
    const hasBody = body !== undefined && method !== 'GET' && method !== 'DELETE';
    return await doFetch(fullPath, {
      method,
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...(options.headers?.() ?? {}),
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
  };

  const parse = async (res: Response): Promise<unknown> => {
    const text = await res.text();
    const body: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, readMessage(body, res) ?? res.statusText, body);
    return body;
  };

  const send = async (path: string, method: string, body: unknown, params: unknown): Promise<unknown> =>
    await parse(await raw(\`\${baseUrl}\${path}\${query(params as Record<string, unknown>)}\`, method, body));
${
  anyPaged
    ? `
  /**
   * A paged read: the entries come from the body, the walk from the headers.
   *
   * A cross-origin caller reads neither header without \`Access-Control-Expose-Headers\`,
   * and the symptom is not an error — it is a list that looks like it has one page. Under
   * a same-origin dev proxy (this demo) or a same-origin deployment, both are readable.
   */
  const readPage = async (res: Response): Promise<Paged<unknown>> => {
    const entries = (await parse(res)) as unknown[];
    const total = res.headers.get('X-Total-Count');
    return { entries, next: nextFrom(res.headers.get('Link')), total: total === null ? null : Number(total) };
  };

  const page = async (path: string, method: string, body: unknown, params: unknown): Promise<Paged<unknown>> =>
    await readPage(await raw(\`\${baseUrl}\${path}\${query(params as Record<string, unknown>)}\`, method, body));
`
    : ''
}
  return {
${impls.join('\n')}${
    anyPaged
      ? `
    follow: async (next: string) => {
      // The link names the API's OWN origin, which under a dev proxy is not the origin
      // this page was served from. So the path is kept and the origin is taken from
      // whatever this client was configured to talk to: relative for a browser, which
      // keeps the request same-origin, absolute for a harness that has no page.
      const link = new URL(next, 'http://substrat.invalid');
      const target = /^https?:\\/\\//.test(baseUrl)
        ? new URL(link.pathname + link.search, baseUrl).href
        : link.pathname + link.search;
      return await readPage(await raw(target, 'GET', undefined));
    },`
      : ''
  }
  } as unknown as ${config.name}Client;
}
`;

  const followSignature = anyPaged
    ? `
  /**
   * Fetch the next page of any paged read, given a previous page's \`next\`.
   *
   * One method for every paged read rather than one per read: \`next\` is a URL that
   * already carries the filters, so there is nothing left for a caller to restate.
   */
  follow<T>(next: string): Promise<Paged<T>>;
`
    : '';

  const unused = [...overrides.keys()].filter((k) => !used.has(k));
  if (unused.length) {
    cannot(
      `${vertical}: substrat.client.types names ${unused.map((k) => k.slice(vertical.length + 1)).join(', ')}, ` +
        `which the printer never reached.\n` +
        `  A stale escape hatch reads as a live decision. Remedy: remove the entry.`,
    );
  }

  return [
    preamble(
      config.name,
      source,
      anyPaged,
      [...used].sort().map((k) => `${k.slice(vertical.length + 1)} → ${overrides.get(k)}`),
    ),
    entityBlocks.join('\n\n'),
    `/** Every operation this vertical binds to HTTP, one method each. */\nexport interface ${config.name}Client {\n${methods.join('\n\n')}\n${followSignature}}`,
    runtime.trimStart(),
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------

interface ClientConfig {
  /**
   * The module(s) the model is declared in.
   *
   * A list because a vertical is free to split it: todo keeps entities and operations
   * in one `spec/model.ts`, callout has `src/entities.ts` and `src/operations.ts`. The
   * exports are merged into one namespace, and a name exported by two of them is
   * refused rather than resolved — which of two files won is not a thing a generated
   * artifact should depend on.
   */
  readonly model: string | readonly string[];
  /**
   * The export(s) holding entity declarations — `{ name: { fields, table } }`.
   *
   * A list because a vertical that composes engines wants the ENGINE's entities named
   * too: without them `protocolGet`'s return type inlines four hundred characters of
   * protocol row on one line, which is a diff nobody reads.
   */
  readonly entities: string | readonly string[];
  /**
   * Extra schemas to name, as `InterfaceName` → export name.
   *
   * An engine publishes types that are NOT its stored rows — `workOrder` is the
   * engine's published shape, with the two `facility_*` columns folded into one
   * `EntityRef`, and no entity's `fields` is that object. Those have nowhere else to
   * be declared, so they are named here.
   */
  readonly schemas?: Readonly<Record<string, string>>;
  /**
   * The export(s) holding this vertical's operations.
   *
   * An array because a vertical that COMPOSES engines has more than one: callout
   * declares its own six and then binds three engines' operations to its own URLs
   * with `defineEngineRoutes`, which returns the same operation objects with `http`
   * attached. Those are as much part of the app's surface as the vertical's own —
   * the SPA calls `/workorders/{id}/complete` without caring whose operation it is —
   * so a generator that read only the first bag would emit a third of the client and
   * look complete doing it.
   */
  readonly operations: string | readonly string[];
  readonly out: string;
  readonly name: string;
  /**
   * Hand-stated types for schemas the printer cannot spell, keyed by the path the
   * refusal prints (`<operation>.input.<field>`). Every entry must be reached — a
   * stale escape hatch is worse than none, so an unused one is exit 2.
   */
  readonly types?: Readonly<Record<string, string>>;
}

const opted: { rel: string; dir: string; config: ClientConfig }[] = [];
for (const group of ['demos', 'apps']) {
  const groupDir = join(ROOT, group);
  let names: string[];
  try {
    names = readdirSync(groupDir);
  } catch {
    continue;
  }
  for (const n of names.sort()) {
    const dir = join(groupDir, n);
    if (!statSync(dir).isDirectory()) continue;
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      substrat?: { client?: Partial<ClientConfig> };
    };
    const client = pkg.substrat?.client;
    if (!client) continue;
    for (const field of ['model', 'entities', 'operations', 'out', 'name'] as const) {
      if (!client[field]) cannot(`${group}/${n}: substrat.client is missing \`${field}\``);
    }
    if (Array.isArray(client.operations) && client.operations.length === 0) {
      cannot(`${group}/${n}: substrat.client.operations is an empty list`);
    }
    opted.push({ rel: `${group}/${n}`, dir, config: client as ClientConfig });
  }
}

if (opted.length === 0) {
  cannot(
    `no vertical declares \`substrat.client\` in its package.json.\n` +
      `  demos/todo is expected to — a checkpoint that checks nothing must never print a green light.`,
  );
}

const drifted: string[] = [];
for (const { rel, dir, config } of opted) {
  const models = typeof config.model === 'string' ? [config.model] : config.model;
  /** Each model module, kept SEPARATE — see `resolve` below for why. */
  const loadedModules: { label: string; exports: Record<string, unknown> }[] = [];
  for (const relPath of models) {
    // A relative path is a file in this vertical; anything else is a package specifier,
    // which is how an engine's published schemas are reached. An engine declares its own
    // types and a vertical restating them is the defect this tool exists to remove, so
    // importing them is the only honest option.
    const isPath = relPath.startsWith('.') || relPath.startsWith('/') || /\.[mc]?tsx?$/.test(relPath);
    let loaded: Record<string, unknown>;
    if (isPath) {
      const modelPath = join(dir, relPath);
      if (!existsSync(modelPath)) {
        cannot(`${rel}: substrat.client.model names ${relPath}, which does not exist`);
      }
      loaded = (await import(pathToFileURL(modelPath).href)) as Record<string, unknown>;
    } else {
      try {
        // Resolved from the VERTICAL's directory, not this tool's. pnpm's symlinked
        // layout means a package is reachable only from something that declared it,
        // which is the property that makes an undeclared import fail here rather than
        // resolve off a hoisted copy at the root.
        const require = createRequire(join(dir, 'package.json'));
        loaded = (await import(pathToFileURL(require.resolve(relPath)).href)) as Record<string, unknown>;
      } catch (err) {
        cannot(
          `${rel}: substrat.client.model names the package '${relPath}', which would not import.\n` +
            `  ${(err as Error).message}\n` +
            `  Remedy: declare it as a dependency, or build it first.`,
        );
      }
    }
    loadedModules.push({ label: relPath, exports: loaded });
  }
  const modelLabel = models.join(' + ');

  /**
   * One configured export, found across the model modules.
   *
   * Deliberately NOT a merged namespace. Five modules share plenty of incidental
   * names — callout and engine-protocol both export an `instantiateProtocolInput`,
   * and they are genuinely different objects (callout pins `entityType` to the
   * literal `'workorder'`; the engine takes an `EntityRef`). A merge would have to
   * pick a winner for a name nobody asked about. So only the names the config
   * actually NAMES are resolved, and only those are refused when ambiguous — which
   * is where an ambiguity would really change the output.
   */
  const resolve = (name: string): unknown => {
    const hits = loadedModules.filter((m) => name in m.exports);
    if (hits.length === 0) return undefined;
    const first = hits[0]!;
    const conflicting = hits.slice(1).filter((m) => m.exports[name] !== first.exports[name]);
    if (conflicting.length) {
      cannot(
        `${rel}: '${name}' is exported by ${[first, ...conflicting].map((m) => m.label).join(' and ')}, ` +
          `with different values.\n` +
          `  Remedy: import it from one place, or rename one — a generated client must not\n` +
          `  depend on which module was read last.`,
      );
    }
    return first.exports[name];
  };
  const mod = new Proxy({} as Record<string, unknown>, { get: (_t, k: string) => resolve(k) });
  const entityBags = typeof config.entities === 'string' ? [config.entities] : config.entities;
  const entities: Record<string, unknown> = {};
  for (const bagName of entityBags) {
    const bag = mod[bagName] as Record<string, unknown> | undefined;
    if (!bag || typeof bag !== 'object') cannot(`${rel}: ${modelLabel} exports no \`${bagName}\``);
    for (const [name, def] of Object.entries(bag)) {
      if (entities[name] !== undefined && entities[name] !== def) {
        cannot(
          `${rel}: entity '${name}' is declared by two bags in substrat.client.entities.\n` +
            `  Remedy: name it once — an interface generated from whichever was read last is\n` +
            `  not a type anyone can rely on.`,
        );
      }
      entities[name] = def;
    }
  }

  // One bag or several, merged in declaration order. A name claimed twice is refused
  // rather than resolved: two bags disagreeing about one operation is a fact about the
  // model, and picking a winner here would hide it.
  const bags = typeof config.operations === 'string' ? [config.operations] : config.operations;
  const operations: Record<string, unknown> = {};
  const from = new Map<string, string>();
  for (const bagName of bags) {
    const bag = mod[bagName] as Record<string, unknown> | undefined;
    if (!bag || typeof bag !== 'object') cannot(`${rel}: ${modelLabel} exports no \`${bagName}\``);
    for (const [operation, op] of Object.entries(bag)) {
      const claimed = from.get(operation);
      if (claimed) {
        cannot(
          `${rel}: '${operation}' appears in both \`${claimed}\` and \`${bagName}\`.\n` +
            `  Remedy: bind it in one of them — two bindings for one operation is a route\n` +
            `  table that depends on which bag was read last.`,
        );
      }
      from.set(operation, bagName);
      operations[operation] = op;
    }
  }

  const content = emit(rel, config, modelLabel, entities, operations, mod);
  const artifact = join(dir, config.out);

  if (!check) {
    writeFileSync(artifact, content);
    const count = Object.values(operations).filter((op) => (op as HttpOp)?.http).length;
    console.log(`client-emit: wrote ${rel}/${config.out} (${count} operations)`);
    continue;
  }
  if (!existsSync(artifact)) {
    cannot(
      `${rel}/${config.out} does not exist.\n` +
        `  A missing artifact is a broken setup, not drift.\n` +
        `  Remedy: run \`pnpm lint:client\` and commit the result.`,
    );
  }
  if (readFileSync(artifact, 'utf8') !== content) drifted.push(rel);
}

if (check) {
  if (drifted.length) {
    console.error(
      `client-emit: client drift in ${drifted.join(', ')}.\n` +
        `  The model no longer matches the checked-in client — this is the exact drift that\n` +
        `  left demos/todo's app unable to page or search after #811 and #827.\n` +
        `  Run \`pnpm lint:client\` and commit the diff.`,
    );
    process.exit(1);
  }
  console.log(`client-emit: ${opted.length} client(s) clean`);
}
