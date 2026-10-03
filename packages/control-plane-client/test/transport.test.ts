import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ControlPlaneError,
  ControlPlaneTransport,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  type ControlPlaneTransportOptions,
} from '../src/index.js';

/** The transport's protected surface, opened for the test. */
class Probe extends ControlPlaneTransport {
  send2 = (path: string, init?: RequestInit) => this.send(path, init);
  read2 = <T>(path: string, init?: RequestInit) => this.read<T>(path, init);
  call2 = <T>(path: string, init?: RequestInit) => this.call<T>(path, init);
}

interface Seen {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}

function spy(answer: () => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const seen: Seen[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    seen.push({ url, init, headers: init.headers as Record<string, string> });
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return { seen, fetch };
}

const BASE = 'https://cp.example/api';
const make = (fetch: typeof globalThis.fetch, extra: Partial<ControlPlaneTransportOptions> = {}) =>
  new Probe({ baseUrl: BASE, actor: 'actor-1', fetch, ...extra });

describe('defaults are exactly what every existing caller has always sent', () => {
  it('actor header + JSON content type, no credentials key, on a bodyless GET too', async () => {
    const { seen, fetch } = spy();
    await make(fetch).call2('/x');
    expect(seen[0]!.url).toBe(`${BASE}/x`);
    expect(seen[0]!.headers).toEqual({ [DEV_ACTOR_HEADER]: 'actor-1', 'content-type': 'application/json' });
    expect('credentials' in seen[0]!.init).toBe(false);
  });
});

describe('the headers option', () => {
  it('passes a header map through when the transport holds no credential of its own (positive twin)', async () => {
    const { seen, fetch } = spy();
    const t = make(fetch, { actor: null, headers: { authorization: 'Bearer t', 'x-substrat-tenant': 'acme' } });
    await t.call2('/x');
    expect(seen[0]!.headers).toEqual({
      authorization: 'Bearer t',
      'x-substrat-tenant': 'acme',
      'content-type': 'application/json',
    });
  });

  it('is beaten by the transport’s own credential: a stale map entry never overrides serviceToken or actor', async () => {
    const a = spy();
    await make(a.fetch, { serviceToken: 'tok', headers: { [SERVICE_TOKEN_HEADER]: 'stale' } }).call2('/x');
    expect(a.seen[0]!.headers[SERVICE_TOKEN_HEADER]).toBe('tok');

    const b = spy();
    await make(b.fetch, { headers: { [DEV_ACTOR_HEADER]: 'stale' } }).call2('/x');
    expect(b.seen[0]!.headers[DEV_ACTOR_HEADER]).toBe('actor-1');
  });

  it('is beaten, in turn, by the request’s own headers — a single call can override anything', async () => {
    const { seen, fetch } = spy();
    const t = make(fetch, { headers: { 'x-a': 'option' } });
    await t.call2('/x', { headers: { 'x-a': 'call', 'content-type': 'text/plain' } });
    expect(seen[0]!.headers['x-a']).toBe('call');
    expect(seen[0]!.headers['content-type']).toBe('text/plain');
  });
});

describe('the call’s headers, in every shape HeadersInit allows', () => {
  const shapes: Array<[string, () => HeadersInit]> = [
    ['a record', () => ({ 'content-type': 'text/plain', [SERVICE_TOKEN_HEADER]: 'call-token', 'x-extra': '1' })],
    ['a tuple array', () => [['content-type', 'text/plain'], [SERVICE_TOKEN_HEADER, 'call-token'], ['x-extra', '1']]],
    ['a Headers instance', () => new Headers({ 'content-type': 'text/plain', [SERVICE_TOKEN_HEADER]: 'call-token', 'x-extra': '1' })],
  ];

  it.each(shapes)('%s: every entry arrives, and each overrides the default it names', async (_name, headers) => {
    const { seen, fetch } = spy();
    await make(fetch, { serviceToken: 'option-token' }).call2('/x', { headers: headers() });
    expect(seen[0]!.headers).toEqual({
      [SERVICE_TOKEN_HEADER]: 'call-token',
      'content-type': 'text/plain',
      'x-extra': '1',
    });
  });

  it('names compare case-insensitively: one entry per header, the call’s value, never both spellings', async () => {
    const { seen, fetch } = spy();
    await make(fetch).call2('/x', { headers: { 'Content-Type': 'text/plain', 'X-Platform-Actor': 'call-actor' } });
    expect(seen[0]!.headers).toEqual({ [DEV_ACTOR_HEADER]: 'call-actor', 'content-type': 'text/plain' });
  });

  it('a differently-cased option header cannot sit beside the credential it names', async () => {
    const { seen, fetch } = spy();
    await make(fetch, { serviceToken: 'tok', headers: { 'X-Service-Token': 'stale' } }).call2('/x');
    expect(seen[0]!.headers).toEqual({ [SERVICE_TOKEN_HEADER]: 'tok', 'content-type': 'application/json' });
  });

  it('no call headers is the defaults alone (the positive twin), and request() reads the shapes the same way', async () => {
    const { seen, fetch } = spy();
    const t = make(fetch);
    await t.call2('/x');
    await t.request('/y', { headers: new Headers({ 'x-extra': '1' }) });
    expect(seen[0]!.headers).toEqual({ [DEV_ACTOR_HEADER]: 'actor-1', 'content-type': 'application/json' });
    expect(seen[1]!.headers).toEqual({ [DEV_ACTOR_HEADER]: 'actor-1', 'content-type': 'application/json', 'x-extra': '1' });
  });
});

describe('one credential per request, whatever the headers option carries', () => {
  const stale = { 'X-Platform-Actor': 'stale-actor', 'X-Service-Token': 'stale-token', 'x-keep': '1' };

  it('a service token drops BOTH credential headers from the option — no actor rides beside it', async () => {
    const { seen, fetch } = spy();
    await make(fetch, { serviceToken: 'good', headers: stale }).call2('/x');
    expect(seen[0]!.headers).toEqual({ [SERVICE_TOKEN_HEADER]: 'good', 'x-keep': '1', 'content-type': 'application/json' });
  });

  it('an actor drops BOTH too — a stale service token would outrank it at the plane', async () => {
    const { seen, fetch } = spy();
    await make(fetch, { actor: 'dev', headers: stale }).call2('/x');
    expect(seen[0]!.headers).toEqual({ [DEV_ACTOR_HEADER]: 'dev', 'x-keep': '1', 'content-type': 'application/json' });
  });

  it('with a token AND an actor, only the token leaves (#980), whatever the option carries', async () => {
    const { seen, fetch } = spy();
    await make(fetch, { serviceToken: 'good', actor: 'dev', headers: stale }).call2('/x');
    expect(seen[0]!.headers).toEqual({ [SERVICE_TOKEN_HEADER]: 'good', 'x-keep': '1', 'content-type': 'application/json' });
  });

  it('every spelling is dropped, not just the lowercase one', async () => {
    const { seen, fetch } = spy();
    await make(fetch, { serviceToken: 'good', headers: { 'X-PLATFORM-ACTOR': 'a', 'x-Service-TOKEN': 'b' } }).call2('/x');
    expect(Object.keys(seen[0]!.headers).sort()).toEqual(['content-type', SERVICE_TOKEN_HEADER]);
    expect(seen[0]!.headers[SERVICE_TOKEN_HEADER]).toBe('good');
  });

  it('a client with NO credential of its own passes the map through untouched (the CLI’s case — the positive twin)', async () => {
    const { seen, fetch } = spy();
    await make(fetch, { actor: null, headers: stale }).call2('/x');
    expect(seen[0]!.headers).toEqual({
      'x-platform-actor': 'stale-actor',
      'x-service-token': 'stale-token',
      'x-keep': '1',
      'content-type': 'application/json',
    });
  });

  it('a single call can still choose its own credential — the per-call override is intact', async () => {
    const { seen, fetch } = spy();
    await make(fetch, { serviceToken: 'good', headers: stale }).call2('/x', { headers: { 'X-Platform-Actor': 'call-actor' } });
    expect(seen[0]!.headers[DEV_ACTOR_HEADER]).toBe('call-actor');
    expect(seen[0]!.headers[SERVICE_TOKEN_HEADER]).toBe('good');
  });

  it('holds for the builder client as well', async () => {
    const { seen, fetch } = spy();
    const { ControlPlaneBuilderClient } = await import('../src/index.js');
    await new ControlPlaneBuilderClient({ baseUrl: BASE, serviceToken: 'good', actor: 'dev', headers: stale, fetch }).whoami();
    expect(seen[0]!.headers[SERVICE_TOKEN_HEADER]).toBe('good');
    expect(DEV_ACTOR_HEADER in seen[0]!.headers).toBe(false);
  });
});

describe('the contentType option', () => {
  it('null sends none — the CLI’s bodyless reads and its multipart upload carry no JSON type', async () => {
    const { seen, fetch } = spy();
    await make(fetch, { contentType: null }).call2('/x');
    expect(seen[0]!.headers).toEqual({ [DEV_ACTOR_HEADER]: 'actor-1' });
  });

  it('a string replaces the default, and a call may still set its own', async () => {
    const { seen, fetch } = spy();
    const t = make(fetch, { contentType: 'application/vnd.x+json' });
    await t.call2('/x');
    await make(fetch, { contentType: null }).call2('/y', { headers: { 'content-type': 'application/json' } });
    expect(seen[0]!.headers['content-type']).toBe('application/vnd.x+json');
    expect(seen[1]!.headers['content-type']).toBe('application/json');
  });
});

describe('a refusal carries what it was', () => {
  it('the raw body, the response headers and the URL — the message is unchanged', async () => {
    const problem = { type: 'about:blank', title: 'Conflict', status: 409, detail: 'a scope is still bound', code: 'conflict' };
    const { fetch } = spy(
      () => new Response(JSON.stringify(problem), { status: 409, headers: { 'x-substrat-cli-latest-version': '9.9.9' } }),
    );
    const err = await make(fetch).send2('/verticals/v').catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err).toMatchObject({ status: 409, message: 'a scope is still bound', malformed: false, url: `${BASE}/verticals/v` });
    expect(err.body).toBe(JSON.stringify(problem));
    expect(err.headers.get('x-substrat-cli-latest-version')).toBe('9.9.9');
  });

  it('a body that is not JSON is kept verbatim and the status line still speaks', async () => {
    const { fetch } = spy(() => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    const err = await make(fetch).send2('/x').catch((e) => e);
    expect(err).toMatchObject({ status: 502, message: '502 Bad Gateway', body: '<html>bad gateway</html>' });
  });

  it('an empty body is an empty string, never undefined', async () => {
    const { fetch } = spy(() => new Response(null, { status: 500, statusText: 'Internal Server Error' }));
    const err = await make(fetch).send2('/x').catch((e) => e);
    expect(err).toMatchObject({ status: 500, message: '500 Internal Server Error', body: '' });
  });

  it('a body the stream could not deliver is undefined — distinct from an empty one — and the reason phrase is kept', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new TypeError('terminated'));
      },
    });
    const { fetch } = spy(() => new Response(stream, { status: 502, statusText: 'Bad Gateway' }));
    const err = await make(fetch).send2('/x').catch((e) => e);
    expect(err).toMatchObject({ status: 502, message: '502 Bad Gateway', statusText: 'Bad Gateway' });
    expect(err.body).toBeUndefined();
  });

  it('an error built outside the transport has no body (the field says "not read off a response")', () => {
    const e = new ControlPlaneError(403, 'unknown tenant');
    expect(e.body).toBeUndefined();
    expect(e.headers).toBeUndefined();
    expect(e.malformed).toBe(false);
  });
});

describe('an unreachable plane', () => {
  it('is status 0 with the same sentence, and the error fetch threw is its cause (the very object)', async () => {
    const boom = new TypeError('fetch failed');
    const fetch = (async () => {
      throw boom;
    }) as unknown as typeof globalThis.fetch;
    const err = await make(fetch).send2('/x').catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err).toMatchObject({ status: 0, message: 'control plane unreachable: fetch failed', url: `${BASE}/x` });
    expect(err.cause).toBe(boom);
  });
});

describe('request(): the exchange without the error policy', () => {
  it('hands back a refusal as a Response — status, headers and an unread body', async () => {
    const { fetch } = spy(() => new Response('nope', { status: 503, headers: { 'retry-after': '1' } }));
    const res = await make(fetch).request('/x', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(await res.text()).toBe('nope');
  });

  it('lets a fetch rejection through untouched — not wrapped, not renamed', async () => {
    const boom = new TypeError('fetch failed');
    const fetch = (async () => {
      throw boom;
    }) as unknown as typeof globalThis.fetch;
    await expect(make(fetch).request('/x')).rejects.toBe(boom);
  });

  it('applies the same addressing, credential and headers as send()', async () => {
    const a = spy();
    const b = spy();
    const opts = { headers: { 'x-a': '1' }, credentials: 'include' as const };
    await make(a.fetch, opts).request('/x', { method: 'POST', body: '{}' });
    await make(b.fetch, opts).send2('/x', { method: 'POST', body: '{}' });
    expect(a.seen[0]).toEqual(b.seen[0]);
  });

  it('urlFor names the full URL, trailing slash dropped', () => {
    expect(new Probe({ baseUrl: `${BASE}/`, actor: null }).urlFor('/x')).toBe(`${BASE}/x`);
  });
});

describe('onResponse', () => {
  it('sees every answer that arrives — success and refusal — and the headers', async () => {
    const seenByHook: Array<[number, string | null]> = [];
    const answers = [new Response('{}', { headers: { 'x-h': 'a' } }), new Response('no', { status: 500, headers: { 'x-h': 'b' } })];
    const { fetch } = spy(() => answers.shift()!);
    const t = make(fetch, { onResponse: (r) => seenByHook.push([r.status, r.headers.get('x-h')]) });
    await t.send2('/x');
    await t.send2('/y').catch(() => undefined);
    expect(seenByHook).toEqual([
      [200, 'a'],
      [500, 'b'],
    ]);
  });

  it('is not called when nothing arrived (the transport failed first)', async () => {
    const hook = vi.fn();
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    await make(fetch, { onResponse: hook }).send2('/x').catch(() => undefined);
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('fetch is resolved at call time', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    vi.stubGlobal('fetch', real);
  });

  it('honours a globalThis.fetch swapped AFTER the client was built, called with the global as receiver', async () => {
    const t = new Probe({ baseUrl: BASE, actor: null }); // no fetch injected
    const receivers: unknown[] = [];
    vi.stubGlobal('fetch', function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(Response.json({ ok: 1 }));
    });
    await expect(t.call2('/x')).resolves.toEqual({ ok: 1 });
    expect(receivers).toEqual([globalThis]);
  });

  it('an injected fetch still wins over the global', async () => {
    const { seen, fetch } = spy();
    vi.stubGlobal('fetch', () => {
      throw new Error('the global must not be used');
    });
    await make(fetch).call2('/x');
    expect(seen).toHaveLength(1);
  });
});

describe('read(): a JSON answer that says what it was when it is not', () => {
  it('parses JSON', async () => {
    const { fetch } = spy(() => Response.json({ a: 1 }));
    await expect(make(fetch).read2('/x')).resolves.toEqual({ a: 1 });
  });

  it('flags a 2xx HTML page as malformed, with the body, URL and status', async () => {
    const { fetch } = spy(() => new Response('<!doctype html><html>', { status: 200 }));
    const err = await make(fetch).read2('/x').catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err).toMatchObject({ status: 200, malformed: true, body: '<!doctype html><html>', url: `${BASE}/x` });
  });

  it('an empty 204 is not JSON either (call() would answer undefined; read() does not guess)', async () => {
    const { fetch } = spy(() => new Response(null, { status: 204 }));
    await expect(make(fetch).read2('/x')).rejects.toMatchObject({ malformed: true, status: 204 });
    await expect(make(fetch).call2('/x')).resolves.toBeUndefined();
  });

  it('a refusal stays a refusal — not malformed', async () => {
    const { fetch } = spy(() => new Response('<html>', { status: 502 }));
    await expect(make(fetch).read2('/x')).rejects.toMatchObject({ status: 502, malformed: false });
  });
});
