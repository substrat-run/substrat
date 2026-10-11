/**
 * A login's places (#1670), through the deployed worker: what Meridian tells the identity pool,
 * about whom, and to whom.
 *
 * The pool keeps one index per issuer, keyed on the `sub` it minted, and shows a login only its
 * own entries. So the question for a vertical is not "does it report" but "can what it reports
 * name anything but this login in this scope". This drives `src/worker.ts` as the router and the
 * platform do (router assertion headers, `/internal/*` with the platform secret) against a fake
 * issuer that records every request, and holds:
 *
 *   - `/api/me` reports the caller's OWN `sub` as present in the routed scope once it is bound,
 *     and as absent for a login that is not, and a repeat costs no second request;
 *   - the reconcile repair reports exactly the subjects bound in that scope;
 *   - the twins: a scope with no delivered identity, and an issuer that keeps no index, are sent
 *     nothing, and no report names a scope other than the one the request was routed to.
 */
import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { principalId, scopeId, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { resetPlacesMemo } from '@substrat-run/vertical-auth';

/** The relying-party session cookie (`@substrat-run/oidc-rp`'s name), and a mint for it: an HS256 JWT. */
const SESSION_COOKIE = 'sb_session';
async function mintSession(secret: string, user: { id: string; email: string; name: string }): Promise<string> {
  const b64 = (v: ArrayBuffer | string) =>
    btoa(typeof v === 'string' ? v : String.fromCharCode(...new Uint8Array(v)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64(JSON.stringify({ alg: 'HS256' }))}.${b64(
    JSON.stringify({ sub: user.id, email: user.email, name: user.name, iat: now, exp: now + 3600 }),
  )}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${unsigned}.${b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned)))}`;
}

const owner = principalId.parse(ulid());
const INSTALLED = JSON.parse(env.TEST_INSTALL_ENTITLEMENTS) as string[];
const entitlements = INSTALLED.map((entitlementKey) => ({
  entitlementKey,
  expiresAt: null,
  quota: null,
  plan: null,
  grantedAt: null,
  grantedBy: null,
}));

interface Report {
  client_id: string;
  client_secret: string;
  scope_id: string;
  op: 'present' | 'absent' | 'replace';
  sub?: string;
  subs?: string[];
}

/** How the fake issuer misbehaves: not at all, discovery down, the report down, or the connection dead. */
type Failure = null | 'discovery-500' | 'report-500' | 'throw';

/** The fake issuer: answers places discovery (or 404s it) and records each report it is sent. */
function issuer(origin: string, opts: { index: boolean } = { index: true }) {
  const reports: Report[] = [];
  const stray: string[] = [];
  const state = { discoveries: 0, attempts: 0, failure: null as Failure };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${origin}/.well-known/substrat-places`) {
      state.discoveries++;
      if (state.failure === 'throw') throw new TypeError('connection refused');
      if (state.failure === 'discovery-500') return new Response('down', { status: 500 });
      return opts.index ? Response.json({ report_endpoint: `${origin}/api/places/report` }) : new Response('no', { status: 404 });
    }
    if (url === `${origin}/api/places/report`) {
      state.attempts++;
      if (state.failure === 'throw') throw new TypeError('connection refused');
      if (state.failure === 'report-500') return new Response('down', { status: 500 });
      reports.push(JSON.parse(String(init?.body)) as Report);
      return new Response(null, { status: 204 });
    }
    stray.push(url);
    return new Response('not found', { status: 404 });
  });
  return { reports, stray, state };
}

/** Wait for a report that is sent after the response (`waitUntil`), or for quiet. */
async function settle(count: () => number, atLeast: number): Promise<void> {
  for (let i = 0; i < 50 && count() < atLeast; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 50));
}

const platform = (path: string, body: unknown) =>
  SELF.fetch(`https://meridian.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-substrat-platform': env.PLATFORM_SECRET },
    body: JSON.stringify(body),
  });

interface Install {
  t: TenantId;
  s: ScopeId;
}

/** Provision an install and, when `issuerUrl` is given, deliver the identity choice for it. */
async function install(issuerUrl: string | null): Promise<Install> {
  const i = { t: tenantId.parse(ulid()), s: scopeId.parse(ulid()) };
  expect((await platform('/internal/provision', { tenantId: i.t, scopeId: i.s, owner, entitlements })).status).toBe(201);
  if (issuerUrl) {
    const value = JSON.stringify({ mode: 'oidc', issuer: issuerUrl, clientId: `client-${i.s}`, clientSecret: 'secret-1' });
    const res = await platform('/internal/configure', { tenantId: i.t, scopeId: i.s, entries: [{ key: 'substrat:auth', value }] });
    expect(res.status).toBe(200);
  }
  return i;
}

/** `/api/me` as a login holding a session this install's worker accepts, routed to `i`. */
async function me(i: Install, sub: string): Promise<Response> {
  const { sessionSecret } = await env.AUTH.get(env.AUTH.idFromName(i.t)).authWiring(i.s);
  const session = await mintSession(sessionSecret, { id: sub, email: `${sub}@acme.test`, name: sub });
  return SELF.fetch('https://meridian.test/api/me', {
    headers: {
      cookie: `${SESSION_COOKIE}=${session}`,
      'x-substrat-tenant': i.t,
      'x-substrat-scope': i.s,
      'x-substrat-router': env.ROUTER_SECRET,
    },
  });
}

beforeEach(() => resetPlacesMemo());
afterEach(() => vi.unstubAllGlobals());

describe('meridian reports a login\'s place to the identity pool (#1670)', () => {
  it('/api/me: the owner who claims the seat is reported present, in the routed scope, as themselves', async () => {
    const iss = issuer('https://pool-a.test');
    const a = await install('https://pool-a.test');
    expect((await me(a, 'sub-ann')).status).toBe(200);
    await settle(() => iss.reports.length, 1);
    expect(iss.reports).toEqual([
      { client_id: `client-${a.s}`, client_secret: 'secret-1', scope_id: a.s, op: 'present', sub: 'sub-ann' },
    ]);
    // A second page load in the same isolate is deduplicated.
    expect((await me(a, 'sub-ann')).status).toBe(200);
    await settle(() => iss.reports.length, 2);
    expect(iss.reports).toHaveLength(1);
  });

  it('/api/me: a login that is not bound here is reported absent — and only itself', async () => {
    const iss = issuer('https://pool-b.test');
    const a = await install('https://pool-b.test');
    expect((await me(a, 'sub-ann')).status).toBe(200); // claims the owner seat
    await settle(() => iss.reports.length, 1);
    expect((await me(a, 'sub-bob')).status).toBe(401);
    await settle(() => iss.reports.length, 2);
    expect(iss.reports.map((r) => [r.op, r.sub, r.scope_id])).toEqual([
      ['present', 'sub-ann', a.s],
      ['absent', 'sub-bob', a.s],
    ]);
  });

  it('reconcile repairs the pool with exactly the subjects bound in the scope', async () => {
    const iss = issuer('https://pool-c.test');
    const a = await install('https://pool-c.test');
    // Nobody is bound yet, so the repair of the scope is the empty set (and says so).
    expect((await platform('/internal/reconcile', { tenantId: a.t, scopeId: a.s, owner, entitlements })).status).toBe(200);
    expect(iss.reports).toEqual([
      { client_id: `client-${a.s}`, client_secret: 'secret-1', scope_id: a.s, op: 'replace', subs: [] },
    ]);
    expect((await me(a, 'sub-ann')).status).toBe(200);
    await settle(() => iss.reports.length, 2);
    iss.reports.length = 0;
    expect((await platform('/internal/reconcile', { tenantId: a.t, scopeId: a.s, owner, entitlements })).status).toBe(200);
    expect(iss.reports).toEqual([
      { client_id: `client-${a.s}`, client_secret: 'secret-1', scope_id: a.s, op: 'replace', subs: ['sub-ann'] },
    ]);
  });

  it('never reports another install\'s scope: two installs on one issuer each name only their own', async () => {
    const iss = issuer('https://pool-d.test');
    const a = await install('https://pool-d.test');
    const b = await install('https://pool-d.test');
    expect((await me(a, 'sub-ann')).status).toBe(200);
    expect((await me(b, 'sub-bob')).status).toBe(200);
    await settle(() => iss.reports.length, 2);
    // One `present` per install: the loop below must not be able to pass on nothing.
    expect(iss.reports.map((r) => r.op)).toEqual(['present', 'present']);
    for (const r of iss.reports) {
      const own = r.client_id === `client-${a.s}` ? a : b;
      expect(r.scope_id).toBe(own.s);
      if (r.op === 'present') expect(r.sub).toBe(own === a ? 'sub-ann' : 'sub-bob');
      if (r.op === 'replace') expect(r.subs).not.toContain(own === a ? 'sub-bob' : 'sub-ann');
    }
  });

  it('twin: an install with no delivered identity sends nothing — not from /api/me, not from a reconcile', async () => {
    const iss = issuer('https://pool-e.test');
    const a = await install(null);
    await me(a, 'sub-ann'); // whatever the worker answers without an identity, it tells no issuer
    expect((await platform('/internal/reconcile', { tenantId: a.t, scopeId: a.s, owner, entitlements })).status).toBe(200);
    await settle(() => iss.reports.length, 1);
    expect(iss.reports).toEqual([]);
    expect(iss.stray).toEqual([]);
    expect(iss.state.discoveries).toBe(0);
  });

  it('twin: an issuer that keeps no index is asked once, however many logins, and sent nothing', async () => {
    const iss = issuer('https://pool-f.test', { index: false });
    const a = await install('https://pool-f.test');
    expect((await me(a, 'sub-ann')).status).toBe(200);
    await settle(() => iss.state.discoveries, 1);
    expect(iss.state.discoveries).toBe(1);
    expect((await me(a, 'sub-bob')).status).toBe(401);
    await settle(() => iss.state.discoveries, 2);
    expect(iss.state.discoveries).toBe(1);
    expect(iss.reports).toEqual([]);
  });

  it.each(['discovery-500', 'report-500', 'throw'] as const)(
    'twin: an issuer that fails (%s) breaks neither /api/me nor reconcile, and the next call retries',
    async (failure) => {
      const origin = `https://pool-${failure}.test`;
      const iss = issuer(origin);
      const a = await install(origin);
      iss.state.failure = failure;
      expect((await me(a, 'sub-ann')).status).toBe(200);
      expect((await platform('/internal/reconcile', { tenantId: a.t, scopeId: a.s, owner, entitlements })).status).toBe(200);
      await settle(() => iss.state.discoveries, 2);
      expect(iss.state.discoveries).toBeGreaterThan(0); // it did try
      expect(iss.reports).toEqual([]);
      // A report that failed is told apart from one never attempted: with the report endpoint down
      // the present (from /api/me) and the repair (from reconcile) each tried and failed; with
      // discovery down, nothing got as far as a report.
      expect(iss.state.attempts).toBe(failure === 'report-500' ? 2 : 0);
      // The failure was not remembered as an answer: the issuer back, the next call reports.
      iss.state.failure = null;
      expect((await me(a, 'sub-ann')).status).toBe(200);
      await settle(() => iss.reports.length, 1);
      expect(iss.reports.map((r) => [r.op, r.sub, r.scope_id])).toEqual([['present', 'sub-ann', a.s]]);
      expect((await platform('/internal/reconcile', { tenantId: a.t, scopeId: a.s, owner, entitlements })).status).toBe(200);
      expect(iss.reports.at(-1)).toMatchObject({ op: 'replace', scope_id: a.s, subs: ['sub-ann'] });
      expect(iss.state.attempts).toBe((failure === 'report-500' ? 2 : 0) + 2); // the retries: present, then the repair
    },
  );
});
