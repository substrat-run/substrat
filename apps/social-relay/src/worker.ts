/**
 * The Cloudflare seam: the DO class (which must live in the deploying script) and the
 * Hono app. Everything else is in `routes.ts`, which never imports `cloudflare:workers`
 * and is therefore driven end to end by node tests.
 *
 * Local run: `wrangler dev` — with no upstream credentials set, every provider surface
 * answers 404, which is the honest answer for a relay that holds no client.
 */
import app from './routes.js';
import { RelayDO } from './relay-do.js';

export { RelayDO };
export default app;
export type { Env } from './routes.js';
