/**
 * The reference and the document it renders are platform plumbing; the auth stays with the app.
 *
 * The page used to read the app's own `/openapi.json`, and only an app that wrote that route had
 * one. The scaffold and every app the builder generated wrote none, so their `/api/docs` explained
 * that the app "has not made its API specification available", on the dev server and hosted
 * alike. A route at the origin's root was the wrong home for it anyway: a dev server's Vite proxy
 * forwards `/api` and a hosted app with static assets runs its worker first for `/api/*`, so a
 * root `/openapi.json` reached neither unless each app remembered to route it.
 *
 * So the document sits beside the page, at `${base}/openapi.json`, rendered from the operations
 * the mount was handed: the catalog the REST routes and the MCP tools are rendered from, so the
 * three cannot describe different surfaces. It is read through the app's own `resolveStub`, the
 * same door every route takes, because the document enumerates the surface.
 */
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { carriesAct, servedPathOf } from './mcp-guard.js';
import { DOCS_RENDERER } from './docs-renderer.generated.js';

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API reference</title>
<style>body{margin:0}#status{font:16px system-ui;padding:24px}</style>
</head>
<body>
<div id="status" role="status">Loading API reference…</div><div id="app"></div>
<script src="./docs/renderer.js"></script>
<script>
(async () => {
  const status = document.getElementById('status');
  try {
    const response = await fetch('./openapi.json', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (response.status === 401) {
      status.textContent = 'Sign in to the app, then reload this reference. ';
      const link = document.createElement('a'); link.href = '/'; link.textContent = 'Open app'; status.append(link);
      return;
    }
    if (response.status === 403) throw new Error('Your account cannot access this API specification.');
    if (!response.ok) throw new Error('The app has not made its API specification available (' + response.status + ').');
    const content = await response.json().catch(() => {
      throw new Error('The app did not return an OpenAPI specification.');
    });
    if (!content || !content.openapi || !content.paths) throw new Error('The app did not return an OpenAPI specification.');
    if (!window.Scalar) throw new Error('The API reference renderer could not load. Reload to try again.');
    Scalar.createApiReference('#app', { content, hideClientButton: true });
    status.remove();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Unable to load the API specification.';
  }
})();
</script>
</body></html>`;

export interface ApiDocsMount {
  /** The mount's base path: the page is `${base}/docs`, the document `${base}/openapi.json`. */
  readonly base: string;
  /** The document. Called on the first request that reaches it, and kept. */
  readonly document: () => Record<string, unknown>;
  /** The app's own door: throws (a 401, for nobody signed in) when the caller may not read it. */
  readonly authenticate: (c: Context) => Promise<unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registered = (app: Hono<any, any, any>, path: string): boolean =>
  app.routes.some((route) => route.method === 'GET' && route.path === servedPathOf(app, path));

/** Repeated mounts share one reference; a route the app registered first takes precedence. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountApiDocs(app: Hono<any, any, any>, mount: ApiDocsMount): void {
  const page = `${mount.base}/docs`;
  if (!registered(app, page)) {
    app.get(page, (c) => c.html(HTML));
  }
  if (!registered(app, `${page}/renderer.js`)) {
    app.get(`${page}/renderer.js`, (c) => c.body(DOCS_RENDERER, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    }));
  }
  const documentPath = `${mount.base}/openapi.json`;
  if (!registered(app, documentPath)) {
    let built: Record<string, unknown> | undefined;
    app.get(documentPath, async (c) => {
      // Like every operation route: a delegated token is for the MCP endpoint only (#1824).
      if (carriesAct(c.req.header('authorization'))) {
        throw new HTTPException(401, { message: 'a delegated token is accepted only at the MCP endpoint' });
      }
      await mount.authenticate(c);
      built ??= mount.document();
      return c.json(built);
    });
  }
}
