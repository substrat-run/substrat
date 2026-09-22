/**
 * The router's deployment entry.
 *
 * Two exports, and the split is deliberate: `fetch` is the public router (`worker.ts`, which
 * imports nothing from the workers runtime so its tests run in plain node), and `PeerCalls`
 * is the named entrypoint only the egress worker binds (#1706). A named entrypoint must be
 * exported from the script's main module, which is why this file exists rather than the
 * class living beside the fetch handler.
 */
export { default } from './worker.js';
export { PeerCalls } from './peer-calls.js';
export type { Env } from './worker.js';
