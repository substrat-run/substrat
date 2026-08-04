import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/worker.js';

/**
 * The egress worker decides one thing per subrequest — "is this destination ours, or the
 * outside world?" — and both wrong answers are quiet: send a platform host to the internet
 * and it 522s (the bug we are fixing); send an external host to the router and it 404s and
 * never reaches the third party. So the test pins the routing decision on both sides.
 */

/** A router service binding that records what it was handed and answers 200. */
function router() {
  const calls: Request[] = [];
  const fetcher = {
    fetch: async (request: Request) => {
      calls.push(request);
      return new Response('routed', { status: 200 });
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

const envWith = (over: Partial<Env> = {}): Env => ({
  ROUTER: router().fetcher,
  PLATFORM_BASE_DOMAINS: 'substrat.run',
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('vertical egress worker', () => {
  it('loops a platform host back through the router, never to the internet', async () => {
    const r = router();
    const internet = vi.fn();
    vi.stubGlobal('fetch', internet);

    const res = await worker.fetch(
      new Request('https://authhero-auth-core-authhero.global.substrat.run/.well-known/jwks.json'),
      envWith({ ROUTER: r.fetcher }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('routed');
    expect(r.calls).toHaveLength(1);
    expect(new URL(r.calls[0]!.url).hostname).toBe(
      'authhero-auth-core-authhero.global.substrat.run',
    );
    expect(internet).not.toHaveBeenCalled();
  });

  it('routes a two-level test host (…global.test.substrat.run) through the router too', async () => {
    const r = router();
    const internet = vi.fn();
    vi.stubGlobal('fetch', internet);

    await worker.fetch(
      new Request('https://x-y.global.test.substrat.run/.well-known/jwks.json'),
      envWith({ ROUTER: r.fetcher }),
    );

    expect(r.calls).toHaveLength(1);
    expect(internet).not.toHaveBeenCalled();
  });

  it('passes an external host straight through to the internet, never to the router', async () => {
    const r = router();
    const internet = vi.fn(async () => new Response('external', { status: 200 }));
    vi.stubGlobal('fetch', internet);

    const res = await worker.fetch(
      new Request('https://api.scrive.com/api/v2/documents'),
      envWith({ ROUTER: r.fetcher }),
    );

    expect(await res.text()).toBe('external');
    expect(internet).toHaveBeenCalledTimes(1);
    expect(r.calls).toHaveLength(0);
  });

  it('does NOT treat a lookalike suffix as platform (notsubstrat.run ≠ substrat.run)', async () => {
    const r = router();
    const internet = vi.fn(async () => new Response('external', { status: 200 }));
    vi.stubGlobal('fetch', internet);

    await worker.fetch(new Request('https://evil-notsubstrat.run/steal'), envWith({ ROUTER: r.fetcher }));

    expect(internet).toHaveBeenCalledTimes(1);
    expect(r.calls).toHaveLength(0);
  });

  it('with no base domains configured, treats everything as external (never misroutes)', async () => {
    const r = router();
    const internet = vi.fn(async () => new Response('external', { status: 200 }));
    vi.stubGlobal('fetch', internet);

    await worker.fetch(
      new Request('https://x.global.substrat.run/'),
      envWith({ ROUTER: r.fetcher, PLATFORM_BASE_DOMAINS: undefined }),
    );

    expect(internet).toHaveBeenCalledTimes(1);
    expect(r.calls).toHaveLength(0);
  });
});
