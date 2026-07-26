/**
 * The auth-server as a Cloudflare Worker: a Better Auth OIDC provider.
 *
 * Unlike a kernel vertical, this composes no engines and has no ScopeDO — its whole
 * domain (users, sessions, OAuth clients, tokens, JWKS) is owned by Better Auth inside
 * the issuer DO. It runs in two shapes:
 *
 *   - STANDALONE: its own worker + hostname, one fixed-name issuer DO (`wrangler dev` /
 *     a self-managed deploy with `PUBLIC_ORIGIN` + `ADMIN_*` env).
 *   - HOSTED: pushed to the platform's dispatch namespace and installed per team — the
 *     router asserts the scope, and each installed app is its OWN issuer DO.
 *
 * This file is only the Cloudflare seam: it exports the DO class (which must live in the
 * deploying script) and the Hono app. The whole HTTP surface — routing to the right
 * issuer, the `/api` surface, the K-31 `/internal/*` platform verbs, the inlined admin
 * SPA — lives in `app.ts`, which is node-testable because it never imports
 * `cloudflare:workers`.
 *
 * Local run:  wrangler dev
 */
import app from './routes.js';
import { AuthServerDO } from './auth-do.js';

export { AuthServerDO };
export default app;
