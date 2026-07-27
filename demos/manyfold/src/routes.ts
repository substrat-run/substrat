import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PermissionDenied, type ScopeStub } from '@substrat-run/kernel';
import { API } from './api.js';

/**
 * The Manyfold data API — one route table, adapter- and auth-agnostic. Both entrypoints
 * mount it: `server.ts` (node, pure-SQLite adapter, dev-header auth) and `worker.ts`
 * (Cloudflare, Durable-Object adapter, the vertical's own IdentityDO). Each supplies a
 * `resolveStub` that authenticates the caller AND resolves which SITE (scope) the request
 * targets, then returns a capability `ScopeStub`. Every route is a thin wrapper over one
 * operation — no business logic — so the two entries cannot drift (D-14).
 */
export type ResolveStub = (c: Context) => Promise<ScopeStub>;

/**
 * The vertical's operations, exposed under `/api/op/<name>` — derived from the
 * API catalog (src/api.ts), so the served surface and the documented surface
 * are the same list by construction. Bare names (the SPA's pre-convention
 * shape) stay accepted; full registered names are the documented convention.
 */
export const OPERATIONS = Object.keys(API).map((n) => n.slice('manyfold/'.length));
const ALLOWED = new Set<string>(OPERATIONS);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountApi(app: Hono<any, any, any>, resolveStub: ResolveStub): void {
  // Shared fail-closed error mapping: permission → 403, state-machine/immutability
  // conflicts → 409, missing entity/scope/op → 404, everything else a validation 400.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const msg = err instanceof Error ? err.message : String(err);
    // Match by message too, not just instanceof: on the Cloudflare DO adapter the op error
    // crosses the ScopeDO RPC boundary and is rebuilt as a plain Error, so `instanceof
    // PermissionDenied` is false there — a denial would otherwise degrade to a 400.
    if (err instanceof PermissionDenied || /permission denied/i.test(msg)) return c.json({ error: msg }, 403);
    if (/invalid transition|frozen|already|cannot edit|cannot restore|not published|in use/.test(msg)) {
      return c.json({ error: msg }, 409);
    }
    if (/not found|unknown (content type|site|operation)|not entitled|unknown scope/.test(msg)) {
      return c.json({ error: msg }, 404);
    }
    return c.json({ error: msg }, 400);
  });

  // One URL per operation (design/api-surface.md §2.2). Full registered names
  // (`/api/op/manyfold/create-entry`) are the documented platform convention;
  // bare names (`/api/op/create-entry`) remain for the SPA.
  app.post('/api/op/*', async (c) => {
    const name = decodeURIComponent(new URL(c.req.url).pathname.slice('/api/op/'.length));
    const full = name in API ? name : ALLOWED.has(name) ? `manyfold/${name}` : null;
    if (!full) throw new HTTPException(404, { message: `unknown operation: ${name}` });
    const body = await c.req.text();
    return c.json((await (await resolveStub(c)).invoke(full, body ? JSON.parse(body) : undefined)) ?? null);
  });
}
