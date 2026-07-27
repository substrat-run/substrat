import { z } from 'zod';

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
}

/** operation name (module-namespaced, e.g. 'hr/create-employee') → its doc. */
export type ApiCatalog = Record<string, ApiOperationDoc>;

export interface ApiDocumentInfo {
  title: string;
  /** Deterministic — the module manifest's version, never a timestamp. */
  version: string;
  description?: string;
}

const ERROR_RESPONSES = {
  '400': { description: 'Validation failed — the input did not parse against the operation schema.' },
  '401': { description: 'No session — sign in (or present a bearer token) first.' },
  '403': { description: 'Permission denied — the caller lacks the permission this operation checks.' },
  '404': { description: 'Unknown operation, or an entity named in the input does not exist.' },
} as const;

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
    paths[`/api/op/${name}`] = {
      post: {
        operationId: name.replace(/[^a-zA-Z0-9]+/g, '-'),
        summary: op.summary,
        ...(op.description ? { description: op.description } : {}),
        ...(op.tag ? { tags: [op.tag] } : {}),
        ...(op.input
          ? {
              requestBody: {
                required: !op.inputOptional,
                content: { 'application/json': { schema: jsonSchema(op.input, 'input') } },
              },
            }
          : {}),
        responses: {
          '200': {
            description: 'The operation result.',
            ...(op.output
              ? { content: { 'application/json': { schema: jsonSchema(op.output, 'output') } } }
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
