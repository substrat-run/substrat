import { describe, expect, it } from 'vitest';
import { platformRequestId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { generateScopeStoreKeyPair } from '@substrat-run/contracts/scope-store-envelope';
import { decodeWireEnvelope, WIRE_ENVELOPE_HEADER, WIRE_SIGNATURE_HEADER } from '@substrat-run/contracts/wire-signing';
import { drainScopePlatformRequests, VerticalClient } from '@substrat-run/control-plane-api';
import { ulid } from '@substrat-run/kernel';
import { drainContextOf, drainTarget, resolveVerticalForScopeFor } from '../src/worker.js';

/**
 * RFC wire-signing step 2, the control plane's half: every call it makes to a deployment is made
 * by a client from one factory (`verticalClientAt`), which signs for the very script name it makes
 * the dispatch stub from. The drain is driven here through that factory as the drain-scope route
 * and the scheduled pass reach it (`resolveVerticalForScopeFor`, then `drainTarget`), with a
 * dispatch namespace that records each call.
 */

const T = tenantId.parse(ulid());
const S = scopeId.parse(ulid());
const INTENT = platformRequestId.parse(ulid());
const SERVING = 'acme-stable';
const SECRET = 'platform-legacy-value';

/** A dispatch namespace whose scripts answer the drain: one intent nobody handles, then its settle. */
function namespace() {
  const calls: { name: string; args: [RequestInfo | URL, RequestInit | undefined]; body: string }[] = [];
  const get = (name: string) => ({
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input instanceof Request ? input.clone() : input, init);
      calls.push({ name, args: [input, init], body: await request.clone().text() });
      if (request.method === 'GET') {
        return Response.json([
          {
            id: INTENT,
            kind: 'nobody-handles-this',
            payload: {},
            requestedBy: principalId.parse('01JZ0000000000000000000PR1'),
            status: 'pending',
            attempts: 0,
            lastError: null,
            result: null,
            requestedAt: '2026-10-23T00:00:00.000Z',
            settledAt: null,
          },
        ]);
      }
      return Response.json({ ok: true });
    },
  });
  return { get, calls };
}

const ctx = drainContextOf({ tenantId: T, id: S, verticalVersionId: null, kind: 'scope', forkedFrom: null, status: 'active' }, 'acme', { status: 'active' } as never);

/** The drain of one scope served by `SERVING`, through the control plane's own client factory. */
async function drainedThroughFactory(wire: Record<string, string | undefined>) {
  const d = namespace();
  const resolve = resolveVerticalForScopeFor({ PLATFORM_SECRET: SECRET, DISPATCH: d, ...wire } as never);
  const target = await drainTarget({ vertical: 'acme', verticalVersionId: null, servingRef: SERVING }, resolve);
  if (!('client' in target)) throw new Error('the factory gave no client');
  await drainScopePlatformRequests(target.client, ctx, {});
  return d.calls;
}

/** The same drain through a client built the way every factory built one before signing existed. */
async function drainedAsBefore() {
  const d = namespace();
  const fetcher = d.get(SERVING);
  await drainScopePlatformRequests(new VerticalClient({ fetch: fetcher.fetch.bind(fetcher) as typeof fetch, platformSecret: SECRET }), ctx, {});
  return d.calls;
}

describe('the control plane’s calls to a deployment, signed through one factory (RFC wire-signing step 2)', () => {
  it.each([
    ['no key and no flag', {}],
    ['a key with no flag', { WIRE_PLATFORM_KEY: 'unread' }],
    ['the flag off', { WIRE_SIGN: 'off', WIRE_PLATFORM_KEY: 'unread' }],
    ['the flag in another case', { WIRE_SIGN: 'ON', WIRE_PLATFORM_KEY: 'unread' }],
  ])('%s: the drain sends exactly what it sent before, argument for argument', async (_, wire) => {
    const before = await drainedAsBefore();
    const now = await drainedThroughFactory(wire);
    expect(before.map((c) => c.args[0])).toEqual([expect.stringContaining('/internal/platform-requests?'), expect.stringContaining('/internal/platform-requests/settle')]);
    expect(now).toEqual(before);
  });

  it('on: each call of the drain carries a call envelope for the script it reaches, naming the scope it names', async () => {
    const pair = await generateScopeStoreKeyPair();
    const calls = await drainedThroughFactory({ WIRE_SIGN: 'on', WIRE_PLATFORM_KEY: pair.privateKey });
    expect(calls).toHaveLength(2);
    for (const { name, args } of calls) {
      const request = args[0] as Request;
      expect(request).toBeInstanceOf(Request);
      expect(name).toBe(SERVING);
      const claims = decodeWireEnvelope(request.headers.get(WIRE_ENVELOPE_HEADER)!)!.claims;
      expect(claims).toMatchObject({ iss: 'platform', kind: 'call', aud: SERVING, tenantId: T, scopeId: S, vertical: null });
      expect(request.headers.get(WIRE_SIGNATURE_HEADER)).toBeTruthy();
      // The legacy credential stays beside it.
      expect(request.headers.get('x-substrat-platform')).toBe(SECRET);
    }
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ tenantId: T, scopeId: S, id: INTENT, status: 'failed' });
  });
});
