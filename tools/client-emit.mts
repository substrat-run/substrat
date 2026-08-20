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
          `  type it never checked. Remedy: teach tsType() this case, or declare the field with\n` +
          `  a shape the client can carry.`,
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

/** `todo/create-list` → `createList`. The module prefix is the client's own identity. */
const methodName = (operation: string) => camel(operation.slice(operation.indexOf('/') + 1));

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
function preamble(name: string, source: string, anyPaged: boolean): string {
  return `// GENERATED by tools/client-emit.mts from ${source} — do not edit by hand.
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

function emit(vertical: string, config: ClientConfig, entities: Record<string, unknown>, operations: Record<string, unknown>): string {
  const named = new Map<unknown, string>();
  for (const [key, def] of Object.entries(entities)) {
    const fields = (def as { fields?: unknown })?.fields;
    if (!fields) cannot(`${vertical}: entity '${key}' has no \`fields\` schema`);
    named.set(fields, pascal(key));
  }

  const ctx: PrintContext = { named, where: vertical };

  // Entities first: every operation's types lean on these names.
  const entityBlocks = Object.entries(entities).map(([key, def]) => {
    const fields = (def as { fields: unknown }).fields;
    const shape = defOf(fields)?.shape ?? {};
    const table = (def as { table?: string }).table;
    return (
      `/** \`${table ?? key}\` — declared in ${config.model}. */\n` +
      `export interface ${pascal(key)} {\n${interfaceBody(shape, { ...ctx, where: `${vertical}.${key}` })}\n}`
    );
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

  const seen = new Map<string, string>();
  const methods: string[] = [];
  const impls: string[] = [];
  let anyPaged = false;

  for (const [operation, op] of declared) {
    const method = methodName(operation);
    const clash = seen.get(method);
    if (clash) {
      cannot(
        `${vertical}: '${clash}' and '${operation}' both name the client method \`${method}\`.\n` +
          `  Remedy: rename one operation — two methods with one name is a call site that\n` +
          `  silently reaches the wrong endpoint.`,
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

  return [
    preamble(config.name, config.model, anyPaged),
    entityBlocks.join('\n\n'),
    `/** Every operation this vertical binds to HTTP, one method each. */\nexport interface ${config.name}Client {\n${methods.join('\n\n')}\n${followSignature}}`,
    runtime.trimStart(),
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------

interface ClientConfig {
  readonly model: string;
  readonly entities: string;
  readonly operations: string;
  readonly out: string;
  readonly name: string;
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
  const modelPath = join(dir, config.model);
  if (!existsSync(modelPath)) cannot(`${rel}: substrat.client.model points at ${config.model}, which does not exist`);

  const mod = (await import(pathToFileURL(modelPath).href)) as Record<string, unknown>;
  const entities = mod[config.entities] as Record<string, unknown> | undefined;
  const operations = mod[config.operations] as Record<string, unknown> | undefined;
  if (!entities || typeof entities !== 'object') {
    cannot(`${rel}: ${config.model} exports no \`${config.entities}\``);
  }
  if (!operations || typeof operations !== 'object') {
    cannot(`${rel}: ${config.model} exports no \`${config.operations}\``);
  }

  const content = emit(rel, config, entities, operations);
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
