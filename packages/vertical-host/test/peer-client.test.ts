import { describe, expect, it, vi } from 'vitest';
import { errorCodeOf, PEER_CALL_URL } from '@substrat-run/contracts';
import { peerClient } from '../src/peer-client.js';

/**
 * The client a vertical author writes (#1706).
 *
 * Two things matter here, and they are both about what a builder sees. It addresses ONE
 * reserved place and names no caller — there is no parameter for one, because the platform
 * supplies it. And a refusal arrives as the platform's own sentence with a code, not as a
 * bare status: an undeclared target says what to declare, a preview says to use the local
 * broker, an ambiguous tenant says to bind the instance.
 */

const ok = (result: unknown) =>
  vi.fn(async () => new Response(JSON.stringify({ result }), { status: 200 }));

describe('peerClient (#1706)', () => {
  it('the default transport invokes runtime fetch with its global receiver', async () => {
    const runtime = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(Response.json({ result: 'ok' }));
    });
    vi.stubGlobal('fetch', runtime);
    try {
      await expect(peerClient('acme/crm').invoke('customer/list')).resolves.toBe('ok');
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['<html>old app</html>', '{}', '{"error":"wrong route"}'])('rejects invalid successful responses: %s', async (body) => {
    const client = peerClient('acme/crm', { fetch: async () => new Response(body) });
    await expect(client.invoke('customer/list')).rejects.toThrow(/invalid peer response/);
  });

  it('posts the target and operation to the one reserved address, naming no caller', async () => {
    const fetchImpl = ok({ items: [1, 2] });
    const client = peerClient('acme/crm', { fetch: fetchImpl as unknown as typeof fetch });

    await expect(client.invoke('customer/list', { limit: 50 })).resolves.toEqual({ items: [1, 2] });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(PEER_CALL_URL);
    expect(new URL(url).hostname).toBe('peer.substrat.internal');
    expect(JSON.parse(String(init.body))).toEqual({
      vertical: 'acme/crm',
      operation: 'customer/list',
      input: { limit: 50 },
    });
  });

  it('sends an idempotency key when given one, and omits both optionals otherwise', async () => {
    const fetchImpl = ok(null);
    const client = peerClient('acme/crm', { fetch: fetchImpl as unknown as typeof fetch });

    await client.invoke('customer/sync', undefined, { idempotencyKey: 'k-1' });
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({
      vertical: 'acme/crm',
      operation: 'customer/sync',
      idempotencyKey: 'k-1',
    });

    await client.invoke('customer/sync');
    expect(JSON.parse(String((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({
      vertical: 'acme/crm',
      operation: 'customer/sync',
    });
  });

  it('an operation that returns nothing answers null rather than throwing', async () => {
    const client = peerClient('acme/crm', { fetch: ok(null) as unknown as typeof fetch });
    await expect(client.invoke('customer/touch')).resolves.toBeNull();
  });

  it('a refusal keeps the platform’s sentence AND carries a code', async () => {
    const cases: [number, string, string][] = [
      [403, "'acme/board-room' does not declare 'acme/crm' in its outgoing calls.", 'forbidden'],
      [404, "vertical 'acme/crm' is not installed in this tenant", 'not_found'],
      [409, "this tenant runs 2 instances of 'acme/crm'", 'conflict'],
      [503, 'peer calls are not available in this environment (#1706)', 'unavailable'],
    ];
    for (const [status, error, code] of cases) {
      const client = peerClient('acme/crm', {
        fetch: (async () => new Response(JSON.stringify({ error }), { status })) as unknown as typeof fetch,
      });
      const refusal = await client.invoke('customer/list').catch((e: unknown) => e);
      expect(errorCodeOf(refusal)).toBe(code);
      expect(String((refusal as Error).message)).toBe(error);
    }
  });

  it('a refusal with no readable body still names the vertical and the status', async () => {
    const client = peerClient('acme/crm', {
      fetch: (async () => new Response('gateway is sad', { status: 502 })) as unknown as typeof fetch,
    });
    const refusal = await client.invoke('customer/list').catch((e: unknown) => e);
    expect(String((refusal as Error).message)).toMatch(/'acme\/crm' was refused \(502\)/);
  });
});
