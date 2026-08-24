/**
 * A vertical's browser client, rendered from its model.
 *
 * The pure half of `tools/client-emit.mts` — everything from "a Zod schema" to "a
 * string of TypeScript", with no filesystem and no `process.exit` in it. It lives here
 * rather than in the tool for one reason: a Zod→TypeScript printer is the kind of code
 * that is wrong in ways a drift check cannot see. `--check` re-emits and compares, so it
 * catches a client that fell behind its model; it cannot catch a client that has been
 * confidently mis-spelling `z.union([...])` inside an array since the day it was written.
 * That needs a test with the schema on one side and the expected string on the other,
 * and a test needs something importable.
 *
 * Its home is this package because that is already this package's job: build-time
 * tooling over a Substrat model. `emitTables` turns entities into DDL; this turns
 * entities and operations into a typed fetch client.
 *
 * ## What it emits
 *
 * Standalone TypeScript with no imports at all. A vertical's SPA is a separate Vite
 * package that depends on neither `@substrat-run/contracts` nor zod and must keep
 * depending on neither — and a checked-in artifact that re-exports its meaning from
 * another package is not reviewable in a diff.
 *
 * ## What it refuses
 *
 * A schema it cannot spell raises `ClientEmitError` naming the operation and the field.
 * Never `unknown`, never a skipped method: a generated client that quietly degrades to
 * `any` is more dangerous than the hand-written one it replaced, because the green light
 * is now mechanical.
 */

/** Raised for anything the caller must fix. The CLI turns it into exit 2 and a remedy. */
export class ClientEmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientEmitError';
  }
}

function fail(message: string): never {
  throw new ClientEmitError(message);
}

/**
 * How a vertical declares its client, from `package.json` under `substrat.client`.
 */
export interface ClientConfig {
  /**
   * The module(s) the model is declared in.
   *
   * A list because a vertical is free to split it: todo keeps entities and operations
   * in one `spec/model.ts`, callout has `src/entities.ts` and `src/operations.ts`, and
   * an entry that is not a path is a package specifier — which is how a composed
   * engine's published schemas are reached. Resolving the names across them is the
   * caller's job (`tools/client-emit.mts`); this module is handed the values.
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
  return fail(`a literal of type ${typeof value} has no TypeScript spelling here`);
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
      if (values.length === 0) return fail(`${ctx.where}: a literal with no values`);
      return values.map(literalOf).join(' | ');
    }
    case 'enum': {
      const values = Object.values(def.entries ?? {});
      if (values.length === 0) return fail(`${ctx.where}: an enum with no members`);
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
      if (options.length === 0) return fail(`${ctx.where}: a union with no options`);
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
      return fail(
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

/**
 * One schema as TypeScript, with no operation around it.
 *
 * The printer's entry point for a test. `named` is the identity map an entity's
 * `fields` would be in — pass one to check that a reference prints as its interface
 * name rather than as an inline shape.
 */
export function tsTypeOf(schema: unknown, named: Map<unknown, string> = new Map()): string {
  return tsType(schema, { named, where: 'schema', overrides: new Map(), used: new Set() });
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
export const methodName = (operation: string, ownPrefix: string) => {
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
  /** #129: this operation participates in optimistic concurrency. */
  readonly concurrency?: { readonly over: string; readonly idFrom: string };
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

export function renderClient(
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
      fail(
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
    if (!fields) fail(`${vertical}: entity '${key}' has no \`fields\` schema`);
    claim(fields, pascal(key), `entity ${key}`);
  }
  for (const [name, exportName] of Object.entries(config.schemas ?? {})) {
    const schema = extras[exportName];
    if (schema === undefined) fail(`${vertical}: substrat.client.schemas names \`${exportName}\`, which nothing exports`);
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
      fail(
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

  if (declared.length === 0) fail(`${vertical}: no operation declares an \`http\` binding — a client over nothing`);

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
  let anyGuarded = false;

  for (const [operation, op] of declared) {
    const method = methodName(operation, ownPrefix);
    const clash = seen.get(method);
    if (clash) {
      fail(
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
    if (op.concurrency) anyGuarded = true;

    const signature = hasInput ? `input: ${inputType}` : '';
    const doc = [
      '  /**',
      `   * ${op.summary ?? operation}`,
      '   *',
      `   * \`${op.http.method} ${op.http.path}\` — \`${operation}\``,
      ...(op.paged ? ['   *', '   * Paged: walk it with `follow(page.next)` until `next` is `null`.'] : []),
      ...(op.concurrency
        ? [
            '   *',
            `   * Concurrency-checked over \`${op.concurrency.over}\`. The tag this answers with is`,
            '   * remembered and sent as `If-Match` on the next write to the same entity, so a',
            '   * write that would overwrite someone else\'s change fails with 412 instead.',
          ]
        : []),
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
    const call = op.paged ? 'page' : op.concurrency ? 'guarded' : 'send';
    // A guarded call carries the entity it is about, so the runtime can key the tag
    // it caches. Read off the declaration rather than guessed from the path: the id
    // field and the path parameter are usually the same and are not required to be.
    const guardArgs = op.concurrency
      ? `${JSON.stringify(op.concurrency.over)}, input.${op.concurrency.idFrom}, `
      : '';
    impls.push(
      `    ${method}: (${hasInput ? 'input: Args' : ''}) =>\n` +
        `      ${call}(${guardArgs}${pathExpr}, ${JSON.stringify(op.http.method)}, ${takesBody ? `${rest}, undefined` : `undefined, ${rest}`}),`,
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
  const readMessage = options.errorMessage ?? defaultErrorMessage;${
    anyGuarded ? `
  /** #129: entity tags seen on this client, keyed \`entityType:id\`. */
  const versions = new Map<string, string>();` : ''
  }

  /** One request, against a path that is ALREADY prefixed and query-stringed. */
  const raw = async (fullPath: string, method: string, body: unknown${
    anyGuarded ? ', extra?: Record<string, string>' : ''
  }): Promise<Response> => {
    const hasBody = body !== undefined && method !== 'GET' && method !== 'DELETE';
    return await doFetch(fullPath, {
      method,
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...(options.headers?.() ?? {}),${anyGuarded ? `
        ...(extra ?? {}),` : ''}
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
  anyGuarded
    ? `
  /**
   * A concurrency-checked call (#129): remember the tag a read hands back, send it
   * as \`If-Match\` on the next write to that same entity.
   *
   * This is what makes the guarantee reachable without the app writing header code.
   * The tag is per (entity type, id) rather than global — two facilities being
   * edited in two tabs do not share one — and it lives on the CLIENT INSTANCE, so a
   * page reload starts empty and the first write after it simply goes unconditional
   * until something has been read.
   *
   * **A 412 evicts the tag rather than replacing it with the current one.** The
   * tempting behaviour is to re-read and retry automatically; that would overwrite
   * whatever change caused the refusal, which is the lost update this exists to
   * prevent. Evicting means the app's own re-read is what re-arms the guard, and
   * until it happens the next write is unconditional — visibly wrong rather than
   * quietly wrong.
   *
   * \`versions\` is exposed on the client so an app can inspect or clear it. Nothing
   * here is hidden state a caller cannot reach.
   */
  const guarded = async (
    entityType: string,
    entityId: unknown,
    path: string,
    method: string,
    body: unknown,
    params: unknown,
  ): Promise<unknown> => {
    const key = \`\${entityType}:\${String(entityId)}\`;
    const held = versions.get(key);
    const res = await raw(
      \`\${baseUrl}\${path}\${query(params as Record<string, unknown>)}\`,
      method,
      body,
      held !== undefined && method !== 'GET' ? { 'If-Match': held } : undefined,
    );
    if (res.status === 412) versions.delete(key);
    const parsed = await parse(res);
    // Read AFTER \`parse\`, which throws on a failure — a tag from an error response
    // describes nothing the caller now holds.
    const tag = res.headers.get('ETag');
    if (tag) versions.set(key, tag);
    return parsed;
  };
`
    : ''
}${
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
${impls.join('\n')}${anyGuarded ? '\n    versions,' : ''}${
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

  const versionsSignature = anyGuarded
    ? `
  /**
   * The entity tags this client is holding, keyed \`entityType:id\` (#129).
   *
   * Populated from every concurrency-checked response and sent back as
   * \`If-Match\` on the next write to that entity — an app writes no header code.
   * Exposed rather than hidden so it can be inspected in a devtools session and
   * cleared when a screen is abandoned; a stale tag causes a 412, never a silent
   * overwrite, so clearing it is safe and keeping it is safe.
   */
  readonly versions: Map<string, string>;
`
    : '';

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
    fail(
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
    `/** Every operation this vertical binds to HTTP, one method each. */\nexport interface ${config.name}Client {\n${methods.join('\n\n')}\n${versionsSignature}${followSignature}}`,
    runtime.trimStart(),
  ].join('\n\n');
}
