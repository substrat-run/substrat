/**
 * The dashboard's OpenAPI document — derived from the declared routes, not authored (#2170).
 *
 * `dashboardRoutes` is the object `mountRoutes` serves and `lint:client` renders the browser
 * client from, so the document, the route table and the client describe one surface. Each
 * path is written under `/teams/{teamId}`, the base the mount applies once. `pnpm lint:api`
 * writes it to the checked-in `openapi.json` and CI holds it with `--check`; the file is the
 * reviewable artifact, not something the worker serves.
 *
 * Every route is documented with `idempotency: false`: `mountRoutes`, unlike
 * `mountOperations`, does not honour `Idempotency-Key`, and a retry token documented where it
 * is ignored is one a client builds on. The team-less routes (`/api/me`, team create and
 * switch, invite accept, webhooks, OAuth callbacks) are not declared, so they are not here.
 */
import { buildOpenApiDocument, type ApiCatalog } from '@substrat-run/contracts';
import { dashboardRoutes } from './routes.js';

const catalog: ApiCatalog = {};
for (const name of Object.keys(dashboardRoutes).sort()) {
  const route = dashboardRoutes[name as keyof typeof dashboardRoutes] as {
    summary: string;
    input?: ApiCatalog[string]['input'];
    output: NonNullable<ApiCatalog[string]['output']>;
    http: NonNullable<ApiCatalog[string]['http']>;
    status?: 200 | 201 | 202;
    responseHeaders?: readonly string[];
  };
  catalog[name] = {
    summary: route.summary,
    ...(route.input ? { input: route.input } : {}),
    output: route.output,
    http: { method: route.http.method, path: `/teams/{teamId}${route.http.path}` },
    idempotency: false,
    ...(route.status ? { status: route.status } : {}),
    ...(route.responseHeaders ? { responseHeaders: route.responseHeaders } : {}),
  };
}

export const API_DOCUMENT = buildOpenApiDocument(
  {
    title: 'Substrat Dashboard',
    // The surface's version, not the package's: a release bump must not redden `lint:api`.
    version: '1',
    description: "The dashboard's team-scoped routes. Every path names the team it acts on.",
  },
  catalog,
);
