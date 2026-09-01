/**
 * The three properties #936 moved out of ticket0's harness and into the host. They are
 * asserted HERE, on the platform's own mount, because that is the whole point of the
 * move: a vertical that mounts a public surface should not have to re-prove them.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { mountPublicSurface, type PublicServiceActor } from '../src/public-surface.js';
import { classifyError, messageOf } from '../src/errors.js';

const SITE = 'https://shop.example';
const OTHER = 'https://evil.example';

/** An actor that records every operation invoked through it, and as whom. */
function fakeActor(service: string, origins: readonly string[]) {
  const invoked: { operation: string; input: unknown; service: string }[] = [];
  const actor: PublicServiceActor = {
    invoke: async <T,>(operation: string, input: unknown) => {
      invoked.push({ operation, input, service });
      return { ok: true } as T;
    },
    allowedOrigins: origins,
  };
  return { actor, invoked };
}

/** The one surface every case here mounts: a `POST /widget/messages` and a `GET` beside it. */
function appWith(resolve: {
  origins?: () => readonly string[];
  service?: string;
  actorFor?: (service: string) => PublicServiceActor | null;
}) {
  const seen: { origin: string; service: string }[] = [];
  const invoked: { operation: string; input: unknown; service: string }[] = [];
  const app = new Hono();
  // The envelope a vertical already owns — the surface THROWS its refusals so they go
  // through it, exactly as every other refusal on that worker does. `mountPlatformSurface`
  // installs an equivalent one; this stands in for it here.
  app.onError((err, c) => {
    const seen = classifyError(err) ?? { status: 500 as const, message: messageOf(err) };
    return c.json({ error: seen.message }, seen.status);
  });
  const mounted = mountPublicSurface(app, {
    service: resolve.service ?? 'widget',
    basePath: '/widget',
    resolveActor: async (_c, request) => {
      seen.push({ origin: request.origin, service: request.service });
      if (resolve.actorFor) return resolve.actorFor(request.service);
      const built = fakeActor(request.service, resolve.origins?.() ?? [SITE]);
      // One shared log across every request, so a test can count writes.
      return {
        ...built.actor,
        invoke: async <T,>(operation: string, input: unknown) => {
          invoked.push({ operation, input, service: request.service });
          return { ok: true } as T;
        },
      };
    },
    routes: (route) => {
      route.post('/messages', async (c, { actor, origin, service }) => {
        const body = await c.req.json().catch(() => ({}));
        await actor.invoke('demo/post', body);
        return c.json({ origin, service });
      });
      route.get('/messages', async (c, { actor }) => c.json(await actor.invoke('demo/read', {})));
    },
  });
  return { app, seen, invoked, mounted };
}

describe('mountPublicSurface', () => {
  it('mounts the declared routes under the base path', () => {
    const { mounted } = appWith({});
    expect(mounted.routes).toEqual([
      { method: 'POST', path: '/widget/messages' },
      { method: 'GET', path: '/widget/messages' },
    ]);
    expect(mounted.service).toBe('widget');
  });

  it('refuses a base path that is not one', () => {
    expect(() =>
      mountPublicSurface(new Hono(), {
        service: 'widget',
        basePath: 'widget/',
        resolveActor: async () => null,
        routes: () => {},
      }),
    ).toThrow(/basePath/);
  });

  it('guards a route declared at the base path itself', async () => {
    // A one-route surface declares it at `'/'`, which is the bare base path — the one URL
    // a `${basePath}/*` guard could plausibly miss. It does not, and this is what keeps
    // that true: the route most likely to BE the whole surface must not be the one route
    // nothing checks. `resolveActor` is counted too, since the obvious over-correction
    // (registering the gate on the base path as well) makes every call round-trip twice.
    let resolved = 0;
    let invoked = 0;
    const app = new Hono();
    app.onError((err, c) => {
      const seen = classifyError(err) ?? { status: 500 as const, message: messageOf(err) };
      return c.json({ error: seen.message }, seen.status);
    });
    mountPublicSurface(app, {
      service: 'widget',
      basePath: '/widget',
      resolveActor: async () => {
        resolved += 1;
        return {
          invoke: async <T,>() => {
            invoked += 1;
            return { ok: true } as T;
          },
          allowedOrigins: [SITE],
        };
      },
      routes: (route) => {
        route.post('/', async (c, { actor }) => c.json(await actor.invoke('demo/root', {})));
      },
    });

    const refused = await app.request('/widget', { method: 'POST', headers: { origin: OTHER } });
    expect(refused.status).toBe(403);
    expect(invoked).toBe(0);

    resolved = 0;
    const ok = await app.request('/widget', { method: 'POST', headers: { origin: SITE } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(invoked).toBe(1);
    expect(resolved).toBe(1); // once, not once per registered guard

    const preflight = await app.request('/widget', { method: 'OPTIONS', headers: { origin: SITE } });
    expect(preflight.status).toBe(204);
  });

  // ── 1. Unauthenticated, and it runs as the declared service ─────────────────
  it('runs an unauthenticated call as the declared service principal', async () => {
    const { app, seen, invoked } = appWith({ service: 'widget' });
    const res = await app.request('/widget/messages', {
      method: 'POST',
      headers: { origin: SITE, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ origin: SITE, service: 'widget' });
    expect(seen).toEqual([{ origin: SITE, service: 'widget' }]);
    expect(invoked).toEqual([{ operation: 'demo/post', input: { body: 'hello' }, service: 'widget' }]);
  });

  it('does not let a caller-supplied credential select a different actor', async () => {
    // Nothing on the request may change WHO the surface acts as: the resolver is asked
    // for the same declared service whatever the visitor sends. A public surface that
    // could be talked into another principal is unauthenticated privilege, not a
    // public surface.
    const { app, seen, invoked } = appWith({ service: 'widget' });
    const res = await app.request('/widget/messages', {
      method: 'POST',
      headers: {
        origin: SITE,
        'content-type': 'application/json',
        authorization: 'Bearer an-admins-token',
        cookie: 'session=an-admins-session',
      },
      body: JSON.stringify({ body: 'hi' }),
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ origin: SITE, service: 'widget' }]);
    expect(invoked[0]?.service).toBe('widget');
  });

  // ── 2. A disallowed origin gets no header AND no write ──────────────────────
  it('refuses an unlisted origin before the handler — no allow-origin, and no write', async () => {
    const { app, invoked } = appWith({});
    const res = await app.request('/widget/messages', {
      method: 'POST',
      headers: { origin: OTHER, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'landed?' }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    // The point of refusing in middleware: CORS hides a response, it does not stop a
    // write. The operation must never have been invoked.
    expect(invoked).toEqual([]);
  });

  it('refuses a request with no Origin header at all', async () => {
    const { app, invoked } = appWith({});
    const res = await app.request('/widget/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(invoked).toEqual([]);
  });

  it('refuses when nothing answers for the origin', async () => {
    const { app } = appWith({ actorFor: () => null });
    const res = await app.request('/widget/messages', {
      method: 'POST',
      headers: { origin: SITE, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  // ── The preflight is answered from the same live allowlist ──────────────────
  it('answers the preflight itself, advertising exactly the methods it mounted', async () => {
    const { app } = appWith({});
    const res = await app.request('/widget/messages', {
      method: 'OPTIONS',
      headers: { origin: SITE, 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(res.headers.get('vary')).toBe('origin');
    const allowed = (res.headers.get('access-control-allow-methods') ?? '').split(', ').sort();
    expect(allowed).toEqual(['GET', 'OPTIONS', 'POST']);
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(res.headers.get('access-control-max-age')).toBe('600');
  });

  it('refuses the preflight of an unlisted origin with a bare 403', async () => {
    const { app } = appWith({});
    const res = await app.request('/widget/messages', {
      method: 'OPTIONS',
      headers: { origin: OTHER, 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  // ── 3. The allowlist is re-read per request, never cached ───────────────────
  it('re-reads the allowlist between two requests', async () => {
    // The reason this surface does not use `hono/cors`: its `origin` callback is
    // synchronous, so a list that lives in a scope has to be cached at boot — and the
    // cached copy disagreed with the live one the moment an admin edited it (#922).
    let origins: readonly string[] = [SITE];
    const { app } = appWith({ origins: () => origins });

    const first = await app.request('/widget/messages', {
      method: 'POST',
      headers: { origin: SITE, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(first.status).toBe(200);

    origins = []; // an admin removes the embed
    const second = await app.request('/widget/messages', {
      method: 'POST',
      headers: { origin: SITE, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(second.status).toBe(403);

    // …and the preflight follows the same live list, which is where it has to be true
    // first: a browser that cached a permissive preflight would never send the POST.
    const preflight = await app.request('/widget/messages', {
      method: 'OPTIONS',
      headers: { origin: SITE, 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(403);
  });
});
