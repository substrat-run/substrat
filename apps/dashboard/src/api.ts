/**
 * The dashboard's OpenAPI document — derived from the declared routes, not authored (#2170).
 *
 * `dashboardRoutes` and `accountRoutes` are the objects `mountRoutes` serves and `lint:client`
 * renders the browser clients from, so the document, the route tables and the clients describe
 * one surface. A team route's path is written under `/teams/{teamId}`, the base its mount
 * applies once; a team-less route's path is its own. `pnpm lint:api` writes it to the
 * checked-in `openapi.json` and CI holds it with `--check`; the file is the reviewable
 * artifact, not something the worker serves.
 *
 * Every route is documented with `idempotency: false`: `mountRoutes`, unlike
 * `mountOperations`, does not honour `Idempotency-Key`, and a retry token documented where it
 * is ignored is one a client builds on. Webhooks, OAuth callbacks and the invite preview are
 * not declared, so they are not here.
 */
import { buildOpenApiDocument, type ApiCatalog } from '@substrat-run/contracts';
import { SESSION_COOKIE } from '@substrat-run/oidc-rp';
import { accountRoutes, dashboardRoutes } from './routes.js';

type DeclaredRoute = {
  summary: string;
  input?: ApiCatalog[string]['input'];
  output: NonNullable<ApiCatalog[string]['output']>;
  http: NonNullable<ApiCatalog[string]['http']>;
  status?: 200 | 201 | 202;
  statuses?: readonly (200 | 201 | 202)[];
  responseHeaders?: readonly string[];
};

const catalog: ApiCatalog = {};
const declare = (routes: Record<string, unknown>, base: string) => {
  for (const name of Object.keys(routes).sort()) {
    const route = routes[name] as DeclaredRoute;
    catalog[name] = {
      summary: route.summary,
      ...(route.input ? { input: route.input } : {}),
      output: route.output,
      http: { method: route.http.method, path: `${base}${route.http.path}` },
      idempotency: false,
      ...(route.status ? { status: route.status } : {}),
      ...(route.statuses ? { statuses: route.statuses } : {}),
      ...(route.responseHeaders ? { responseHeaders: route.responseHeaders } : {}),
    };
  }
};
declare(dashboardRoutes, '/teams/{teamId}');
declare(accountRoutes, '');

export const API_DOCUMENT = buildOpenApiDocument(
  {
    title: 'Substrat Dashboard',
    // The surface's version, not the package's: a release bump must not redden `lint:api`.
    version: '1',
    description:
      "The dashboard's routes. Every path under /teams/{teamId} names the team it acts on; the rest are about the signed-in login.",
  },
  catalog,
  // `teamContext` and `sessionContext` resolve the caller from the session cookie alone; there is no bearer path.
  {
    schemes: {
      session: {
        type: 'apiKey',
        in: 'cookie',
        name: SESSION_COOKIE,
        description:
          "The dashboard's session cookie, set when you sign in. Same-origin requests carry it automatically.",
      },
    },
    requirement: [{ session: [] }],
  },
);
