import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env, type OutboundPolicy } from '../src/worker.js';

/**
 * The egress worker decides two things per subrequest — "is this destination ours, or the
 * outside world?" (#442) and "may this vertical call this third party?" (#303) — and the
 * wrong answers are quiet: send a platform host to the internet and it 522s; send an
 * external host to the router and it 404s; let an undeclared host through and the policy
 * is theater; refuse a declared one and a live integration dies. So the tests pin every
 * verdict on both sides.
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

describe('outbound policy (#303)', () => {
  const policy = (hosts: string[] | null): OutboundPolicy => ({
    slug: 'egeryds-crm',
    tenant: '01TENANT',
    hosts,
  });

  it('passes a declared host through to the internet', async () => {
    const internet = vi.fn(async () => new Response('external', { status: 200 }));
    vi.stubGlobal('fetch', internet);

    const res = await worker.fetch(
      new Request('https://api.scrive.com/api/v2/documents'),
      envWith({ OUTBOUND_POLICY: policy(['api.scrive.com']) }),
    );

    expect(res.status).toBe(200);
    expect(internet).toHaveBeenCalledTimes(1);
  });

  it('matches a *. wildcard at any depth, but never the apex', async () => {
    const internet = vi.fn(async () => new Response('external', { status: 200 }));
    vi.stubGlobal('fetch', internet);
    const env = envWith({ OUTBOUND_POLICY: policy(['*.googleapis.com']) });

    expect((await worker.fetch(new Request('https://oauth2.googleapis.com/token'), env)).status).toBe(200);
    expect((await worker.fetch(new Request('https://a.b.googleapis.com/x'), env)).status).toBe(200);
    expect((await worker.fetch(new Request('https://googleapis.com/'), env)).status).toBe(403);
    expect(internet).toHaveBeenCalledTimes(2);
  });

  it('refuses an undeclared host with a body that names it and says what to declare', async () => {
    const internet = vi.fn();
    vi.stubGlobal('fetch', internet);

    const res = await worker.fetch(
      new Request('https://exfil.example.com/steal'),
      envWith({ OUTBOUND_POLICY: policy(['api.scrive.com']) }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; host: string; detail: string };
    expect(body.error).toBe('outbound refused');
    expect(body.host).toBe('exfil.example.com');
    expect(body.detail).toContain('substrat.outbound');
    expect(internet).not.toHaveBeenCalled();
  });

  it('an empty declared surface refuses every third party (the new-CLI default)', async () => {
    const internet = vi.fn();
    vi.stubGlobal('fetch', internet);

    const res = await worker.fetch(
      new Request('https://api.example.com/'),
      envWith({ OUTBOUND_POLICY: policy([]) }),
    );

    expect(res.status).toBe(403);
    expect(internet).not.toHaveBeenCalled();
  });

  it('a lookalike suffix never rides a wildcard (evil-scrive.com ≠ *.scrive.com)', async () => {
    const internet = vi.fn();
    vi.stubGlobal('fetch', internet);

    const res = await worker.fetch(
      new Request('https://evil-scrive.com/'),
      envWith({ OUTBOUND_POLICY: policy(['*.scrive.com']) }),
    );

    expect(res.status).toBe(403);
    expect(internet).not.toHaveBeenCalled();
  });

  it('hosts: null (a pre-#303 version) passes through unenforced', async () => {
    const internet = vi.fn(async () => new Response('external', { status: 200 }));
    vi.stubGlobal('fetch', internet);

    const res = await worker.fetch(
      new Request('https://api.anything.com/'),
      envWith({ OUTBOUND_POLICY: policy(null) }),
    );

    expect(res.status).toBe(200);
    expect(internet).toHaveBeenCalledTimes(1);
  });

  it('no policy at all (an older dispatcher) passes through unenforced', async () => {
    const internet = vi.fn(async () => new Response('external', { status: 200 }));
    vi.stubGlobal('fetch', internet);

    const res = await worker.fetch(new Request('https://api.anything.com/'), envWith());

    expect(res.status).toBe(200);
    expect(internet).toHaveBeenCalledTimes(1);
  });

  it('policy never blocks the platform loopback — an undeclared platform host still routes', async () => {
    const r = router();
    const internet = vi.fn();
    vi.stubGlobal('fetch', internet);

    const res = await worker.fetch(
      new Request('https://other-vertical.global.substrat.run/api/x'),
      envWith({ ROUTER: r.fetcher, OUTBOUND_POLICY: policy([]) }),
    );

    expect(res.status).toBe(200);
    expect(r.calls).toHaveLength(1);
    expect(internet).not.toHaveBeenCalled();
  });

  it('meters every verdict: index = slug, blobs = [hostname, verdict, tenant]', async () => {
    const points: unknown[] = [];
    const analytics = { writeDataPoint: (p: unknown) => points.push(p) } as AnalyticsEngineDataset;
    const internet = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', internet);
    const env = envWith({ ANALYTICS: analytics, OUTBOUND_POLICY: policy(['api.scrive.com']) });

    await worker.fetch(new Request('https://api.scrive.com/x'), env);
    await worker.fetch(new Request('https://exfil.example.com/x'), env);
    await worker.fetch(new Request('https://a.global.substrat.run/x'), env);

    expect(points).toEqual([
      { indexes: ['egeryds-crm'], blobs: ['api.scrive.com', 'allowed', '01TENANT'] },
      { indexes: ['egeryds-crm'], blobs: ['exfil.example.com', 'refused', '01TENANT'] },
      { indexes: ['egeryds-crm'], blobs: ['a.global.substrat.run', 'platform', '01TENANT'] },
    ]);
  });

  it('a metering failure never fails the request', async () => {
    const analytics = {
      writeDataPoint: () => {
        throw new Error('AE down');
      },
    } as unknown as AnalyticsEngineDataset;
    const internet = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', internet);

    const res = await worker.fetch(
      new Request('https://api.scrive.com/x'),
      envWith({ ANALYTICS: analytics, OUTBOUND_POLICY: policy(['api.scrive.com']) }),
    );

    expect(res.status).toBe(200);
  });
});
