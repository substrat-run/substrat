import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AUTH_CHECK_CAP, recordAuthCheck } from '@substrat-run/contracts/auth-diagnostics';
import { oidcAuthProvider } from '@substrat-run/vertical-auth/oidc';
import { substratError } from '@substrat-run/contracts';
import type { ScopeStub } from '@substrat-run/kernel';
import { withInvocationLog, type InvocationLogLine } from '../src/invocation-log.js';
import { mountMcp } from '../src/mcp.js';
import { problemResponse } from '../src/errors.js';
import { ENV, routed } from './routed.js';

const secret = new TextEncoder().encode('a-test-signing-key-at-least-32-bytes-long');
const issuer = 'https://issuer.example';
const resource = 'https://acme.example/api/mcp';
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
async function token(iss = issuer, aud = resource) {
  const encode = (v: unknown) => base64url(new TextEncoder().encode(JSON.stringify(v)));
  const body = `${encode({ alg: 'HS256' })}.${encode({ iss, aud, sub: 'private-subject', exp: Math.floor(Date.now() / 1000) + 300 })}`;
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${body}.${base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))))}`;
}

afterEach(() => vi.restoreAllMocks());
function capture() {
  const lines: InvocationLogLine[] = [];
  vi.spyOn(console, 'log').mockImplementation((value) => {
    const parsed = JSON.parse(String(value));
    if (parsed.substrat === 'invocation') lines.push(parsed);
  });
  return lines;
}
function harness(member: boolean) {
  const app = new Hono();
  const auth = oidcAuthProvider({ issuer, keys: async () => secret });
  app.onError((error, c) => problemResponse(c, error));
  mountMcp(app, {}, async (c) => {
    const subject = await auth.resolve(c.req.raw.headers, c.req.url);
    if (!subject) throw new HTTPException(401, { message: 'sign in' });
    if (!member) throw new HTTPException(403, { message: 'membership required' });
    return { subjectKind: 'principal' } as ScopeStub;
  });
  // The platform wrapper is the only middleware, as in an uploaded vertical.
  return withInvocationLog({ fetch: (req) => app.fetch(req as Request) }, {
    routerSecret: () => ENV.ROUTER_SECRET, asyncLocalStorage: AsyncLocalStorage,
  });
}
function request(value?: string) {
  return new Request(resource, {
    method: 'POST', headers: { ...routed, 'content-type': 'application/json', ...(value ? { authorization: `Bearer ${value}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
  });
}

describe('authentication on the emitted invocation line', () => {
  it('explains a 403 after successful verification without pretending to know the app’s policy', async () => {
    const lines = capture();
    const response = await harness(false).fetch!(request(await token()), ENV, {});
    expect(response.status).toBe(403);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: 403, threw: false, problemCode: 'forbidden', principalKind: null, authChecks: [
      { stage: 'bearer', outcome: 'accepted', reason: 'verified' },
      { stage: 'mcp-caller', outcome: 'refused', reason: 'caller-refused' },
    ] });
    expect(JSON.stringify(lines)).not.toContain('private-subject');
    expect(JSON.stringify(lines)).not.toContain('membership required');
    expect((response as Response).headers.get('www-authenticate')).toBeNull();
  });

  it('keeps concurrent accepted and refused requests in their own records', async () => {
    const lines = capture();
    const worker = harness(true);
    const [valid, invalid] = await Promise.all([token(), token('https://other.example')]);
    const responses = await Promise.all([worker.fetch!(request(valid), ENV, {}), worker.fetch!(request(invalid), ENV, {})]);
    expect(responses.map((r) => r.status)).toEqual([200, 401]);
    expect(lines.find((l) => l.status === 200)?.authChecks).toEqual([
      { stage: 'bearer', outcome: 'accepted', reason: 'verified' },
      { stage: 'mcp-caller', outcome: 'accepted', reason: 'caller-resolved' },
    ]);
    expect(lines.find((l) => l.status === 401)?.authChecks).toEqual([
      { stage: 'bearer', outcome: 'refused', reason: 'issuer-invalid' },
      { stage: 'mcp-caller', outcome: 'refused', reason: 'caller-refused' },
    ]);
    expect((responses[1] as Response).headers.get('www-authenticate')).toContain('Bearer');
  });

  it('records the audience precheck before a resolver runs, and missing credentials separately', async () => {
    const lines = capture();
    const worker = harness(true);
    expect((await worker.fetch!(request(await token(issuer, 'https://other.example/api/mcp')), ENV, {})).status).toBe(401);
    expect(lines[0]?.authChecks).toEqual([{ stage: 'mcp-audience', outcome: 'refused', reason: 'resource-mismatch' }]);
    expect((await worker.fetch!(request(), ENV, {})).status).toBe(401);
    expect(lines[1]?.authChecks?.[0]).toEqual({ stage: 'bearer', outcome: 'absent', reason: 'credential-missing' });
  });

  it('bounds checks on the emitted line and records typed problems from early HTTP refusals', async () => {
    const lines = capture();
    const app = new Hono();
    app.onError((err, c) => problemResponse(c, err));
    app.post('/api/mcp', () => {
      for (let i = 0; i < AUTH_CHECK_CAP + 2; i++) recordAuthCheck({ stage: 'bearer', outcome: 'absent', reason: 'credential-missing' });
      throw substratError('forbidden', 'private refusal detail');
    });
    const worker = withInvocationLog({ fetch: (req) => app.fetch(req as Request) }, { routerSecret: () => ENV.ROUTER_SECRET, asyncLocalStorage: AsyncLocalStorage });
    expect((await worker.fetch!(request(), ENV, {})).status).toBe(403);
    expect(lines[0]?.authChecks).toHaveLength(AUTH_CHECK_CAP);
    expect(lines[0]).toMatchObject({ authChecksDropped: 2, problemCode: 'forbidden' });
    expect(JSON.stringify(lines)).not.toContain('private refusal detail');
  });
});
