// Every way out of an isolate this spike knows of, tried from wherever it is imported. Shared,
// byte for byte, by the plain scope (an ES module of the script) and the loaded scope (a Text
// module the supervisor hands to the Worker Loader), so a difference in the answers is a
// difference in where the code runs, never in what it tries.
//
// `ok: true` only says the call returned. Whether anything LEFT is decided by the sink in
// run-local.mjs, which records every hit by the label in its path or first line.
import { connect } from 'cloudflare:sockets';

async function attempt(results, name, run) {
  try {
    results[name] = { ok: true, value: await run() };
  } catch (err) {
    results[name] = { ok: false, error: String(err?.message ?? err).slice(0, 240) };
  }
}

const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms))]);

/** `sink` is `{ host, httpPort, tcpPort }`; `label` names this run in the sink's log. */
export async function probeExits({ sink, label, env, ctx }) {
  const results = {};
  const base = `http://${sink.host}:${sink.httpPort}/hit/${label}`;

  // 1. The global fetch, as module code would call it.
  await attempt(results, 'fetch', async () => (await fetch(`${base}/fetch`)).status);

  // 2. A fetch found anywhere on the global object's prototype chain: what a preamble that only
  //    deletes the own property leaves behind.
  await attempt(results, 'fetch-prototype', async () => {
    for (let o = Object.getPrototypeOf(globalThis); o; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, 'fetch');
      if (typeof d?.value === 'function') return (await d.value.call(globalThis, `${base}/fetch-prototype`)).status;
    }
    throw new Error('no fetch on the prototype chain');
  });

  // 3. A WebSocket opened with fetch and an Upgrade header (the Workers client idiom).
  await attempt(results, 'fetch-upgrade', async () => {
    const res = await fetch(`${base}/fetch-upgrade`, { headers: { upgrade: 'websocket' } });
    if (!res.webSocket) return `status ${res.status}, no socket`;
    res.webSocket.accept();
    res.webSocket.close();
    return 'socket opened';
  });

  // 4. The WebSocket constructor.
  await attempt(results, 'websocket', () =>
    typeof WebSocket !== 'function'
      ? Promise.reject(new Error('no WebSocket constructor'))
      : withTimeout(
          new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://${sink.host}:${sink.httpPort}/hit/${label}/websocket`);
            ws.addEventListener('open', () => {
              ws.close();
              resolve('open');
            });
            ws.addEventListener('error', (e) => reject(new Error(`error event: ${e?.message ?? 'no message'}`)));
          }),
          3000,
          'websocket',
        ),
  );

  // 5. Raw TCP through cloudflare:sockets.
  await attempt(results, 'connect', async () => {
    const socket = connect({ hostname: sink.host, port: sink.tcpPort });
    await withTimeout(socket.opened, 3000, 'connect');
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode(`${label}/connect\n`));
    await writer.close();
    return 'opened and wrote';
  });

  // 6. node:net and node:http under nodejs_compat (they are built on the two above, if at all).
  await attempt(results, 'node-net', async () => {
    const net = await import('node:net');
    return withTimeout(
      new Promise((resolve, reject) => {
        const s = net.connect({ host: sink.host, port: sink.tcpPort }, () => {
          s.end(`${label}/node-net\n`);
          resolve('connected');
        });
        s.on('error', reject);
      }),
      3000,
      'node-net',
    );
  });
  await attempt(results, 'node-http', async () => {
    const http = await import('node:http');
    return withTimeout(
      new Promise((resolve, reject) => {
        http.get(`${base}/node-http`, (res) => resolve(res.statusCode)).on('error', reject);
      }),
      3000,
      'node-http',
    );
  });

  // 7. A dynamic import of a URL.
  await attempt(results, 'import-url', async () => {
    await import(`${base}/import-url`);
    return 'imported';
  });

  // 8. The Cache API. It never sends a request to the origin, so it is recorded for presence: a
  //    shared store the code could leave data in, not a way to the network.
  await attempt(results, 'cache', async () => {
    if (typeof caches === 'undefined') throw new Error('no caches global');
    await caches.default.put(`${base}/cache`, new Response('x', { headers: { 'cache-control': 'max-age=60' } }));
    return (await caches.default.match(`${base}/cache`)) ? 'stored and read back' : 'stored, not read back';
  });

  // 9. The ambient env of cloudflare:workers (what boundary-lint R2 forbids importing).
  await attempt(results, 'ambient-env', async () => Object.keys((await import('cloudflare:workers')).env ?? {}));

  // 10. What the code was handed: its env and its loopback exports.
  results.envKeys = Object.keys(env ?? {});
  results.exportKeys = ctx?.exports ? Object.keys(ctx.exports) : null;
  return results;
}
