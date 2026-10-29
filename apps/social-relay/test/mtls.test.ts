import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type Env } from '../src/routes.js';
import { MtlsFailure, mtlsClient, parseResponse, type MtlsRequest, type Socket, type TlsEngine } from '../src/mtls-client.js';
import { namespaceOf, testStore, type TestStore } from './support.js';

/**
 * The BankID hop (docs/rfc/mtls-hop.md). Two halves: the client, over a fake socket and a fake
 * TLS engine — the framing, the stages and the bounds are what can be wrong here, the TLS is
 * rustls's — and the route, over the real store with the transport replaced.
 *
 * What the real socket and the real module do against BankID is spikes/mtls-wasm's evidence,
 * not a node test's: neither `cloudflare:sockets` nor BankID is reachable from here.
 */

const encoder = new TextEncoder();
const NOW = 1_770_000_000_000;

/** A socket whose peer answers with `reply` once the request has been written. */
function fakeSocket(reply: Uint8Array[], opened: Promise<unknown> = Promise.resolve()): Socket & { written: Uint8Array[]; closed: boolean } {
  const written: Uint8Array[] = [];
  let answer: (() => void) | undefined;
  const asked = new Promise<void>((resolve) => (answer = resolve));
  const socket = {
    opened,
    readable: new ReadableStream<Uint8Array>({
      async start(controller) {
        await asked;
        for (const chunk of reply) controller.enqueue(chunk);
        controller.close();
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(chunk);
        answer?.();
      },
    }),
    written,
    closed: false,
    async close() {
      socket.closed = true;
    },
  };
  return socket;
}

/** An engine that "encrypts" by passing bytes through and finishes its handshake on the first read. */
function passthroughEngine(over: Partial<TlsEngine> = {}): TlsEngine {
  let outbound: Uint8Array = new Uint8Array();
  let handshaking = true;
  return {
    get handshaking() {
      return handshaking;
    },
    protocol: 'TLSv1_3',
    send(p) {
      outbound = p;
    },
    transmit() {
      const out = outbound;
      outbound = new Uint8Array();
      return out;
    },
    receive(data) {
      handshaking = false;
      return data;
    },
    ...over,
  };
}

const request: MtlsRequest = {
  host: 'appapi2.test.bankid.com',
  method: 'POST',
  path: '/rp/v6.0/collect',
  body: '{"orderRef":"x"}',
  rootPem: 'root',
  certPem: 'cert',
  keyPem: 'key',
};

const clientOver = (socket: Socket, engine: TlsEngine = passthroughEngine(), deadlineMs = 1_000) =>
  mtlsClient({ openSocket: () => socket, tls: () => engine, deadlineMs, maxResponseBytes: 4096, now: () => 0 });

describe('the client', () => {
  it('sends one framed request and reads the answer, stage by stage', async () => {
    const body = '{"completionData":{"user":{"name":"Åsa Öberg"}}}';
    const socket = fakeSocket([encoder.encode(`HTTP/1.1 200 OK\r\nContent-Length: ${encoder.encode(body).length}\r\n\r\n${body}`)]);
    const answer = await clientOver(socket)(request);

    // Content-Length counts BYTES: the name is multi-byte and must survive whole.
    expect(answer).toEqual({
      status: 200,
      text: body,
      stages: [
        { stage: 'tls.config', ms: 0 },
        { stage: 'tcp.open', ms: 0 },
        { stage: 'tls.handshake', ms: 0, protocol: 'TLSv1_3' },
        { stage: 'http.response', ms: 0, status: 200 },
      ],
    });
    const sent = new TextDecoder().decode(socket.written[0]);
    expect(sent).toBe(
      'POST /rp/v6.0/collect HTTP/1.1\r\nHost: appapi2.test.bankid.com\r\nContent-Type: application/json\r\n' +
        'Accept: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{"orderRef":"x"}',
    );
    expect(socket.closed).toBe(true);
  });

  it.each([
    ['a certificate the engine refuses', { tls: () => { throw new Error('client key pem: not a PEM private key'); } }, 'tls.config'],
    ['a handshake the server refuses', { engine: passthroughEngine({ receive: () => { throw new Error('tls: invalid peer certificate: UnknownIssuer'); } }) }, 'tls.handshake'],
    ['a host that never opens', { opened: new Promise(() => undefined), deadlineMs: 5 }, 'tcp.open'],
    ['an answer larger than the bound', { reply: [encoder.encode(`HTTP/1.1 200 OK\r\n\r\n${'x'.repeat(5000)}`)] }, 'http.response'],
  ] as const)('reports %s at its stage', async (_, setup, stage) => {
    const s = setup as { tls?: () => TlsEngine; engine?: TlsEngine; opened?: Promise<unknown>; deadlineMs?: number; reply?: Uint8Array[] };
    const socket = fakeSocket(s.reply ?? [encoder.encode('HTTP/1.1 200 OK\r\n\r\n')], s.opened);
    const call = mtlsClient({
      openSocket: () => socket,
      tls: s.tls ?? (() => s.engine ?? passthroughEngine()),
      deadlineMs: s.deadlineMs ?? 1_000,
      maxResponseBytes: 4096,
      now: () => 0,
    });
    const failure = await call(request).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(MtlsFailure);
    expect((failure as MtlsFailure).stage).toBe(stage);
  });

  it('reads a chunked answer', () => {
    const chunk = encoder.encode('{"a":"Å"}');
    const bytes = new Uint8Array([
      ...encoder.encode(`HTTP/1.1 400 Bad Request\r\nTransfer-Encoding: chunked\r\n\r\n${chunk.length.toString(16)}\r\n`),
      ...chunk,
      ...encoder.encode('\r\n0\r\n\r\n'),
    ]);
    expect(parseResponse(bytes)).toEqual({ status: 400, text: '{"a":"Å"}' });
  });
});

describe('the hop route', () => {
  let store: TestStore;
  let client: { clientId: string; clientSecret: string };
  let calls: MtlsRequest[];

  const env = (): Env => ({ RELAY: namespaceOf(store) as unknown as Env['RELAY'] });
  const basic = (id: string, secret: string) => `Basic ${btoa(`${id}:${secret}`)}`;
  const hopBody = { certPem: 'CERT', keyPem: 'KEY', caPem: 'ROOT', body: { orderRef: '00000000-0000-0000-0000-000000000000' } };

  const appWith = (mtls?: (r: MtlsRequest) => Promise<{ status: number; text: string; stages: [] }>) =>
    createApp({ now: () => NOW, ...(mtls ? { mtls } : {}) });

  const post = (app: ReturnType<typeof createApp>, path: string, init: { auth?: string; body?: unknown } = {}) =>
    app.request(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(init.auth === undefined ? { authorization: basic(client.clientId, client.clientSecret) } : init.auth ? { authorization: init.auth } : {}) },
        body: JSON.stringify(init.body ?? hopBody),
      },
      env(),
    );

  beforeEach(async () => {
    store = testStore();
    client = await store.registerClient({ name: 'An install', redirectUris: ['https://auth.example.test/cb'] }, NOW);
    calls = [];
  });

  it("carries the install's certificate to BankID's host for that environment, and BankID's answer back", async () => {
    const app = appWith(async (r) => {
      calls.push(r);
      return { status: 400, text: '{"errorCode":"invalidParameters"}', stages: [] };
    });
    const res = await post(app, '/mtls/bankid/production/rp/v6.0/collect');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 400, body: { errorCode: 'invalidParameters' }, stages: [] });
    expect(calls).toEqual([
      {
        host: 'appapi2.bankid.com',
        method: 'POST',
        path: '/rp/v6.0/collect',
        body: '{"orderRef":"00000000-0000-0000-0000-000000000000"}',
        rootPem: 'ROOT',
        certPem: 'CERT',
        keyPem: 'KEY',
      },
    ]);
  });

  it.each([
    ['an environment that is not BankID', '/mtls/bankid/staging/rp/v6.0/auth', {}, 404, 'target'],
    ['a path outside the RP API', '/mtls/bankid/test/admin', {}, 404, 'target'],
    ['no client credential', '/mtls/bankid/test/rp/v6.0/auth', { auth: '' }, 401, 'client'],
    ['a wrong client secret', '/mtls/bankid/test/rp/v6.0/auth', { auth: 'Basic d3Jvbmc6c2VjcmV0' }, 401, 'client'],
    ['a body without the key', '/mtls/bankid/test/rp/v6.0/auth', { body: { certPem: 'C', caPem: 'R', body: {} } }, 400, 'request'],
  ] as const)('refuses %s before any connection is made', async (_, path, init, status, stage) => {
    const app = appWith(async (r) => {
      calls.push(r);
      return { status: 200, text: '', stages: [] };
    });
    const res = await post(app, path, init);
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ status, stage });
    expect(calls).toEqual([]);
  });

  it('honours the kill switch', async () => {
    await store.setClientDisabled(client.clientId, true);
    const res = await post(appWith(async () => ({ status: 200, text: '', stages: [] })), '/mtls/bankid/test/rp/v6.0/auth');
    expect(res.status).toBe(403);
  });

  it.each([
    ['tls.config', 400],
    ['tls.handshake', 502],
  ] as const)('answers a failure at %s as %i, naming the stage', async (stage, status) => {
    const app = appWith(async () => {
      throw new MtlsFailure(stage, 'nope', [{ stage: 'tls.config', ms: 1 }]);
    });
    const res = await post(app, '/mtls/bankid/test/rp/v6.0/auth');
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ stage, detail: 'nope', stages: [{ stage: 'tls.config', ms: 1 }] });
  });

  it('says so when this deployment cannot open sockets', async () => {
    const res = await post(appWith(), '/mtls/bankid/test/rp/v6.0/auth');
    expect(res.status).toBe(503);
  });
});
