import { describe, it, expect, afterEach, vi } from 'vitest';
import { readDiscovery, sameIssuer, type DiscoveryFetch } from '../src/discovery.js';

/**
 * `readDiscovery` — the uncached read `discoverIssuer` caches, for the paths that must see the
 * issuer's current answer and bring their own fetch (the dashboard's client registration, the
 * auth-server's save-time upstream discovery). The binding rules themselves are pinned through
 * the login flow in `discovery-binding.test.ts`; this file pins what is new about the read:
 * the injected fetch, the signal, no cache, and the same rules holding on that path.
 */

const ISSUER = 'https://issuer.test';
const WELL_KNOWN = `${ISSUER}/.well-known/openid-configuration`;
const GOOD = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
};

function stub(answer: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: DiscoveryFetch = async (url, init) => {
    calls.push({ url, init });
    if (calls.length > 20) throw new Error('runaway');
    return answer(url);
  };
  return { fetch, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('readDiscovery', () => {
  it('reads through the injected fetch, without redirects, and never touches the global one', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('the global fetch was used');
    });
    const { fetch, calls } = stub(() => Response.json({ ...GOOD, registration_endpoint: `${ISSUER}/register` }));
    const d = await readDiscovery(ISSUER, { fetch });
    expect(d.token_endpoint).toBe(`${ISSUER}/token`);
    // The whole document comes back, so a caller can read a field `Discovery` does not name.
    expect(d.registration_endpoint).toBe(`${ISSUER}/register`);
    expect(calls).toEqual([{ url: WELL_KNOWN, init: { redirect: 'manual' } }]);
  });

  it('defaults to the runtime fetch, looked up at call time', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      return Response.json(GOOD);
    });
    await readDiscovery(ISSUER);
    expect(seen).toEqual([WELL_KNOWN]);
  });

  it('is not cached: every read asks the issuer again', async () => {
    const { fetch, calls } = stub(() => Response.json(GOOD));
    await readDiscovery(ISSUER, { fetch });
    await readDiscovery(ISSUER, { fetch });
    expect(calls).toHaveLength(2);
  });

  it('passes the signal to every hop', async () => {
    const signal = new AbortController().signal;
    let hop = 0;
    const { fetch, calls } = stub((url) =>
      hop++ === 0 ? new Response(null, { status: 301, headers: { location: `${url}/` } }) : Response.json(GOOD),
    );
    await readDiscovery(ISSUER, { fetch, signal });
    expect(calls.map((c) => c.init?.signal)).toEqual([signal, signal]);
  });

  it('refuses an issuer that is not https, or carries userinfo, before anything is fetched', async () => {
    const { fetch, calls } = stub(() => Response.json(GOOD));
    for (const bad of ['http://issuer.test', 'https://u:p@issuer.test', 'https://issuer.test?x=1', 'not a url']) {
      await expect(readDiscovery(bad, { fetch }), bad).rejects.toThrow(/issuer/);
    }
    expect(calls).toEqual([]);
  });

  it('holds the injected-fetch path to the same rules: issuer binding, same-origin redirects, endpoint transport', async () => {
    const other = stub(() => Response.json({ ...GOOD, issuer: 'https://other.test' }));
    await expect(readDiscovery(ISSUER, { fetch: other.fetch })).rejects.toThrow(/different issuer/);

    const away = stub(() => new Response(null, { status: 302, headers: { location: 'https://other.test/.well-known/openid-configuration' } }));
    await expect(readDiscovery(ISSUER, { fetch: away.fetch })).rejects.toThrow(/away from its origin/);
    expect(away.calls).toHaveLength(1);

    // Plaintext loopback from an https issuer, for each endpoint the read decides on.
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      const { fetch } = stub(() => Response.json({ ...GOOD, [key]: 'http://localhost:9999/x' }));
      await expect(readDiscovery(ISSUER, { fetch }), key).rejects.toThrow(new RegExp(`${key} that is not https`));
    }
    // jwks_uri is required, not only checked when present.
    const { jwks_uri: _omit, ...noJwks } = GOOD;
    const missing = stub(() => Response.json(noJwks));
    await expect(readDiscovery(ISSUER, { fetch: missing.fetch })).rejects.toThrow(/jwks_uri/);
  });

  it('admits plaintext loopback endpoints for a loopback dev issuer (the positive twin)', async () => {
    const dev = 'http://localhost:8879';
    const { fetch } = stub(() =>
      Response.json({ issuer: dev, authorization_endpoint: `${dev}/authorize`, token_endpoint: `${dev}/token`, jwks_uri: `${dev}/jwks` }),
    );
    expect((await readDiscovery(dev, { fetch })).jwks_uri).toBe(`${dev}/jwks`);
  });

  it('refuses a body that is not a JSON object', async () => {
    const { fetch } = stub(() => Response.json(null));
    await expect(readDiscovery(ISSUER, { fetch })).rejects.toThrow(/not a JSON object/);
  });
});

describe('sameIssuer', () => {
  it('compares the way discovery does, and never matches an invalid identifier', () => {
    expect(sameIssuer('https://Issuer.test:443/', ISSUER)).toBe(true);
    expect(sameIssuer(`${ISSUER}/Tenant`, `${ISSUER}/tenant`)).toBe(false);
    expect(sameIssuer('https://other.test', ISSUER)).toBe(false);
    expect(sameIssuer(`https://u:p@issuer.test`, `https://u:p@issuer.test`)).toBe(false);
    expect(sameIssuer('not a url', 'not a url')).toBe(false);
  });
});
