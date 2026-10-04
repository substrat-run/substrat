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
  PLATFORM_CP_URL: 'https://console.substrat.net',
  ...over,
});

/** An Analytics Engine binding that collects every datapoint into `points`. */
const meterInto = (points: unknown[]) =>
  ({ writeDataPoint: (p: unknown) => void points.push(p) }) as unknown as AnalyticsEngineDataset;

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
    slug: 'acme-crm',
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

  it('never refuses the platform relay, whatever the vertical declared (#981)', async () => {
    const r = router();
    const internet = vi.fn(async () => new Response('relayed', { status: 200 }));
    vi.stubGlobal('fetch', internet);

    // `outbound: []` is what the current CLI pushes by default, so this IS the live case.
    const res = await worker.fetch(
      new Request('https://console.substrat.net/internal/email/send', { method: 'POST' }),
      envWith({ ROUTER: r.fetcher, OUTBOUND_POLICY: policy([]) }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('relayed');
    // Straight out, NOT through the router: the relay is a custom domain on the control
    // plane, and the router resolves tenant hostnames — it would 404 for this one.
    expect(internet).toHaveBeenCalledTimes(1);
    expect(r.calls).toHaveLength(0);
  });

  it('exempts the relay HOST only — a third party is still refused, and a lookalike is not the relay', async () => {
    const internet = vi.fn();
    vi.stubGlobal('fetch', internet);
    const env = envWith({ OUTBOUND_POLICY: policy([]) });

    expect((await worker.fetch(new Request('https://exfil.example.com/x'), env)).status).toBe(403);
    // `console.substrat.net.evil.com` ends with the relay host as a STRING but is not it.
    expect(
      (await worker.fetch(new Request('https://console.substrat.net.evil.com/x'), env)).status,
    ).toBe(403);
    expect(internet).not.toHaveBeenCalled();
  });

  it('with no PLATFORM_CP_URL there is no exemption — a missing var never widens a policy', async () => {
    const internet = vi.fn();
    vi.stubGlobal('fetch', internet);

    const res = await worker.fetch(
      new Request('https://console.substrat.net/internal/email/send', { method: 'POST' }),
      envWith({ PLATFORM_CP_URL: undefined, OUTBOUND_POLICY: policy([]) }),
    );

    expect(res.status).toBe(403);
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
    await worker.fetch(new Request('https://console.substrat.net/internal/email/send'), env);

    expect(points).toEqual([
      { indexes: ['acme-crm'], blobs: ['api.scrive.com', 'allowed', '01TENANT'] },
      { indexes: ['acme-crm'], blobs: ['exfil.example.com', 'refused', '01TENANT'] },
      { indexes: ['acme-crm'], blobs: ['a.global.substrat.run', 'platform', '01TENANT'] },
      // `relay` is its own verdict, not folded into `platform` (which means the router
      // loopback) or `allowed` (which means the vertical declared it).
      { indexes: ['acme-crm'], blobs: ['console.substrat.net', 'relay', '01TENANT'] },
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

/**
 * #2005: a fork, a snapshot or a preview causes no outbound effects. The router says which a
 * dispatch is (`primary`, from the directory read), and this worker holds a non-primary scope
 * to no third party at all — while the platform's own loopback and relay still answer, since
 * neither is the outside world.
 */
describe('a non-primary scope reaches no third party (#2005)', () => {
  const policy = (primary: boolean | undefined, hosts: string[] | null = ['api.scrive.com']): OutboundPolicy => ({
    slug: 'acme-crm',
    tenant: '01TENANT',
    hosts,
    ...(primary === undefined ? {} : { primary }),
  });

  for (const [name, hosts] of [
    ['a host its version declares', ['api.scrive.com']],
    ['an unenforced pre-#303 manifest', null],
  ] as const) {
    it(`refuses ${name}, and meters it as inert`, async () => {
      const internet = vi.fn(async () => new Response('external', { status: 200 }));
      vi.stubGlobal('fetch', internet);
      const points: unknown[] = [];
      const res = await worker.fetch(
        new Request('https://api.scrive.com/api/v2/documents'),
        envWith({ ANALYTICS: meterInto(points), OUTBOUND_POLICY: policy(false, hosts as string[] | null) }),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'outbound refused', host: 'api.scrive.com' });
      expect(internet).not.toHaveBeenCalled();
      expect(points).toEqual([{ indexes: ['acme-crm'], blobs: ['api.scrive.com', 'inert', '01TENANT'] }]);
    });
  }

  it('twin: the same subrequest from a primary scope leaves', async () => {
    const internet = vi.fn(async () => new Response('external', { status: 200 }));
    vi.stubGlobal('fetch', internet);
    const res = await worker.fetch(new Request('https://api.scrive.com/x'), envWith({ OUTBOUND_POLICY: policy(true) }));
    expect(res.status).toBe(200);
    expect(internet).toHaveBeenCalledTimes(1);
  });

  it('a router that predates the field passes as before — the skew window fails open', async () => {
    const internet = vi.fn(async () => new Response('external', { status: 200 }));
    vi.stubGlobal('fetch', internet);
    const res = await worker.fetch(new Request('https://api.scrive.com/x'), envWith({ OUTBOUND_POLICY: policy(undefined) }));
    expect(res.status).toBe(200);
  });

  it('the platform loopback and the relay still answer a non-primary scope', async () => {
    const r = router();
    const internet = vi.fn(async () => new Response('relayed', { status: 200 }));
    vi.stubGlobal('fetch', internet);
    const env = envWith({ ROUTER: r.fetcher, OUTBOUND_POLICY: policy(false) });
    expect((await worker.fetch(new Request('https://a.global.substrat.run/x'), env)).status).toBe(200);
    expect(r.calls).toHaveLength(1);
    expect((await worker.fetch(new Request('https://console.substrat.net/internal/x'), env)).status).toBe(200);
    expect(internet).toHaveBeenCalledTimes(1);
  });
});

/**
 * #2005, the loopback half: another app on the platform is real, so a fork or a preview may READ
 * from it and may not WRITE to it. Its own address is its own, and takes any method.
 */
describe("a non-primary scope reads other platform apps and writes only its own (#2005)", () => {
  const OWN = 'shop-acme--pr-7.global.substrat.run';
  const policy = (primary: boolean): OutboundPolicy => ({
    slug: 'acme-shop',
    tenant: '01TENANT',
    hosts: [],
    primary,
    hostname: OWN,
  });
  const send = (url: string, method: string, primary: boolean, r = router()) =>
    worker
      .fetch(new Request(url, { method, ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }) }), envWith({ ROUTER: r.fetcher, OUTBOUND_POLICY: policy(primary) }))
      .then((res) => ({ res, calls: r.calls }));

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    it(`refuses a ${method} to another platform app, before the router sees it`, async () => {
      const { res, calls } = await send('https://crm-acme.global.substrat.run/api/write', method, false);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'outbound refused', host: 'crm-acme.global.substrat.run' });
      expect(calls).toHaveLength(0);
    });
  }

  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    it(`lets a ${method} to another platform app through`, async () => {
      const { res, calls } = await send('https://crm-acme.global.substrat.run/api/read', method, false);
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
    });
  }

  it('lets a POST to its own address through — its own address is its own', async () => {
    const { res, calls } = await send(`https://${OWN.toUpperCase()}/api/write`, 'POST', false);
    expect(res.status).toBe(200);
    expect(calls[0]!.method).toBe('POST');
  });

  it('twin: a primary scope POSTs to another platform app', async () => {
    const { res, calls } = await send('https://crm-acme.global.substrat.run/api/write', 'POST', true);
    expect(res.status).toBe(200);
    expect(calls[0]!.method).toBe('POST');
  });

  // "Its own" is the SCOPE: a web surface POSTing to its own API surface is one app.
  describe('every surface of the same scope is its own', () => {
    const SIBLING = 'shop-acme--pr-7-api.global.substrat.run';
    const withSiblings = (hostnames: string[] | undefined): OutboundPolicy => ({
      ...policy(false),
      ...(hostnames ? { hostnames } : {}),
    });
    const post = (url: string, p: OutboundPolicy, r = router()) =>
      worker
        .fetch(new Request(url, { method: 'POST', body: '{}' }), envWith({ ROUTER: r.fetcher, OUTBOUND_POLICY: p }))
        .then((res) => ({ res, calls: r.calls }));

    it("lets a POST to a sibling surface of the scope through", async () => {
      const { res, calls } = await post(`https://${SIBLING}/api/orders`, withSiblings([OWN, SIBLING]));
      expect(res.status).toBe(200);
      expect(calls[0]!.method).toBe('POST');
    });

    it("still refuses a POST to another scope's host beside them", async () => {
      const { res, calls } = await post('https://crm-acme.global.substrat.run/api/write', withSiblings([OWN, SIBLING]));
      expect(res.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    // A custom domain of the scope is outside the platform's base domains — and still its own.
    it("lets a POST to the scope's own custom domain through, under the version's declared surface", async () => {
      const internet = vi.fn(async () => new Response('own', { status: 200 }));
      vi.stubGlobal('fetch', internet);
      const own = { ...withSiblings([OWN, 'preview.example.com']), hosts: ['preview.example.com'] };
      const { res } = await post('https://preview.example.com/api/write', own);
      expect(res.status).toBe(200);
      expect(internet).toHaveBeenCalledTimes(1);
    });

    it("twin: a custom domain that is NOT the scope's is refused as inert, declared or not", async () => {
      const internet = vi.fn(async () => new Response('x', { status: 200 }));
      vi.stubGlobal('fetch', internet);
      const own = { ...withSiblings([OWN, 'preview.example.com']), hosts: ['other.example.com'] };
      const { res } = await post('https://other.example.com/api/write', own);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'outbound refused', host: 'other.example.com' });
      expect(internet).not.toHaveBeenCalled();
    });

    it('a router that sends no set (the skew window) counts only the requested hostname', async () => {
      const { res } = await post(`https://${SIBLING}/api/orders`, withSiblings(undefined));
      expect(res.status).toBe(403);
    });
  });
});

/**
 * #2011 (and #2005 before it, for copies only): a redirect this worker FOLLOWED would be its own
 * subrequest, which nothing polices. So every request it lets out leaves with `redirect: 'manual'`
 * — install or copy, on every path: the platform loopback, the relay, a declared host, an
 * unenforced version, a copy's own custom domain. The 3xx goes back to the vertical, whose own
 * `fetch` follows it through this worker again (proved on workerd in `redirect.workerd.test.ts`).
 */
describe('no allowed request is redirected past the policy (#2011, #2005)', () => {
  const OWN = 'shop-acme--pr-7.global.substrat.run';
  const policy = (primary: boolean, hosts: string[] | null = ['preview.example.com', 'api.scrive.com']): OutboundPolicy => ({
    slug: 'acme-shop',
    tenant: '01TENANT',
    hosts,
    primary,
    hostname: OWN,
    hostnames: [OWN, 'preview.example.com'],
  });
  const EXFIL = 'https://exfil.example.com/collect';
  /**
   * A router binding that behaves like a Fetcher dispatching to an app that answers 302 to a third
   * party: it follows only when the request it is handed says `follow`, through the global fetch,
   * which is the internet here.
   */
  const redirectingRouter = () => {
    const seen: Request[] = [];
    const fetcher = {
      fetch: async (request: Request) => {
        seen.push(request);
        if (request.redirect === 'follow') return fetch(EXFIL);
        return new Response(null, { status: 302, headers: { location: EXFIL } });
      },
    } as unknown as Fetcher;
    return { fetcher, seen };
  };

  for (const primary of [false, true]) {
    const who = primary ? 'an install' : 'a copy';
    it(`${who}'s GET to another app that 302s to a third party is not followed: the vertical gets the 3xx`, async () => {
      const internet = vi.fn(async () => new Response('exfiltrated', { status: 200 }));
      vi.stubGlobal('fetch', internet);
      const r = redirectingRouter();
      const res = await worker.fetch(
        new Request('https://crm-acme.global.substrat.run/api/read'),
        envWith({ ROUTER: r.fetcher, OUTBOUND_POLICY: policy(primary) }),
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(EXFIL);
      expect(internet).not.toHaveBeenCalled();
      expect(r.seen[0]!.redirect).toBe('manual');
    });
  }

  /** Stub the internet with `respond`, and return every request that reached it. */
  const captureFetch = (respond: () => Response = () => new Response('ok')) => {
    const seen: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (req: Request) => (seen.push(req), respond())));
    return seen;
  };

  // Every path a request leaves by, for both kinds of scope — each one with the policy that lets
  // it out there.
  const paths = [
    ['the relay', 'https://console.substrat.net/internal/x', [true, false]],
    ['its own custom domain', 'https://preview.example.com/api/write', [true, false]],
    ['a declared host', 'https://api.scrive.com/api/v2/documents', [true]],
  ] as const;
  for (const [name, url, primaries] of paths) {
    for (const primary of primaries) {
      it(`${name}: ${primary ? 'an install' : 'a copy'}'s request leaves with redirect manual, and the 3xx comes back`, async () => {
        const seen = captureFetch(() => new Response(null, { status: 307, headers: { location: EXFIL } }));
        const res = await worker.fetch(new Request(url, { method: 'POST', body: '{}' }), envWith({ OUTBOUND_POLICY: policy(primary) }));
        expect(res.status).toBe(307);
        expect(seen.map((r) => [r.redirect, r.method, new URL(r.url).hostname])).toEqual([['manual', 'POST', new URL(url).hostname]]);
      });
    }
  }

  it('an unenforced version (hosts: null) leaves with redirect manual too', async () => {
    const seen = captureFetch();
    await worker.fetch(new Request('https://anything.example.org/x'), envWith({ OUTBOUND_POLICY: policy(true, null) }));
    await worker.fetch(new Request('https://anything.example.org/x'), envWith({ OUTBOUND_POLICY: undefined }));
    expect(seen.map((r) => r.redirect)).toEqual(['manual', 'manual']);
  });

  it('carries the body and headers through unchanged — only the redirect mode is set', async () => {
    const seen = captureFetch();
    await worker.fetch(
      new Request('https://api.scrive.com/x', { method: 'PUT', body: 'payload', headers: { authorization: 'Bearer t' } }),
      envWith({ OUTBOUND_POLICY: policy(true) }),
    );
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer t');
    expect(await seen[0]!.text()).toBe('payload');
  });

  describe('a redirect is metered beside the verdict that let the request out', () => {
    const meterWith = (respond: () => Response, over: Partial<Env> = {}) => {
      const points: { blobs: string[] }[] = [];
      captureFetch(respond);
      return { points, env: envWith({ ANALYTICS: meterInto(points), OUTBOUND_POLICY: policy(true), ...over }) };
    };

    it('blobs = [the host that redirected, redirect, tenant, the host it pointed at]', async () => {
      const { points, env } = meterWith(() => new Response(null, { status: 302, headers: { location: EXFIL } }));
      await worker.fetch(new Request('https://api.scrive.com/x'), env);
      expect(points.map((p) => p.blobs)).toEqual([
        ['api.scrive.com', 'allowed', '01TENANT'],
        ['api.scrive.com', 'redirect', '01TENANT', 'exfil.example.com'],
      ]);
    });

    it('on the loopback too', async () => {
      const { points, env } = meterWith(() => new Response('unused'), { ROUTER: redirectingRouter().fetcher });
      await worker.fetch(new Request('https://crm-acme.global.substrat.run/api/read'), env);
      expect(points.map((p) => p.blobs)).toEqual([
        ['crm-acme.global.substrat.run', 'platform', '01TENANT'],
        ['crm-acme.global.substrat.run', 'redirect', '01TENANT', 'exfil.example.com'],
      ]);
    });

    it('a relative Location resolves against the request it answers', async () => {
      const { points, env } = meterWith(() => new Response(null, { status: 301, headers: { location: '/v2/x' } }));
      await worker.fetch(new Request('https://api.scrive.com/x'), env);
      expect(points[1]!.blobs[3]).toBe('api.scrive.com');
    });

    it('twin: a 2xx, and a 3xx with no Location (304), meter the verdict alone', async () => {
      for (const respond of [() => new Response('ok'), () => new Response(null, { status: 304 })]) {
        const { points, env } = meterWith(respond);
        await worker.fetch(new Request('https://api.scrive.com/x'), env);
        expect(points.map((p) => p.blobs[1])).toEqual(['allowed']);
      }
    });
  });
});
