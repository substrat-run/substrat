import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from '@substrat-run/contracts';
import type { ScopeStub } from '@substrat-run/kernel';
import { mountOperations } from '../src/operations-routes.js';

function appWithDocs() {
  const app = new Hono();
  mountOperations(app, {}, async () => { throw new Error('docs must not resolve a scope'); }, { mcp: false });
  app.all('/api/*', (c) => c.json({ error: 'unknown route' }, 404));
  return app;
}

async function browser(statusCode: number, content: unknown) {
  const html = await (await appWithDocs().request('/api/docs')).text();
  const status = { textContent: '', append: vi.fn(), remove: vi.fn() };
  const fetch = vi.fn(async () => ({ status: statusCode, ok: statusCode === 200, json: async () => content }));
  const createApiReference = vi.fn();
  const document = { getElementById: () => status, createElement: () => ({ href: '', textContent: '' }) };
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeDefined();
  await runInNewContext(script!, { document, fetch, window: { Scalar: true }, Scalar: { createApiReference }, Error });
  return { status, fetch, createApiReference };
}

describe('automatic API reference', () => {
  it('serves the page and its real renderer before an app API catch-all', async () => {
    const app = appWithDocs();
    const page = await app.request('/api/docs');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('src="./docs/renderer.js"');
    const renderer = await app.request('/api/docs/renderer.js');
    expect(renderer.status).toBe(200);
    expect(renderer.headers.get('content-type')).toContain('text/javascript');
    expect((await renderer.text()).length).toBeGreaterThan(100_000);
    expect((await app.request('/api/missing')).status).toBe(404);
  });

  it('renders the app specification with its existing session and no proxy', async () => {
    const spec = { openapi: '3.1.0', paths: {} };
    const b = await browser(200, spec);
    // Beside the page, under the API prefix a dev proxy and a hosted worker-first route both carry.
    expect(b.fetch).toHaveBeenCalledWith('./openapi.json', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    expect(b.createApiReference).toHaveBeenCalledWith('#app', { content: spec, hideClientButton: true });
    expect(b.status.remove).toHaveBeenCalled();
  });

  it.each([401, 403, 404, 500])('shows a useful message when the spec responds %i', async (code) => {
    const b = await browser(code, {});
    expect(b.createApiReference).not.toHaveBeenCalled();
    expect(b.status.textContent).toMatch(/Sign in|cannot access|not made/);
  });

  it.each([{}, null])('explains an invalid document (%s) instead of rendering it', async (content) => {
    const b = await browser(200, content);
    expect(b.status.textContent).toContain('did not return an OpenAPI');
    expect(b.createApiReference).not.toHaveBeenCalled();
  });

  it('mounts once under a Hono base path with a relative renderer URL', async () => {
    const app = new Hono().basePath('/v1');
    const unused = async () => { throw new Error('unused'); };
    mountOperations(app, {}, unused, { mcp: false });
    mountOperations(app, {}, unused, { mcp: false });
    expect(app.routes.filter((r) => r.path === '/v1/api/docs')).toHaveLength(1);
    expect((await app.request('/v1/api/docs')).status).toBe(200);
    expect((await app.request('/v1/api/docs/renderer.js')).status).toBe(200);
  });

  it('serves the operations it mounts as the document, through the app door', async () => {
    const operations = {
      'shop/get-bike': {
        summary: 'Read one bike.',
        input: z.object({ bikeId: z.string() }),
        http: { method: 'GET', path: '/bikes/{bikeId}' },
      },
      // Not mounted, so not documented: the document describes the routes that exist.
      'shop/unrouted': { summary: 'Reachable through /api/invoke only.', input: z.object({}) },
    };
    const app = new Hono();
    mountOperations(app, operations, async (c) => {
      if (c.req.header('cookie') !== 'sb_session=yes') throw new HTTPException(401, { message: 'unauthorized' });
      return {} as ScopeStub;
    }, { mcp: false, docs: { info: { title: 'Bike shop', version: '1.2.0' } } });

    expect((await app.request('/api/openapi.json')).status).toBe(401);
    const act = `Bearer x.${btoa(JSON.stringify({ act: { sub: 'agent' } }))}.y`;
    expect((await app.request('/api/openapi.json', { headers: { cookie: 'sb_session=yes', authorization: act } })).status).toBe(401);
    const response = await app.request('/api/openapi.json', { headers: { cookie: 'sb_session=yes' } });
    expect(response.status).toBe(200);
    const document = (await response.json()) as { info: unknown; paths: Record<string, Record<string, { summary: string }>> };
    expect(document.info).toEqual({ title: 'Bike shop', version: '1.2.0' });
    expect(Object.keys(document.paths)).toEqual(['/api/bikes/{bikeId}']);
    expect(document.paths['/api/bikes/{bikeId}']?.['get']?.summary).toBe('Read one bike.');
  });

  it('preserves an existing app reference and supports opting out', async () => {
    const app = new Hono();
    app.get('/api/docs', (c) => c.text('custom reference'));
    mountOperations(app, {}, async () => { throw new Error('unused'); }, { mcp: false });
    expect(await (await app.request('/api/docs')).text()).toBe('custom reference');
    const off = new Hono();
    mountOperations(off, {}, async () => { throw new Error('unused'); }, { mcp: false, docs: false });
    expect((await off.request('/api/docs')).status).toBe(404);
    expect((await off.request('/api/openapi.json')).status).toBe(404);
  });

  it("serves a document the vertical already builds, or the route it registered first", async () => {
    const own = { openapi: '3.1.0', info: { title: 'Own', version: '1' }, paths: {} };
    const given = new Hono();
    mountOperations(given, {}, async () => ({}) as ScopeStub, { mcp: false, docs: { document: own } });
    expect(await (await given.request('/api/openapi.json')).json()).toEqual(own);
    const first = new Hono();
    first.get('/api/openapi.json', (c) => c.json({ registered: 'first' }));
    mountOperations(first, {}, async () => ({}) as ScopeStub, { mcp: false });
    expect(await (await first.request('/api/openapi.json')).json()).toEqual({ registered: 'first' });
  });
});
