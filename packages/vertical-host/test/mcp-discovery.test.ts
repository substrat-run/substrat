import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { MCP_AUTHORIZATION_SERVERS_PATH } from '@substrat-run/contracts';
import { oidcRpAuthProvider } from '@substrat-run/vertical-auth/oidc-rp-provider';
import { mountOperations } from '../src/operations-routes.js';

const operations = { 'demo/whoami': { http: { method: 'GET', path: '/me' } } } as const;
const metadataPath = '/.well-known/oauth-protected-resource/api/mcp';

function hosted() {
  const app = new Hono<{ Bindings: { issuer: string } }>();
  const seen: { issuer: string; cookie: string | null; bearer: string | null; scope: string | null }[] = [];
  // The ordinary hosted composition: forward auth requests to this scope's provider.
  app.all('/api/auth/*', (c) => {
    seen.push({ issuer: c.env.issuer, cookie: c.req.header('cookie') ?? null,
      bearer: c.req.header('authorization') ?? null, scope: c.req.header('x-substrat-scope') ?? null });
    return oidcRpAuthProvider({ issuer: c.env.issuer, clientId: 'vertical', clientSecret: 'test', sessionSecret: 'test' })
      .handle(c.req.raw);
  });
  mountOperations(app, operations, async () => { throw new HTTPException(401); });
  return { app, seen };
}

describe('default hosted MCP discovery', () => {
  it('uses per-request auth wiring, preserves scope assertions, and sends no user credentials', async () => {
    const { app, seen } = hosted();
    for (const [origin, issuer] of [['https://a.example', 'https://issuer-a.example'], ['https://b.example', 'https://issuer-b.example']]) {
      const response = await app.request(`${origin}${metadataPath}`, {
        headers: { cookie: 'session=private', authorization: 'Bearer private', 'x-substrat-scope': 'scope-a' },
      }, { issuer });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ resource: `${origin}/api/mcp`, authorization_servers: [issuer], bearer_methods_supported: ['header'] });
    }
    expect(seen).toEqual([
      { issuer: 'https://issuer-a.example', cookie: null, bearer: null, scope: 'scope-a' },
      { issuer: 'https://issuer-b.example', cookie: null, bearer: null, scope: 'scope-a' },
    ]);
  });

  it('serves root discovery and publishes no invalid issuer or credentials', async () => {
    const { app } = hosted();
    const response = await app.request('https://a.example/.well-known/oauth-protected-resource', undefined, { issuer: 'http://public.example' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resource: 'https://a.example/api/mcp', bearer_methods_supported: ['header'] });
  });

  it('exposes only read-only issuer configuration on the auth discovery route', async () => {
    const { app } = hosted();
    const response = await app.request(`https://a.example${MCP_AUTHORIZATION_SERVERS_PATH}`, undefined, { issuer: 'https://issuer.example' });
    expect(await response.json()).toEqual({ authorization_servers: ['https://issuer.example'] });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const write = await app.request(`https://a.example${MCP_AUTHORIZATION_SERVERS_PATH}`, { method: 'POST' }, { issuer: 'https://issuer.example' });
    expect(write.status).toBe(405);
    expect(write.headers.get('allow')).toBe('GET');
  });

  it.each([
    { body: '<html>SPA fallback</html>', type: 'text/html' },
    { body: '{"service":"demo"}', type: 'application/json' },
    { body: '{"authorization_servers":[42]}', type: 'application/json' },
    { body: 'invalid json', type: 'application/json' },
  ])('does not mistake an auth fallback for issuer configuration: $body', async ({ body, type }) => {
    const app = new Hono();
    app.get('/api/auth/*', () => new Response(body, { headers: { 'content-type': type } }));
    mountOperations(app, operations, async () => { throw new HTTPException(401); });
    const response = await app.request(metadataPath);
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('authorization_servers');
  });

  it('leaves an explicit issuer override in charge without calling the default auth route', async () => {
    const app = new Hono();
    let reads = 0;
    app.get('/api/auth/*', () => { reads++; return Response.json({ authorization_servers: ['https://wrong.example'] }); });
    mountOperations(app, operations, async () => { throw new HTTPException(401); }, {
      mcp: { protectedResource: { authorizationServers: ['https://explicit.example'] } },
    });
    expect(await (await app.request(metadataPath)).json()).toMatchObject({ authorization_servers: ['https://explicit.example'] });
    expect(reads).toBe(0);
  });
});
