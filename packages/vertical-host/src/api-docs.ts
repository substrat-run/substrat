/** The reference is platform plumbing; the document and its auth stay with the app. */
import type { Hono } from 'hono';
import { servedPathOf } from './mcp-guard.js';
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
    const response = await fetch('/openapi.json', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
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

/** Repeated mounts share one reference; an app's existing reference takes precedence. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountApiDocs(app: Hono<any, any, any>): void {
  if (!app.routes.some((route) => route.method === 'GET' && route.path === servedPathOf(app, '/api/docs'))) {
    app.get('/api/docs', (c) => c.html(HTML));
  }
  if (!app.routes.some((route) => route.method === 'GET' && route.path === servedPathOf(app, '/api/docs/renderer.js'))) {
    app.get('/api/docs/renderer.js', (c) => c.body(DOCS_RENDERER, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    }));
  }
}
