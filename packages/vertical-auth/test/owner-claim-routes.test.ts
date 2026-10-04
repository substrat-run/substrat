import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { capabilityId, principalId, scopeId, tenantId, type CapabilityExchange } from '@substrat-run/contracts';
import { mountOwnerClaim, type OwnerClaimDirectory, type OwnerClaimRouteDeps } from '../src/owner-claim-routes.js';
import { sha256Hex } from '../src/owner-claim-link.js';

/**
 * The redemption route's own branches (#1686), over stand-ins that record what they were asked.
 * The producers — the scope's exchange and the identity DO — are held on workerd by
 * `packages/adapter-cloudflare/test/owner-claim.test.ts`; this holds the ORDER the route asks them
 * in, and which branch a token takes.
 */

const NODE = { tenantId: tenantId.parse('01J00000000000000000000TEN'), scopeId: scopeId.parse('01J00000000000000000000SCP') };
const OWNER = principalId.parse('01J00000000000000000000WNR');
const CAP = capabilityId.parse('01J00000000000000000000CAP');
const SECRET = 'sbcap_secret';
const LEGACY = 'a'.repeat(64);

function harness(opts: { matches?: boolean; exchange?: CapabilityExchange | null; onClaimed?: OwnerClaimRouteDeps<object, typeof NODE>['onClaimed']; noun?: string } = {}) {
  const calls: string[] = [];
  const directory: OwnerClaimDirectory = {
    ownerClaimMatches: async (_s, hash) => {
      calls.push(`matches:${hash === (await sha256Hex(SECRET)) ? 'secret' : 'other'}`);
      return opts.matches ?? true;
    },
    claimOwnerByCapability: async (_s, sub, id, principal) => {
      calls.push(`bind:${sub}:${id}:${principal}`);
      return principal;
    },
    claimOwner: async (_s, sub, hash) => {
      calls.push(`legacy:${sub}:${hash === (await sha256Hex(LEGACY)) ? 'legacy' : 'other'}`);
      return OWNER;
    },
  };
  const app = new Hono<{ Bindings: object }>();
  mountOwnerClaim(app, {
    nodeFor: () => NODE,
    authProvider: async () => ({
      handle: async () => new Response(null),
      resolve: async (h) => (h.get('x-sub') ? { sub: h.get('x-sub')!, email: null, name: null } : null),
    }),
    directory: () => directory,
    host: () => ({
      exchangeCapability: async (_t, _s, secret, options) => {
        calls.push(`exchange:${secret}:${options?.mode}`);
        return opts.exchange === undefined ? { kind: 'principal', capabilityId: CAP, principal: OWNER } : opts.exchange;
      },
    }),
    ...(opts.noun ? { noun: opts.noun } : {}),
    ...(opts.onClaimed ? { onClaimed: opts.onClaimed } : {}),
  });
  app.onError((err, c) => (err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({ error: String(err) }, 500)));
  const post = (body: string, sub: string | null = 'sub-1') =>
    app.request('/api/claim-owner', { method: 'POST', headers: { 'content-type': 'application/json', ...(sub ? { 'x-sub': sub } : {}) }, body });
  return { calls, post };
}

describe('mountOwnerClaim (#1686)', () => {
  it('matches, then exchanges as become, then binds — and answers the principal', async () => {
    const { calls, post } = harness();
    const res = await post(JSON.stringify({ token: SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, principal: OWNER });
    expect(calls).toEqual(['matches:secret', `exchange:${SECRET}:become`, `bind:sub-1:${CAP}:${OWNER}`]);
  });

  it('signed out: 401 naming the noun, before the directory or the scope is asked', async () => {
    const { calls, post } = harness({ noun: 'desk' });
    const res = await post(JSON.stringify({ token: SECRET }), null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'sign in before claiming this desk' });
    expect(calls).toEqual([]);
    const plain = harness();
    expect(await (await plain.post(JSON.stringify({ token: SECRET }), null)).json()).toEqual({ error: 'sign in before claiming this workspace' });
  });

  it('a secret that is not the current link is refused without an exchange', async () => {
    const { calls, post } = harness({ matches: false });
    const res = await post(JSON.stringify({ token: SECRET }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'this claim link is invalid, expired, or already used' });
    expect(calls).toEqual(['matches:secret']);
  });

  it('a refused exchange binds nobody, with the same refusal', async () => {
    const { calls, post } = harness({ exchange: null });
    const res = await post(JSON.stringify({ token: SECRET }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'this claim link is invalid, expired, or already used' });
    expect(calls).toEqual(['matches:secret', `exchange:${SECRET}:become`]);
  });

  it('a token that is not a capability secret takes the LEGACY path, and never reaches the scope', async () => {
    const { calls, post } = harness();
    const res = await post(JSON.stringify({ token: LEGACY }));
    expect(res.status).toBe(200);
    expect(calls).toEqual(['legacy:sub-1:legacy']);
  });

  it('a body that is not JSON, or has no token, is a 400 — not an unshaped throw', async () => {
    const { calls, post } = harness();
    expect((await post('not json')).status).toBe(400);
    expect((await post(JSON.stringify({ nope: 1 }))).status).toBe(400);
    expect((await post(JSON.stringify({ token: '' }))).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('runs onClaimed with the seated owner, only on success', async () => {
    const seen: unknown[] = [];
    const ok = harness({ onClaimed: async (_c, claimed) => void seen.push(claimed) });
    expect((await ok.post(JSON.stringify({ token: SECRET }))).status).toBe(200);
    expect(seen).toEqual([{ node: NODE, principal: OWNER, subject: { sub: 'sub-1', email: null, name: null } }]);
    const refused = harness({ matches: false, onClaimed: async (_c, claimed) => void seen.push(claimed) });
    expect((await refused.post(JSON.stringify({ token: SECRET }))).status).toBe(400);
    expect(seen).toHaveLength(1);
  });
});
