import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintSession, verifySession, type OidcEnv } from '@substrat-run/oidc-rp';
import { ulid } from '@substrat-run/kernel';
import type { ModelUsageLine } from '@substrat-run/contracts';
import { DEV_MODEL_SCOPE, DEV_MODEL_VERSION, mountModelAccessRoutes, type ModelAccessMember } from '../src/model-access.js';

/**
 * `substrat dev`'s model access (#3420), the server half: the token is issued only to a member of
 * the workspace, and a call runs only on a live token for the workspace in its path, over the
 * plane's own gateway keys, with the workspace's attribution whatever the caller sent.
 */

const oidcEnv = { SESSION_SECRET: env.SESSION_SECRET } as unknown as OidcEnv;
const TENANT = ulid();
const OTHER_TENANT = ulid();
const MEMBER: ModelAccessMember = { actor: ulid(), tenantId: TENANT, tenantSlug: 'acme' };
const GATEWAY = { CLOUDFLARE_AI_BASE_URL: 'https://gateway.test/v1', CLOUDFLARE_AI_API_TOKEN: 'platform-key' };
const MODEL = '@cf/meta/llama-3.1-8b-instruct';

let upstream: { url: string; headers: Headers; body: Record<string, unknown> }[];
let recorded: { requestId: string; line: ModelUsageLine }[];
let answer: () => Response;
let gatewayOn: boolean;

function world(): Hono<{ Bindings: OidcEnv }> {
  const app = new Hono<{ Bindings: OidcEnv }>();
  mountModelAccessRoutes(app, {
    member: async (_env, request) => (request.headers.get('authorization') === 'Bearer member-session' ? MEMBER : null),
    gateway: () => (gatewayOn ? GATEWAY : null),
    record: async (_env, input) => {
      recorded.push(input);
    },
    fetch: async (request) => {
      upstream.push({ url: request.url, headers: request.headers, body: (await request.json()) as Record<string, unknown> });
      return answer();
    },
  });
  return app;
}

const call = (app: Hono<{ Bindings: OidcEnv }>, path: string, init: RequestInit) => app.request(`https://cp.test${path}`, init, oidcEnv);

async function issue(app: Hono<{ Bindings: OidcEnv }>): Promise<{ token: string; tenant: { id: string; slug: string }; expiresAt: string }> {
  const res = await call(app, '/api/model-access', { method: 'POST', headers: { authorization: 'Bearer member-session' } });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; tenant: { id: string; slug: string }; expiresAt: string };
}

const chat = (app: Hono<{ Bindings: OidcEnv }>, tenant: string, token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  call(app, `/api/model-access/${tenant}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  upstream = [];
  recorded = [];
  gatewayOn = true;
  answer = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'hej' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
});

describe('model access for substrat dev', () => {
  it('issues a workspace token to a member only, and answers 501 when the plane offers none', async () => {
    const app = world();
    expect((await call(app, '/api/model-access', { method: 'POST', headers: { authorization: 'Bearer stranger' } })).status).toBe(401);
    const issued = await issue(app);
    expect(issued.tenant).toEqual({ id: TENANT, slug: 'acme' });
    expect(Date.parse(issued.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    // A model token is not a session: it carries no subject, so the session reader refuses it.
    expect(await verifySession(oidcEnv, issued.token)).toBeNull();

    gatewayOn = false;
    expect((await call(app, '/api/model-access', { method: 'POST', headers: { authorization: 'Bearer member-session' } })).status).toBe(501);
  });

  it('runs a call over the plane key, filed under the workspace whatever the caller claimed', async () => {
    const app = world();
    const { token } = await issue(app);
    const claimed = JSON.stringify({ tenant: OTHER_TENANT, scope: ulid(), vertical: '@acme/shop', version: '9', operation: 'shop/ask' });
    const res = await chat(app, TENANT, token, { model: MODEL, messages: [{ role: 'user', content: 'hi' }] }, { 'cf-aig-metadata': claimed });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { choices: { message: { content: string } }[] }).choices[0]!.message.content).toBe('hej');
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toBe('https://gateway.test/v1/chat/completions');
    expect(upstream[0]!.headers.get('authorization')).toBe('Bearer platform-key');
    expect(upstream[0]!.headers.get('cf-aig-collect-log-payload')).toBe('false');
    const attribution = { tenant: TENANT, scope: DEV_MODEL_SCOPE, vertical: '@acme/shop', version: DEV_MODEL_VERSION, operation: 'shop/ask' };
    expect(JSON.parse(upstream[0]!.headers.get('cf-aig-metadata')!)).toEqual(attribution);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.line).toMatchObject({ attribution, model: `cloudflare:${MODEL}`, reported: true, inputTokens: 12, outputTokens: 3 });
  });

  it('refuses an expired token, a session, another workspace, and a model outside Workers AI', async () => {
    const app = world();
    const { token } = await issue(app);
    const body = { model: MODEL, messages: [{ role: 'user', content: 'hi' }] };

    const expired = await new SignJWT({ purpose: 'model-access', tenant: TENANT, actor: MEMBER.actor })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(env.SESSION_SECRET));
    expect((await chat(app, TENANT, expired, body)).status).toBe(401);
    // The long-lived login is not a model token either.
    const session = await mintSession(oidcEnv, { id: ulid(), email: 'dev@acme.test', emailVerified: true });
    expect((await chat(app, TENANT, session, body)).status).toBe(401);
    expect((await chat(app, OTHER_TENANT, token, body)).status).toBe(403);
    expect((await chat(app, TENANT, token, { ...body, model: 'openai/gpt-4.1-mini' })).status).toBe(400);
    expect((await chat(app, TENANT, token, { ...body, max_tokens: 100_000 })).status).toBe(400);
    expect(upstream).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it('asks a streamed call for its usage, and records it from the final event', async () => {
    const app = world();
    const { token } = await issue(app);
    const events = [
      { choices: [{ delta: { content: 'he' } }] },
      { choices: [{ delta: { content: 'j' } }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 2 } },
    ];
    answer = () =>
      new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    const res = await chat(app, TENANT, token, { model: MODEL, stream: true, messages: [{ role: 'user', content: 'hi' }] });

    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toContain('[DONE]');
    expect(upstream[0]!.body['stream_options']).toEqual({ include_usage: true });
    expect(recorded[0]!.line).toMatchObject({ reported: true, inputTokens: 20, outputTokens: 2 });
  });
});
