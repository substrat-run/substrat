import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { invocationLog, type InvocationLogLine } from '../src/invocation-log.js';

/**
 * The middleware's whole output is a `console.log` line, so the suite captures the
 * console rather than asserting on a return value — the line IS the contract, and a
 * reader filters on its exact key names.
 */
function capture() {
  const lines: InvocationLogLine[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    const [first] = args;
    if (typeof first === 'string') {
      try {
        const parsed = JSON.parse(first);
        if (parsed?.substrat === 'invocation') lines.push(parsed);
        return;
      } catch {
        /* not ours — fall through */
      }
    }
    original(...(args as []));
  };
  return { lines, restore: () => void (console.log = original) };
}

const SECRET = 'router-sekret';
// Valid 26-char ULIDs (Crockford base32 — no I/L/O/U). The ids are PARSED now, so a
// placeholder string would be refused as a malformed assertion and write no line.
const TENANT = '01JZ0000000000000000TEN001';
const SCOPE = '01JZ0000000000000000SCP001';

/** The headers the router asserts on every dispatched request — signature included. */
const routed = {
  'x-substrat-router': SECRET,
  'x-substrat-tenant': TENANT,
  'x-substrat-scope': SCOPE,
  'x-substrat-vertical': 'acme/widgets',
  'x-substrat-surface': 'app',
};

type Env = { ROUTER_SECRET?: string; ALLOW_DEV_NODE?: string };
const ENV: Env = { ROUTER_SECRET: SECRET };

function appWith(handler: (app: Hono<{ Bindings: Env }>) => void) {
  const app = new Hono<{ Bindings: Env }>();
  app.use(
    '*',
    invocationLog<Env>({
      routerSecret: (env) => env.ROUTER_SECRET,
      allowUnsigned: (env) => env.ALLOW_DEV_NODE === 'true',
    }),
  );
  handler(app);
  return app;
}

describe('invocationLog', () => {
  it('stamps tenant and scope on a routed request', async () => {
    const cap = capture();
    try {
      const app = appWith((a) => a.get('/api/me', (c) => c.json({ ok: true })));
      const res = await app.request('/api/me', { headers: routed }, ENV);
      expect(res.status).toBe(200);
      expect(cap.lines).toHaveLength(1);
      expect(cap.lines[0]).toMatchObject({
        substrat: 'invocation',
        tenantId: TENANT,
        scopeId: SCOPE,
        vertical: 'acme/widgets',
        surface: 'app',
        method: 'GET',
        path: '/api/me',
        status: 200,
        threw: false,
      });
      // `toHaveLength` above does not narrow the index for the compiler, so name it.
      const [line] = cap.lines;
      expect(line?.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      cap.restore();
    }
  });

  /**
   * The rule that keeps the read side honest (§4.3): a line with no tenant is never
   * shown to a tenant, so a line with no tenant is never written. An un-routed local
   * invocation carries no asserted headers and there is no tenant it could belong to.
   */
  it('writes NO line when the request carries no asserted tenant', async () => {
    const cap = capture();
    try {
      const app = appWith((a) => a.get('/api/me', (c) => c.json({ ok: true })));
      await app.request('/api/me', {}, ENV);
      expect(cap.lines).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  /**
   * THE isolation test. K-26's boundary is that a vertical's script has no public route
   * — a deployment fact, with `workers.dev` on by default — so a header nobody signed is
   * a CLAIM, not an assertion. Writing the line from it meant anyone who could reach the
   * script could file their request under a tenant of their choosing, and the read path
   * treats a stamped line as proof that the invocation was that tenant's: it admits the
   * invocation's other lines, which carry no tenant of their own, into that tenant's
   * view. A forged stamp is chosen text on somebody else's dashboard.
   */
  it('writes NO line for an unsigned assertion, however complete it looks', async () => {
    const cap = capture();
    try {
      const app = appWith((a) => a.get('/api/me', (c) => c.json({ ok: true })));
      const { 'x-substrat-router': _signature, ...forged } = routed;
      await app.request('/api/me', { headers: forged }, ENV);
      expect(cap.lines).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  it('writes NO line when the signature is not this worker’s secret', async () => {
    const cap = capture();
    try {
      const app = appWith((a) => a.get('/api/me', (c) => c.json({ ok: true })));
      await app.request('/api/me', { headers: { ...routed, 'x-substrat-router': 'guessed' } }, ENV);
      expect(cap.lines).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  /**
   * #966's rule, now on this side too: a worker deployed without its secret cannot verify
   * anything, so it trusts nothing. The feature going quiet is the visible failure; the
   * alternative is an open door that looks like it is working.
   */
  it('writes NO line when this worker holds no secret to verify against', async () => {
    const cap = capture();
    try {
      const app = appWith((a) => a.get('/api/me', (c) => c.json({ ok: true })));
      await app.request('/api/me', { headers: routed }, {});
      expect(cap.lines).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  /** The one legitimate exception, and it is the vertical's own `ALLOW_DEV_NODE`. */
  it('accepts an unsigned assertion on an un-routed dev instance', async () => {
    const cap = capture();
    try {
      const app = appWith((a) => a.get('/api/me', (c) => c.json({ ok: true })));
      const { 'x-substrat-router': _signature, ...unsigned } = routed;
      await app.request('/api/me', { headers: unsigned }, { ALLOW_DEV_NODE: 'true' });
      expect(cap.lines).toHaveLength(1);
      expect(cap.lines[0]).toMatchObject({ tenantId: TENANT, scopeId: SCOPE });
    } finally {
      cap.restore();
    }
  });

  /** An id that is not a ULID is not an id — the same refusal `readRoutedNode` makes. */
  it('writes NO line for a malformed id, and never fails the request for it', async () => {
    const cap = capture();
    try {
      const app = appWith((a) => a.get('/api/me', (c) => c.json({ ok: true })));
      const res = await app.request('/api/me', { headers: { ...routed, 'x-substrat-tenant': 'not-a-ulid' } }, ENV);
      // The request is answered exactly as it would have been — logging fails closed and
      // silently, never by turning a 200 into an error.
      expect(res.status).toBe(200);
      expect(cap.lines).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  /**
   * The credential-leak guard. An OIDC vertical's query strings carry `code`, `state`
   * and single-use tokens; the platform's own internal calls carry tenant and scope ids.
   * None of it may reach a log store read by a wider audience than the request had.
   */
  it('never records the query string', async () => {
    const cap = capture();
    try {
      const app = appWith((a) => a.get('/callback', (c) => c.text('ok')));
      await app.request('/callback?code=SECRET_AUTH_CODE&state=xyz', { headers: routed }, ENV);
      const [line] = cap.lines;
      expect(line?.path).toBe('/callback');
      // Assert on the WHOLE serialized line, not just `path`: the guarantee is that the
      // secret is absent from the record, not merely from the field we remembered to check.
      expect(JSON.stringify(line)).not.toContain('SECRET_AUTH_CODE');
      expect(JSON.stringify(line)).not.toContain('state');
    } finally {
      cap.restore();
    }
  });

  /**
   * A throw still produces a line — that invocation is exactly the one a tenant is
   * looking for — and it carries the status `onError` MAPPED the error to, because Hono
   * composes the error handler inside the chain rather than around it. Pinned as a test
   * because the opposite is the natural guess, and guessing it would have put `null` on
   * every error line.
   */
  it('records the status onError mapped a throw to', async () => {
    const cap = capture();
    try {
      const boom = new Error('kaboom');
      const app = appWith((a) =>
        a.get('/api/explode', () => {
          throw boom;
        }),
      );
      let seen: unknown;
      app.onError((err, c) => {
        seen = err;
        return c.json({ error: 'mapped' }, 500);
      });
      const res = await app.request('/api/explode', { headers: routed }, ENV);
      expect(res.status).toBe(500);
      // The envelope still got the original error — the middleware swallowed nothing.
      expect(seen).toBe(boom);
      expect(cap.lines[0]).toMatchObject({ status: 500, threw: false, path: '/api/explode' });
    } finally {
      cap.restore();
    }
  });

  /** A vertical's own output is unstamped; correlation is by request id, not by content. */
  it('does not disturb a vertical’s own console output', async () => {
    const cap = capture();
    try {
      const app = appWith((a) =>
        a.get('/api/noisy', (c) => {
          console.log('a vertical said something');
          return c.text('ok');
        }),
      );
      await app.request('/api/noisy', { headers: routed }, ENV);
      // Exactly one INVOCATION line; the vertical's own line passed through untouched.
      expect(cap.lines).toHaveLength(1);
    } finally {
      cap.restore();
    }
  });
});
