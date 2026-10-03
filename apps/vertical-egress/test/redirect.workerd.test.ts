import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OutboundPolicy } from '../src/worker.js';

/**
 * #2011, on workerd: the egress worker never follows a redirect, and the vertical's own `fetch`
 * follows it instead — through the egress worker again.
 *
 * The node suite (`worker.test.ts`) pins that every allowed request leaves with
 * `redirect: 'manual'`. That alone would be a regression, not a fix, unless the RUNTIME then
 * follows the 3xx on the caller's side as a new subrequest that the outbound worker sees: a
 * vertical written against `fetch`'s default `follow` would otherwise start receiving 3xx
 * responses it never asked for. Whether it does is a fact about workerd, which node cannot
 * answer, so this suite runs the real worker (bundled from `src/worker.ts`) as the outbound
 * worker of a vertical script, the way the dispatch namespace attaches it. The internet, the
 * router and the relay are one function on the node side that records every hop that reaches it.
 */

const DECLARED = 'api.declared.example';
const ALSO_DECLARED = 'cdn.declared.example';
const EXFIL = 'https://exfil.example/collect';
const OWN = 'shop-acme--pr-7.global.substrat.run';

/** The vertical: makes the `fetch` it is told to, and reports what its runtime handed back. */
const VERTICAL = `export default {
  async fetch(request) {
    const { url, method, body, redirect } = await request.json();
    try {
      const res = await fetch(url, { method, body, redirect });
      return Response.json({
        status: res.status, url: res.url, redirected: res.redirected,
        location: res.headers.get('location'), body: await res.text(),
      });
    } catch (e) {
      return Response.json({ thrown: String(e) });
    }
  },
};`;

/** Everything outside the two scripts: what answers each URL, and what was asked of it. */
const answers: Record<string, () => Response> = {
  [`https://${DECLARED}/start`]: () => redirect(302, EXFIL),
  [`https://${DECLARED}/moved`]: () => redirect(307, `https://${ALSO_DECLARED}/landing`),
  [`https://${DECLARED}/loop`]: () => redirect(302, `https://${ALSO_DECLARED}/loop`),
  [`https://${ALSO_DECLARED}/loop`]: () => redirect(302, `https://${DECLARED}/loop`),
  [`https://${ALSO_DECLARED}/landing`]: () => new Response('landed'),
  ['https://crm-acme.global.substrat.run/bounce']: () => redirect(302, EXFIL),
  ['https://crm-acme.global.substrat.run/onward']: () => redirect(302, `https://${ALSO_DECLARED}/landing`),
  ['https://console.substrat.net/internal/x']: () => redirect(302, EXFIL),
  [EXFIL]: () => new Response('exfiltrated'),
};
const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });

let hops: string[] = [];
async function web(request: Request): Promise<Response> {
  const body = request.body ? await request.text() : '';
  hops.push(`${request.method} ${request.url}${body ? ` ${body}` : ''}`);
  return answers[request.url]?.() ?? new Response('not found', { status: 404 });
}

let bundle: string;
beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('../src/worker.ts', import.meta.url).href)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'import'],
    mainFields: ['module', 'main'],
    write: false,
  });
  bundle = out.outputFiles[0]!.text;
});

const mfs: Miniflare[] = [];
afterAll(async () => {
  await Promise.all(mfs.map((mf) => mf.dispose()));
});

/** A vertical whose every `fetch` goes through the egress worker, dispatched under `policy`. */
function dispatched(policy: OutboundPolicy) {
  const mf = new Miniflare({
    workers: [
      { name: 'vertical', modules: true, script: VERTICAL, compatibilityDate: '2025-01-01', outboundService: 'egress' },
      {
        name: 'egress',
        modules: [{ type: 'ESModule', path: 'worker.mjs', contents: bundle }],
        compatibilityDate: '2025-01-01',
        bindings: {
          PLATFORM_BASE_DOMAINS: 'substrat.run',
          PLATFORM_CP_URL: 'https://console.substrat.net',
          OUTBOUND_POLICY: policy as unknown as Record<string, unknown>,
        },
        serviceBindings: { ROUTER: web },
        outboundService: web,
      },
    ],
  });
  mfs.push(mf);
  return async (url: string, init: { method?: string; body?: string; redirect?: 'follow' | 'manual' } = {}) => {
    hops = [];
    const res = await mf.dispatchFetch('http://vertical/', {
      method: 'POST',
      body: JSON.stringify({ url, method: init.method ?? 'GET', body: init.body, redirect: init.redirect ?? 'follow' }),
    });
    return (await res.json()) as {
      status?: number;
      url?: string;
      redirected?: boolean;
      location?: string | null;
      body?: string;
      thrown?: string;
    };
  };
}

const policy = (primary: boolean): OutboundPolicy => ({
  slug: 'acme-shop',
  tenant: '01TENANT',
  hosts: [DECLARED, ALSO_DECLARED],
  primary,
  hostname: OWN,
  hostnames: [OWN],
});

describe('an install: the declared surface bounds where a redirect lands (#2011)', () => {
  let call: ReturnType<typeof dispatched>;
  beforeAll(() => {
    call = dispatched(policy(true));
  });

  it('a declared host redirecting to an undeclared one: the hop is refused, and never leaves', async () => {
    const res = await call(`https://${DECLARED}/start`);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body!)).toMatchObject({ error: 'outbound refused', host: 'exfil.example' });
    expect(res).toMatchObject({ url: EXFIL, redirected: true });
    expect(hops).toEqual([`GET https://${DECLARED}/start`]);
  });

  it('twin: declared → declared is followed by the vertical\'s own fetch, method and body kept on a 307', async () => {
    const res = await call(`https://${DECLARED}/moved`, { method: 'POST', body: 'payload' });
    expect(res).toMatchObject({ status: 200, body: 'landed', url: `https://${ALSO_DECLARED}/landing`, redirected: true });
    expect(hops).toEqual([`POST https://${DECLARED}/moved payload`, `POST https://${ALSO_DECLARED}/landing payload`]);
  });

  it('a vertical that asked for manual gets the 3xx, as fetch promises', async () => {
    const res = await call(`https://${DECLARED}/start`, { redirect: 'manual' });
    expect(res).toMatchObject({ status: 302, location: EXFIL, redirected: false });
    expect(hops).toEqual([`GET https://${DECLARED}/start`]);
  });

  it("a redirect loop between declared hosts ends at the runtime's own limit, every hop through the egress worker", async () => {
    const res = await call(`https://${DECLARED}/loop`);
    expect(res.thrown).toMatch(/redirect/i);
    // Each hop that reached the web was one the egress worker let out; none was its own follow.
    expect(hops.length).toBeGreaterThan(2);
    expect(hops.every((h) => h.endsWith('/loop'))).toBe(true);
  });

  it('the platform loopback: another app redirecting to an undeclared host is refused on the hop', async () => {
    const res = await call('https://crm-acme.global.substrat.run/bounce');
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body!)).toMatchObject({ host: 'exfil.example' });
    expect(hops).toEqual(['GET https://crm-acme.global.substrat.run/bounce']);
  });

  it('twin: the loopback redirecting to a declared host lands', async () => {
    const res = await call('https://crm-acme.global.substrat.run/onward');
    expect(res).toMatchObject({ status: 200, body: 'landed', redirected: true });
    expect(hops).toEqual(['GET https://crm-acme.global.substrat.run/onward', `GET https://${ALSO_DECLARED}/landing`]);
  });

  it('the relay redirecting to an undeclared host is refused on the hop', async () => {
    const res = await call('https://console.substrat.net/internal/x', { method: 'POST', body: '{}' });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body!)).toMatchObject({ host: 'exfil.example' });
    expect(hops).toEqual(['POST https://console.substrat.net/internal/x {}']);
  });
});

describe('a copy: as #2005 left it — the redirect hop meets the inert rule', () => {
  let call: ReturnType<typeof dispatched>;
  beforeAll(() => {
    call = dispatched(policy(false));
  });

  it('a read of another app that redirects to a third party is refused as inert, even to a declared host', async () => {
    for (const path of ['bounce', 'onward']) {
      const res = await call(`https://crm-acme.global.substrat.run/${path}`);
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body!).detail).toMatch(/preview or a fork/);
      expect(hops).toEqual([`GET https://crm-acme.global.substrat.run/${path}`]);
    }
  });

  it('the relay redirecting out is refused as inert', async () => {
    const res = await call('https://console.substrat.net/internal/x', { method: 'POST', body: '{}' });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body!).detail).toMatch(/preview or a fork/);
    expect(hops).toEqual(['POST https://console.substrat.net/internal/x {}']);
  });
});
