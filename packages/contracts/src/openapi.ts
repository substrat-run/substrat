import { z } from 'zod';
import { LIST_PAGE_DEFAULT, LIST_PAGE_MAX, pageSchema } from './pagination.js';
import {
  DOCUMENTED_ERROR_CODES,
  type ErrorCode,
  PROBLEM_CATALOG,
  problem,
} from './errors.js';

/**
 * The API-surface artifact (design/api-surface.md): a vertical exports an
 * OPERATION CATALOG — operation name → summary + the SAME Zod schemas its
 * handlers parse — and this builder renders it as an OpenAPI 3.1 document,
 * one path item per operation on the platform's `/api/op/{name}` convention.
 *
 * One schema object is both the runtime validator and the documented contract,
 * so the document cannot drift from the enforcement (decision 22 cashed in).
 * The same build runs in two places on purpose: the vertical serves it live at
 * `/openapi.json`, and `tools/api-diff.mts` writes it to a checked-in
 * `openapi.json` that CI re-emits with `--check` — so a surface change cannot
 * merge without appearing in the PR diff (the D-22 human checkpoint, given the
 * same mechanical home as the permission diff).
 *
 * Zod 4's native `z.toJSONSchema` emits JSON Schema draft 2020-12 — exactly
 * OpenAPI 3.1's schema dialect — so there is no conversion dependency and no
 * second schema language anywhere in the pipeline.
 */

export interface ApiOperationDoc {
  /** One line, imperative — what invoking this operation does. */
  summary: string;
  /** Optional longer prose (permissions nuance, state-machine rules). */
  description?: string;
  /** Scalar/OpenAPI tag the operation groups under (e.g. 'Leave'). */
  tag?: string;
  /** The request-body schema — the SAME object the handler parses. Omit = no body. */
  input?: z.ZodType;
  /** True when the handler also accepts no body at all (filter-style reads). */
  inputOptional?: boolean;
  /** The response schema, when the vertical declares one (adopted incrementally). */
  output?: z.ZodType;
  /**
   * Where this operation is actually served, when the model declares it.
   *
   * Absent, the document describes the platform's `/api/op/{name}` invoke
   * convention (api-surface.md §2.2) — which was the only shape available
   * before operations declared `http`. Present, the document describes the REST
   * route the server derives from that same declaration, so the document and
   * the router cannot describe different surfaces.
   */
  http?: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string };
  /**
   * Declared by a paged read (#811). `output` then carries the ENTRY schema, and this
   * builder emits the query parameters and the `{ entries, nextCursor }` envelope —
   * so the wrapper is written once here rather than restated by every list operation.
   */
  paged?: { sortKey: string; order?: 'asc' | 'desc'; total?: boolean };
}

/** operation name (module-namespaced, e.g. 'hr/create-employee') → its doc. */
export type ApiCatalog = Record<string, ApiOperationDoc>;

export interface ApiDocumentInfo {
  title: string;
  /** Deterministic — the module manifest's version, never a timestamp. */
  version: string;
  description?: string;
}

/** Where the one problem schema lives in the document, referenced from every failure. */
const PROBLEM_SCHEMA_REF = '#/components/schemas/Problem';

/**
 * Prose per status. Generated descriptions would read like a type listing; these say
 * what the caller should conclude, which is the half a schema cannot carry.
 */
const ERROR_STATUS_PROSE: Readonly<Record<number, string>> = {
  400: 'Validation failed — the input did not parse against the operation schema.',
  401: 'No session — sign in (or present a bearer token) first.',
  403: 'Refused — the caller lacks the permission this operation checks, or policy forbids it.',
  404: 'Unknown operation, or an entity named in the input does not exist.',
  409: 'Conflicts with current state — an illegal transition, a name already taken, or a record that is immutable now.',
  500: 'Internal error. The body carries no `detail`, deliberately — an unreviewed message is not disclosed on a multi-tenant surface.',
  503: 'The deployment cannot serve this — a required platform facility is unconfigured.',
};

/** Component name per documented status — `403` → `#/components/responses/Forbidden`. */
const ERROR_RESPONSE_NAME: Readonly<Record<number, string>> = {
  400: 'ValidationFailed',
  401: 'Unauthenticated',
  403: 'Forbidden',
  404: 'NotFound',
  409: 'Conflict',
  500: 'InternalError',
  503: 'Unavailable',
};

/**
 * The failure half of every operation, derived from the error taxonomy (#113).
 *
 * Bodies are `application/problem+json` (RFC 9457). Both the schema AND the responses
 * themselves live in `components` and are referenced, which is what keeps the
 * checked-in artifact readable: a vertical with 27 operations gains three lines per
 * failure rather than a fully inlined body per failure per operation. `api-diff`'s
 * document is a review artifact, so its signal-to-noise is a real constraint.
 *
 * Every operation currently documents the same set. Narrowing it per operation — a
 * `409` only where a conflict is actually reachable — wants the model layer to own
 * the declaration, and is deferred with it (error-model RFC §6 Q1).
 */
const DOCUMENTED_STATUSES: readonly number[] = [
  ...new Set(DOCUMENTED_ERROR_CODES.map((code) => PROBLEM_CATALOG[code].status)),
].sort((a, b) => a - b);

const ERROR_RESPONSES: Readonly<Record<string, unknown>> = Object.fromEntries(
  DOCUMENTED_STATUSES.map((status) => [
    String(status),
    { $ref: `#/components/responses/${ERROR_RESPONSE_NAME[status]}` },
  ]),
);

/** The definitions those references point at, written once per document. */
const ERROR_RESPONSE_COMPONENTS: Readonly<Record<string, unknown>> = Object.fromEntries(
  DOCUMENTED_STATUSES.map((status) => {
    const codes = DOCUMENTED_ERROR_CODES.filter((code) => PROBLEM_CATALOG[code].status === status);
    const codeList = codes.map((code) => `\`${code}\``).join(' or ');
    return [
      ERROR_RESPONSE_NAME[status] as string,
      {
        description: `${ERROR_STATUS_PROSE[status]} Carries \`code\`: ${codeList}.`,
        content: { 'application/problem+json': { schema: { $ref: PROBLEM_SCHEMA_REF } } },
      },
    ];
  }),
);

// The per-schema `$schema` key is dropped: OpenAPI 3.1's document-wide dialect
// IS draft 2020-12, so repeating it on every request body is pure noise.
const jsonSchema = (schema: z.ZodType, io: 'input' | 'output') => {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io, target: 'draft-2020-12' });
  return rest;
};

/**
 * Render a catalog as an OpenAPI 3.1 document (a plain JSON-able object).
 * Pure and deterministic: same catalog in, byte-identical document out — that
 * is what lets the checked-in artifact double as a drift check.
 */
export function buildOpenApiDocument(
  info: ApiDocumentInfo,
  catalog: ApiCatalog,
): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const [name, op] of Object.entries(catalog)) {
    const url = op.http ? `/api${op.http.path}` : `/api/op/${name}`;
    const verb = op.http ? op.http.method.toLowerCase() : 'post';
    // `{listId}` in the path is a path PARAMETER, and OpenAPI requires it
    // declared or the document is invalid — a renderer will not infer it.
    const params: Record<string, unknown>[] = [...url.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1] as string,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    // A paged read advertises the walk itself (#811). Written here rather than by each
    // operation: the convention is the platform's, so restating it twelve times per
    // vertical is twelve chances to state it differently.
    if (op.paged) {
      params.push(
        {
          name: 'limit',
          in: 'query',
          required: false,
          description: `Page size. Defaults to ${LIST_PAGE_DEFAULT}, capped at ${LIST_PAGE_MAX}.`,
          schema: { type: 'integer', minimum: 1, maximum: LIST_PAGE_MAX, default: LIST_PAGE_DEFAULT },
        },
        {
          name: 'cursor',
          in: 'query',
          required: false,
          description: `The previous page's \`nextCursor\`. Keyset over \`${op.paged.sortKey}\` — exclusive, so no row is repeated.`,
          schema: { type: 'string' },
        },
        {
          name: 'order',
          in: 'query',
          required: false,
          description: 'Walk direction.',
          schema: { type: 'string', enum: ['asc', 'desc'], default: op.paged.order ?? 'asc' },
        },
      );
    }
    // A GET or DELETE carries its input in the QUERY STRING, and the document has to
    // say so (#830). It used to emit every input field as a `requestBody` regardless of
    // verb, so a paged read documented `limit`/`cursor` twice — once as the parameters
    // this builder adds, once inside a JSON body — and documented `q`, `status` and the
    // rest ONLY as body properties. A client generated from that could not discover the
    // filters at all, and the one calling convention that works (`?q=…&limit=100`) did
    // not appear anywhere in the document.
    //
    // The split is not a new declaration: `mountOperations` already decides it, and
    // decides it by VERB — `takesBody = POST | PUT | PATCH`, everything else reads
    // `c.req.query()`. Mirroring that rule here is what keeps the document and the router
    // describing one surface, which is the whole point of deriving both from the model.
    const takesBody = verb === 'post' || verb === 'put' || verb === 'patch';
    if (!takesBody && op.input) {
      const named = new Set(params.map((p) => p['name'] as string));
      const shape = jsonSchema(op.input, 'input') as {
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
      };
      const required = new Set(shape.required ?? []);
      for (const [field, fieldSchema] of Object.entries(shape.properties ?? {})) {
        // Already stated: a path parameter, or one of the paged trio the input restates
        // (`limit`/`cursor` are declared by the operation AND added above). Emitting it
        // twice is the wart #823 acknowledged; deduping by name is the whole fix.
        if (named.has(field)) continue;
        // A single-valued literal is SUPPLIED BY THE ROUTE, not chosen by the caller —
        // `mountOperations` pins it and overrides whatever arrived. Documenting it as a
        // query parameter would invite a client to send a value that cannot matter.
        if ('const' in fieldSchema) continue;
        params.push({
          name: field,
          in: 'query',
          required: required.has(field),
          schema: fieldSchema,
        });
      }
    }
    const existing = (paths[url] ?? {}) as Record<string, unknown>;
    paths[url] = {
      ...existing,
      [verb]: {
        operationId: name.replace(/[^a-zA-Z0-9]+/g, '-'),
        summary: op.summary,
        ...(params.length > 0 ? { parameters: params } : {}),
        ...(op.description ? { description: op.description } : {}),
        ...(op.tag ? { tags: [op.tag] } : {}),
        // Only for a verb that carries one. A `requestBody` on a GET describes a call
        // nobody can make: the mount never reads a body there, so a client that sent one
        // would be ignored (#830).
        ...(op.input && takesBody
          ? {
              requestBody: {
                required: !op.inputOptional,
                content: { 'application/json': { schema: jsonSchema(op.input, 'input') } },
              },
            }
          : {}),
        responses: {
          '200': {
            description: op.paged
              ? op.paged.total
                ? 'One page of results, with the total matching this list’s filter.'
                : 'One page of results.'
              : 'The operation result.',
            ...(op.output
              ? {
                  content: {
                    'application/json': {
                      schema: jsonSchema(
                        op.paged ? pageSchema(op.output, op.paged.total === true) : op.output,
                        'output',
                      ),
                    },
                  },
                }
              : {}),
          },
          ...ERROR_RESPONSES,
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info,
    paths,
    components: {
      // One problem schema, referenced by every failure response above — the same
      // object `toProblem` builds and validates, so the documented failure shape
      // cannot drift from the emitted one.
      schemas: { Problem: jsonSchema(problem, 'output') },
      responses: ERROR_RESPONSE_COMPONENTS,
      securitySchemes: {
        // The primary path: the vertical's own session cookie. Same-origin
        // try-it (the /api/docs page) rides it automatically — the browser
        // attaches it, so there is nothing to paste.
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'sb_session',
          description:
            "The vertical's session cookie. Instances on the Better-Auth provider use its cookie instead; same-origin requests carry either automatically.",
        },
        // The API-client path: OIDC-configured instances also accept the
        // issuer's own bearer token (vertical-auth's resolve fallback).
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    security: [{ session: [] }, { bearer: [] }],
  };
}

/**
 * The API catalog, derived from the declared operations.
 *
 * Every field `ApiOperationDoc` needs — summary, input, output — is already on
 * the operation, declared once and compile-checked there. Writing the catalog by
 * hand is the same duplication as writing the route table by hand, and drifts
 * the same way: Meridian's catalog is 226 lines and Manyfold's 184, all of it
 * restating what the model says.
 *
 * **Why not Hono's OpenAPI support.** It would make the document a function of
 * the route registration rather than of the model, and route registration is
 * itself derived from the model — so the document would be derived from a
 * derivation, one step further from the thing a human approved. It also needs
 * the Zod schemas passed in anyway, which is the part we already have. The
 * usual reason to reach for it is that it gives you validation middleware for
 * free; we do not need that, because `input` IS the schema the handler parses.
 *
 * `tag` and `description` are prose, so they are supplied — the same split as
 * permission descriptions in `manifestOperations`.
 */
export function apiCatalogFrom(
  operations: Readonly<Record<string, object>>,
  prose: Readonly<Record<string, { tag?: string; description?: string }>> = {},
): ApiCatalog {
  const catalog: ApiCatalog = {};
  for (const name of Object.keys(operations).sort()) {
    const op = operations[name] as {
      summary?: unknown;
      input?: z.ZodType;
      inputOptional?: boolean;
      output?: z.ZodType;
    };
    if (typeof op?.summary !== 'string') continue;
    const extra = prose[name] ?? {};
    catalog[name] = {
      summary: op.summary,
      ...(extra.tag ? { tag: extra.tag } : {}),
      ...(extra.description ? { description: extra.description } : {}),
      ...(op.input ? { input: op.input } : {}),
      ...(op.inputOptional ? { inputOptional: true } : {}),
      ...(op.output ? { output: op.output } : {}),
      ...((op as { http?: ApiOperationDoc['http'] }).http
        ? { http: (op as { http: NonNullable<ApiOperationDoc['http']> }).http }
        : {}),
      ...((op as { paged?: ApiOperationDoc['paged'] }).paged
        ? { paged: (op as { paged: NonNullable<ApiOperationDoc['paged']> }).paged }
        : {}),
    };
  }
  return catalog;
}
