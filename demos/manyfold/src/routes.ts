import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ScopeStub } from '@substrat-run/kernel';
import { problemResponse } from '@substrat-run/vertical-host';
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
  // Two pattern lists used to live here, and both existed because this vertical's own
  // refusals were untyped: `instanceof PermissionDenied` is false once the error has
  // crossed the ScopeDO hop, so a denial was read out of its message, and every conflict
  // was read out of a list of verbs (`frozen`, `already`, `cannot edit`) that the code
  // saying them had no idea it was on. Each throw site names its code now, so this reads
  // the code instead (#113 phase 4) — and `not published` moved from that 409 list to
  // the 404 it always was.
  app.onError((err, c) => problemResponse(c, err));

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
