/**
 * The Cloudflare seam: the DO class (which must live in the deploying script) and the
 * Hono app. Everything else is in `routes.ts`, which never imports `cloudflare:workers`
 * and is therefore driven end to end by node tests.
 *
 * The BankID hop's socket and TLS module are bound here for the same reason: `routes.ts`
 * takes the transport as an option, and only this file loads `cloudflare:sockets` and WASM.
 *
 * Local run: `wrangler dev` — with no upstream credentials set, every provider surface
 * answers 404, which is the honest answer for a relay that holds no client.
 */
import { createApp, MTLS_DEADLINE_MS, MTLS_MAX_RESPONSE_BYTES } from './routes.js';
import { RelayDO } from './relay-do.js';
import { mtlsClient } from './mtls-client.js';
import { openSocket, tlsEngine } from './mtls-socket.js';

export { RelayDO };
export default createApp({
  mtls: mtlsClient({ openSocket, tls: tlsEngine, deadlineMs: MTLS_DEADLINE_MS, maxResponseBytes: MTLS_MAX_RESPONSE_BYTES }),
});
export type { Env } from './routes.js';
