import { connect } from 'cloudflare:sockets';
import wasm from './mtls-wasm/mtls-wasm.generated.wasm';
import { initSync, MtlsClient } from './mtls-wasm/mtls-wasm.generated.js';
import type { SocketOpener, TlsEngineFactory } from './mtls-client.js';

/**
 * The runtime half of `mtls-client.ts`: a `cloudflare:sockets` connection with the platform's
 * TLS switched OFF (`secureTransport: 'off'`), and rustls from `mtls-wasm/` running the TLS over
 * it instead. Imported only by `worker.ts`, so `routes.ts` and its node tests never load either.
 *
 * Available here and not in a vertical: the relay is not a dispatched script, and Cloudflare
 * turns `connect()` off for a script with an outbound worker attached — every vertical (D-46).
 */

// Instantiated once per isolate. A Worker cannot compile WASM from bytes at run time; the module
// arrives compiled, as the bundler's `.wasm` import.
initSync({ module: wasm });

export const openSocket: SocketOpener = (host, port) =>
  connect({ hostname: host, port }, { secureTransport: 'off', allowHalfOpen: false });

export const tlsEngine: TlsEngineFactory = (host, rootPem, certPem, keyPem) =>
  new MtlsClient(host, rootPem, certPem, keyPem);
