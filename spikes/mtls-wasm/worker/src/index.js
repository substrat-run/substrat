import { connect } from 'cloudflare:sockets';
import wasm from './pkg/mtls_wasm_bg.wasm';
import { initSync, MtlsClient } from './pkg/mtls_wasm.js';

initSync({ module: wasm });

const HOSTS = { test: 'appapi2.test.bankid.com', production: 'appapi2.bankid.com' };

/** One HTTPS POST over our own TLS, presenting the client certificate. Logs every stage. */
async function mtlsPost({ host, path, body, rootPem, certPem, keyPem, log }) {
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const tls = new MtlsClient(host, rootPem, certPem, keyPem);
  log('tls.config', { ms: at() });

  const socket = connect({ hostname: host, port: 443 }, { secureTransport: 'off' });
  await socket.opened;
  log('tcp.open', { ms: at() });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const flush = async () => {
    const out = tls.transmit();
    if (out.length) await writer.write(out);
  };

  const payload = JSON.stringify(body);
  tls.send(new TextEncoder().encode(
    `POST ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${new TextEncoder().encode(payload).length}\r\nConnection: close\r\n\r\n${payload}`,
  ));
  await flush();

  const chunks = [];
  let handshakeLogged = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const plain = tls.receive(value);
      if (!handshakeLogged && !tls.handshaking) {
        handshakeLogged = true;
        log('tls.handshake', { ms: at(), protocol: tls.protocol });
      }
      if (plain.length) chunks.push(plain);
      await flush();
    }
  } finally {
    await socket.close().catch(() => {});
  }
  const raw = new TextDecoder().decode(concat(chunks));
  const [head, ...rest] = raw.split('\r\n\r\n');
  const status = Number(head.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? 0);
  const chunked = /transfer-encoding:\s*chunked/i.test(head);
  const text = chunked ? dechunk(rest.join('\r\n\r\n')) : rest.join('\r\n\r\n');
  log('http.response', { ms: at(), status, bytes: raw.length });
  return { status, text };
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function dechunk(s) {
  let out = '';
  for (;;) {
    const i = s.indexOf('\r\n');
    const n = parseInt(s.slice(0, i), 16);
    if (!n) return out;
    out += s.slice(i + 2, i + 2 + n);
    s = s.slice(i + 2 + n + 2);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/probe') return new Response('GET /probe?env=test', { status: 404 });
    const environment = url.searchParams.get('env') === 'production' ? 'production' : 'test';
    const lines = [];
    const log = (stage, data) => {
      const line = { stage, ...data };
      lines.push(line);
      console.log(JSON.stringify({ msg: 'bankid.mtls', ...line }));
    };
    try {
      const res = await mtlsPost({
        host: HOSTS[environment],
        path: '/rp/v6.0/collect',
        body: { orderRef: '00000000-0000-0000-0000-000000000000' },
        rootPem: env.ROOT_CA,
        certPem: env.CLIENT_CERT,
        keyPem: env.CLIENT_KEY,
        log,
      });
      // 400 invalidParameters = the handshake and the certificate were accepted.
      const ok = res.status === 400 && res.text.includes('invalidParameters');
      return Response.json({ ok, environment, status: res.status, body: res.text.slice(0, 300), stages: lines });
    } catch (e) {
      log('failed', { error: String(e?.message ?? e) });
      return Response.json({ ok: false, environment, stages: lines }, { status: 502 });
    }
  },
};
