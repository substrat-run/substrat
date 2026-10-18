/**
 * Delegated calls at the MCP endpoint (#1824): another app acting for a user, within a
 * scope of this vertical's permission keys.
 *
 * The scope is a CEILING held before the operation runs, and the operation's own check is
 * the floor beside it, so a call succeeds only when the tool's leading key is delegated AND
 * the user holds it. Each rule has a refused case and an admitted twin, and the two
 * fail-closed paths — a host that admits a delegated token without handing the delegation
 * over, and a verifier too old to know `act` — are driven both with a fake resolver and
 * through the real bearer verifier from `@substrat-run/vertical-auth`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z, mcpResourceOf } from '@substrat-run/contracts';
import { PermissionDenied } from '@substrat-run/kernel';
import { oidcAuthProvider } from '@substrat-run/vertical-auth/oidc';
import type { AuthProvider } from '@substrat-run/vertical-auth/provider';
import { INVOCATION_RECORD_KEY, type InvocationRecord } from '../src/invocation-log.js';
import { mountOperations } from '../src/operations-routes.js';
import { MCP_DELEGATION_KEY, mcpToolsOf, setMcpDelegation, type McpDelegation } from '../src/mcp.js';

const ISSUER = 'https://team-auth.test';
const A = 'https://desk-a.example';
const RESOURCE = mcpResourceOf(A);
const ACTOR = 'helpdesk';

const operations = {
  'desk/list-tickets': { summary: 'Tickets', permission: 'tickets:read', http: { method: 'GET', path: '/tickets' } },
  'desk/get-ticket': {
    summary: 'One ticket',
    permission: { key: 'tickets:read', entity: 'ticket', idFrom: 'ticketId' },
    input: z.object({ ticketId: z.string() }),
    http: { method: 'GET', path: '/tickets/{ticketId}' },
  },
  'desk/close-ticket': {
    summary: 'Close a ticket',
    permission: 'tickets:write',
    input: z.object({ ticketId: z.string() }),
    http: { method: 'POST', path: '/tickets/{ticketId}/close' },
  },
  'desk/refund': { summary: 'Refund an order', permission: 'orders:refund', http: { method: 'POST', path: '/refunds' } },
  'desk/my-orders': {
    summary: 'Orders you placed',
    narrows: { reason: 'a customer sees their own orders', checks: ['orders:read'] },
    http: { method: 'GET', path: '/orders' },
  },
} as const;

/** The leading key each operation checks first — what the fake stub's `ctx.check` asks. */
const KEY_OF: Record<string, string> = {
  'desk/list-tickets': 'tickets:read',
  'desk/get-ticket': 'tickets:read',
  'desk/close-ticket': 'tickets:write',
  'desk/refund': 'orders:refund',
  'desk/my-orders': 'orders:read',
};

const b64url = (value: unknown) =>
  btoa(typeof value === 'string' ? value : JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlBytes = (bytes: Uint8Array) => b64url(String.fromCharCode(...bytes));

/** A JWS-shaped token for the fake resolvers: the signature is junk, and nothing reads it. */
const unsigned = (claims: Record<string, unknown>) =>
  `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ iss: ISSUER, sub: 'user-1', ...claims })}.c2ln`;

/** The stage-B claims (`demos/auth-server/src/token-exchange.ts`) for desk A's endpoint. */
const delegatedClaims = (scope: string): Record<string, unknown> => ({
  aud: RESOURCE,
  azp: ACTOR,
  client_id: ACTOR,
  scope,
  act: { iss: ISSUER, sub: ACTOR },
});

/**
 * A mounted desk. `resolve` is the vertical's own `resolveStub` half: it gets the context
 * and decides what to hand over. The stub plays the operation's leading `ctx.check` against
 * `holds`, the keys the user actually has, and counts what reached it.
 */
function desk(opts: { resolve?: (c: Context) => void | Promise<void>; holds?: readonly string[]; record?: InvocationRecord } = {}) {
  const invoked: string[] = [];
  const holds = new Set(opts.holds ?? Object.values(KEY_OF));
  const app = new Hono();
  if (opts.record) {
    const record = opts.record;
    app.use('*', async (c, next) => {
      (c as unknown as { set: (k: string, v: unknown) => void }).set(INVOCATION_RECORD_KEY, record);
      await next();
    });
  }
  mountOperations(app, operations, async (c) => {
    await opts.resolve?.(c);
    return {
      invoke: async (name: string) => {
        invoked.push(name);
        const key = KEY_OF[name]!;
        if (!holds.has(key)) throw new PermissionDenied(`permission denied: ${key}`);
        return { ok: name };
      },
    } as never;
  });
  return { app, invoked };
}

/** The tools whose input is a `ticketId`. */
const TAKES_TICKET = new Set(['desk_get-ticket', 'desk_close-ticket']);

/** One `tools/call` (or several, as a batch) at desk A's endpoint. */
async function callTools(app: Hono, names: string | string[], authorization?: string) {
  const list = Array.isArray(names) ? names : [names];
  const messages = list.map((name, i) => ({
    jsonrpc: '2.0',
    id: i + 1,
    method: 'tools/call',
    params: { name, arguments: TAKES_TICKET.has(name) ? { ticketId: 't1' } : {} },
  }));
  const res = await app.request(`${A}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(Array.isArray(names) ? messages : messages[0]),
  });
  const body = res.status === 200 ? ((await res.json()) as any) : null;
  const replies: any[] = body === null ? [] : Array.isArray(body) ? body : [body];
  return {
    status: res.status,
    errors: replies.map((r) => (r.result?.isError ? (r.result.content[0].text as string) : null)),
  };
}

const handOver = (delegation: McpDelegation) => (c: Context) => setMcpDelegation(c, delegation);

describe('each tool is held to the leading key it declares', () => {
  it('reads a scope key, an entity-narrowed key, and nothing for a per-row walk', () => {
    const byOp = new Map(mcpToolsOf(operations).map((t) => [t.operation, t.permission]));
    expect(byOp.get('desk/list-tickets')).toBe('tickets:read');
    expect(byOp.get('desk/get-ticket')).toBe('tickets:read');
    expect(byOp.get('desk/my-orders')).toBeUndefined();
  });
});

describe('a delegated call is held to the delegated scope before the operation runs', () => {
  const bearer = `Bearer ${unsigned(delegatedClaims('tickets:read'))}`;
  const delegation = { actor: ACTOR, scope: ['tickets:read'] };

  it('runs a tool whose key is delegated — a scope key and an entity-narrowed one', async () => {
    const { app, invoked } = desk({ resolve: handOver(delegation) });
    expect((await callTools(app, ['desk_list-tickets', 'desk_get-ticket'], bearer)).errors).toEqual([null, null]);
    expect(invoked).toEqual(['desk/list-tickets', 'desk/get-ticket']);
  });

  it('refuses a tool whose key is not delegated, in-band, without invoking it', async () => {
    const { app, invoked } = desk({ resolve: handOver(delegation) });
    const { status, errors } = await callTools(app, 'desk_close-ticket', bearer);
    expect(status).toBe(200);
    expect(errors[0]).toMatch(/needs tickets:write, which is outside the delegated scope/);
    expect(invoked).toEqual([]);
    // Twin: the user acting directly reaches it.
    const direct = desk();
    expect((await callTools(direct.app, 'desk_close-ticket')).errors).toEqual([null]);
  });

  it('refuses a per-row walk, which no single key describes — and runs it for the user directly', async () => {
    const { app, invoked } = desk({ resolve: handOver({ actor: ACTOR, scope: ['tickets:read', 'orders:read'] }) });
    expect((await callTools(app, 'desk_my-orders', bearer)).errors[0]).toMatch(/declares no single permission/);
    expect(invoked).toEqual([]);
    const direct = desk();
    expect((await callTools(direct.app, 'desk_my-orders')).errors).toEqual([null]);
  });

  it('is a ceiling, not a grant: a delegated key the user does not hold is still refused by the operation', async () => {
    const wide = { actor: ACTOR, scope: ['tickets:read', 'orders:refund'] };
    const { app, invoked } = desk({ resolve: handOver(wide), holds: ['tickets:read'] });
    expect((await callTools(app, 'desk_refund', bearer)).errors[0]).toMatch(/permission denied: orders:refund/);
    // It reached the operation, whose own check is the one that said no.
    expect(invoked).toEqual(['desk/refund']);
    // Twin: the user who holds it gets the call through.
    const holder = desk({ resolve: handOver(wide), holds: ['tickets:read', 'orders:refund'] });
    expect((await callTools(holder.app, 'desk_refund', bearer)).errors).toEqual([null]);
  });

  it('judges every call of a batch on its own', async () => {
    const { app, invoked } = desk({ resolve: handOver(delegation) });
    const { errors } = await callTools(app, ['desk_close-ticket', 'desk_list-tickets', 'desk_refund'], bearer);
    expect(errors.map((e) => e !== null)).toEqual([true, false, true]);
    expect(invoked).toEqual(['desk/list-tickets']);
  });

  it('reaches nothing with an empty scope, or one handed over malformed', async () => {
    const empty = desk({ resolve: handOver({ actor: ACTOR, scope: [] }) });
    expect((await callTools(empty.app, 'desk_list-tickets', bearer)).errors[0]).toMatch(/outside the delegated scope/);
    const garbled = desk({
      resolve: (c) => (c as unknown as { set: (k: string, v: unknown) => void }).set(MCP_DELEGATION_KEY, { scope: 'tickets:read' }),
    });
    expect((await callTools(garbled.app, 'desk_list-tickets', bearer)).errors[0]).toMatch(/outside the delegated scope/);
    expect(empty.invoked).toEqual([]);
    expect(garbled.invoked).toEqual([]);
  });

  it('records the refusal as the denial it is', async () => {
    const record: InvocationRecord = {};
    const { app } = desk({ resolve: handOver(delegation), record });
    await callTools(app, 'desk_close-ticket', bearer);
    expect(record).toMatchObject({ operation: 'desk/close-ticket', problemCode: 'permission_denied' });
  });

  it('leaves the handshake and the tool list alone', async () => {
    const { app } = desk({ resolve: handOver(delegation) });
    const res = await app.request(`${A}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bearer },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(((await res.json()) as any).result.tools).toHaveLength(5);
  });
});

describe('a delegated bearer with no delegation handed over fails closed', () => {
  const bearer = `Bearer ${unsigned(delegatedClaims('tickets:read tickets:write'))}`;

  it('refuses every call when the host admits the token and forgets the hand-off', async () => {
    const { app, invoked } = desk();
    const { errors } = await callTools(app, ['desk_list-tickets', 'desk_close-ticket'], bearer);
    expect(errors.every((e) => /delegated calls are not accepted/.test(e ?? ''))).toBe(true);
    expect(invoked).toEqual([]);
  });

  it('refuses every call when a cookie session answered and a delegated bearer rode along', async () => {
    // The resolver took the cookie: a user, with nothing to hand over. The bearer still says `act`.
    const { app, invoked } = desk({ resolve: () => undefined });
    expect((await callTools(app, 'desk_list-tickets', bearer)).errors[0]).toMatch(/not accepted/);
    expect(invoked).toEqual([]);
  });

  it('applies no ceiling to a bearer without act, or one it cannot read — the twins', async () => {
    const { app, invoked } = desk();
    expect((await callTools(app, 'desk_close-ticket', `Bearer ${unsigned({ aud: RESOURCE, azp: 'mcp-client' })}`)).errors).toEqual([null]);
    expect((await callTools(app, 'desk_close-ticket')).errors).toEqual([null]);
    expect(invoked).toEqual(['desk/close-ticket', 'desk/close-ticket']);
  });
});

/**
 * The same paths through the REAL verifier. A token signed with Web Crypto (ES256), checked
 * by `oidcAuthProvider` with that key injected — the provider a vertical gets from
 * `selectAuthProvider` on a team issuer, built here directly.
 */
describe('end to end through the bearer verifier', () => {
  let privateKey: CryptoKey;
  let publicKey: CryptoKey;

  beforeAll(async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
  });

  async function signed(claims: Record<string, unknown>): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const input = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ iss: ISSUER, sub: 'user-1', iat: now, exp: now + 300, ...claims })}`;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(input));
    return `${input}.${b64urlBytes(new Uint8Array(sig))}`;
  }

  const provider = (delegation?: { actors: string[] }): AuthProvider =>
    oidcAuthProvider({
      issuer: ISSUER,
      clientId: 'desk-a',
      resourceOf: (origin) => mcpResourceOf(origin),
      keys: async () => publicKey,
      ...(delegation ? { delegation } : {}),
    });

  /**
   * A vertical's `resolveStub` on the upgraded pattern: resolve WITH the request URL, 401
   * nobody, hand the delegation over. `handOff: false` is the same host forgetting the last.
   */
  function upgradedDesk(auth: AuthProvider, handOff = true) {
    return desk({
      resolve: async (c) => {
        const subject = await auth.resolve(c.req.raw.headers, c.req.url);
        if (!subject) throw new HTTPException(401, { message: 'unauthorized' });
        if (handOff) setMcpDelegation(c, subject.delegation);
      },
    });
  }

  it('an opted-in, wired host: the delegated scope holds, and the user is who acts', async () => {
    const t = `Bearer ${await signed(delegatedClaims('tickets:read'))}`;
    const { app, invoked } = upgradedDesk(provider({ actors: [ACTOR] }));
    const { errors } = await callTools(app, ['desk_list-tickets', 'desk_close-ticket'], t);
    expect(errors[0]).toBeNull();
    expect(errors[1]).toMatch(/outside the delegated scope/);
    expect(invoked).toEqual(['desk/list-tickets']);
  });

  it('an opted-in host that forgets the hand-off has every delegated call refused', async () => {
    const t = `Bearer ${await signed(delegatedClaims('tickets:read'))}`;
    const { app, invoked } = upgradedDesk(provider({ actors: [ACTOR] }), false);
    expect((await callTools(app, 'desk_list-tickets', t)).errors[0]).toMatch(/not accepted/);
    expect(invoked).toEqual([]);
  });

  it('a host that has not opted in answers a delegated token with a 401: nobody', async () => {
    const t = `Bearer ${await signed(delegatedClaims('tickets:read'))}`;
    const { app, invoked } = upgradedDesk(provider());
    expect((await callTools(app, 'desk_list-tickets', t)).status).toBe(401);
    expect(invoked).toEqual([]);
  });

  it('a verifier too old to know act, taking the token as the user, is caught by the mount', async () => {
    // What every vertical-auth before #1824 did with this token: rule 1 admits it, and the
    // subject carries no delegation — so there is nothing to hand over.
    const old = desk({ resolve: () => undefined });
    const t = `Bearer ${await signed(delegatedClaims('tickets:read'))}`;
    expect((await callTools(old.app, 'desk_list-tickets', t)).errors[0]).toMatch(/not accepted/);
    expect(old.invoked).toEqual([]);
  });

  it('an opted-in host refuses the delegated token on a REST route, and serves an ordinary one there', async () => {
    const { app, invoked } = upgradedDesk(provider({ actors: [ACTOR] }));
    const rest = (authorization: string) => app.request(`${A}/api/tickets`, { headers: { authorization } });
    expect((await rest(`Bearer ${await signed(delegatedClaims('tickets:read'))}`)).status).toBe(401);
    expect(invoked).toEqual([]);
    expect((await rest(`Bearer ${await signed({ aud: 'desk-a' })}`)).status).toBe(200);
    expect(invoked).toEqual(['desk/list-tickets']);
  });

  it("an ordinary user's MCP token is unchanged: no ceiling, every tool the user holds", async () => {
    const { app, invoked } = upgradedDesk(provider({ actors: [ACTOR] }));
    const t = `Bearer ${await signed({ aud: [RESOURCE, `${ISSUER}/oauth2/userinfo`], azp: 'mcp-client' })}`;
    expect((await callTools(app, ['desk_close-ticket', 'desk_my-orders'], t)).errors).toEqual([null, null]);
    expect(invoked).toEqual(['desk/close-ticket', 'desk/my-orders']);
  });
});
