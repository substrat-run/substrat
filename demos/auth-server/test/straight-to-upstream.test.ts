import { describe, expect, it, vi } from 'vitest';
import { straightToUpstream as straightToUpstreamOf } from '../src/auth.js';

// Node's fetch types and the worker's are different `Response`s to the compiler; the suite only
// hands over fakes, so one cast here keeps them out of every call.
const straightToUpstream = straightToUpstreamOf as unknown as (
  handle: () => Promise<unknown>,
  request: unknown,
  response: unknown,
  providerFor: () => string,
) => Promise<Response>;

const ORIGIN = 'https://issuer.example';
const PAGE_LOAD = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const authorize = (headers: Record<string, string>) => new Request(`${ORIGIN}/api/auth/oauth2/authorize?client_id=c`, { headers });
const toLogin = () => new Response(null, { status: 302, headers: { location: `${ORIGIN}/login?client_id=c&sig=s` } });
const onlyUpstream = () => 'microsoft';

describe('straightToUpstream', () => {
  it('sends a page load to the upstream, carrying its state cookie', async () => {
    const handle = vi.fn(async () =>
      Response.json({ url: 'https://upstream.example/authorize' }, { headers: { 'set-cookie': 'state=abc' } }),
    );
    const answer = await straightToUpstream(handle, authorize(PAGE_LOAD), toLogin(), onlyUpstream);
    expect(answer.headers.get('location')).toBe('https://upstream.example/authorize');
    expect(answer.headers.getSetCookie()).toEqual(['state=abc']);
  });

  it.each([
    ['a fetch with no page load', {}],
    ['a page load in a frame', { ...PAGE_LOAD, 'sec-fetch-dest': 'iframe' }],
  ])('starts no upstream sign-in for %s', async (_name, headers) => {
    const handle = vi.fn(async () => new Response());
    const answer = await straightToUpstream(handle, authorize(headers), toLogin(), onlyUpstream);
    expect(handle).not.toHaveBeenCalled();
    expect(answer.headers.get('location')).toContain('/login');
  });

  it.each([
    ['throws', () => Promise.reject(new Error('boom'))],
    ['answers 500', async () => new Response(null, { status: 500 })],
  ])('keeps the redirect to the login screen when the upstream call %s', async (_name, handle) => {
    const answer = await straightToUpstream(handle, authorize(PAGE_LOAD), toLogin(), onlyUpstream);
    expect(answer.status).toBe(302);
    expect(answer.headers.get('location')).toContain('/login');
  });
});
