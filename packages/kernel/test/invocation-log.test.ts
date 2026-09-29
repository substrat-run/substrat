import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  INVOCATION_RECORD_KEY,
  invocationLevelOf,
  invocationLog,
  type InvocationLogLine,
  type InvocationRecord,
  invocationStampOf,
  withInvocationLog,
} from '../src/invocation-log.js';

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

  // #1746: the per-request record.
  describe('the per-request record (#1746)', () => {
    type RecordEnv = Env & { SUBSTRAT_VERSION_ID?: string };
    const recordApp = (fill: (record: InvocationRecord) => void, status = 200) => {
      const app = new Hono<{ Bindings: RecordEnv; Variables: { [INVOCATION_RECORD_KEY]: InvocationRecord } }>();
      app.use('*', invocationLog<RecordEnv>({ routerSecret: (env) => env.ROUTER_SECRET }));
      app.post('/api/things', (c) => {
        fill(c.get(INVOCATION_RECORD_KEY));
        return c.json({}, status as 200);
      });
      return app;
    };

    it('writes what the handler chain filled in, with distinct types and entities', async () => {
      const cap = capture();
      try {
        const app = recordApp((r) => {
          r.operation = 'things/create';
          r.principalKind = 'principal';
          r.emitted = {
            events: [
              { type: 'thing.created', entity: 'thing:1' },
              { type: 'thing.noted', entity: 'thing:1' },
              { type: 'thing.created', entity: 'thing:2' },
            ],
            total: 30,
          };
        });
        await app.request('/api/things', { method: 'POST', headers: routed }, { ...ENV, SUBSTRAT_VERSION_ID: 'v-1' });
        expect(cap.lines[0]).toMatchObject({
          level: 'info',
          operation: 'things/create',
          problemCode: null,
          principalKind: 'principal',
          eventCount: 30,
          eventTypes: ['thing.created', 'thing.noted'],
          entities: ['thing:1', 'thing:2'],
          versionId: 'v-1',
        });
      } finally {
        cap.restore();
      }
    });

    it('writes null, never a guess, for what nothing filled in', async () => {
      const cap = capture();
      try {
        await recordApp(() => {}).request('/api/things', { method: 'POST', headers: routed }, ENV);
        expect(cap.lines[0]).toMatchObject({
          level: 'info',
          operation: null,
          problemCode: null,
          principalKind: null,
          // Not 0: nobody said the call emitted nothing.
          eventCount: null,
          eventTypes: [],
          entities: [],
          versionId: null,
        });
      } finally {
        cap.restore();
      }
    });

    it('files a refused call as a warning, with its code', async () => {
      const cap = capture();
      try {
        const app = recordApp((r) => {
          r.operation = 'things/create';
          r.problemCode = 'permission_denied';
        }, 403);
        await app.request('/api/things', { method: 'POST', headers: routed }, ENV);
        expect(cap.lines[0]).toMatchObject({ level: 'warn', status: 403, problemCode: 'permission_denied' });
      } finally {
        cap.restore();
      }
    });
  });

  it('derives the level from how the call ended', () => {
    expect(invocationLevelOf(200, false)).toBe('info');
    expect(invocationLevelOf(404, false)).toBe('warn');
    expect(invocationLevelOf(502, false)).toBe('error');
    expect(invocationLevelOf(null, true)).toBe('error');
    // An in-band failure — an MCP tool error answers 200.
    expect(invocationLevelOf(200, false, 'permission_denied')).toBe('warn');
  });

  // #1893: the platform stamps the request itself, by wrapping the deployed entry.
  describe('withInvocationLog — the platform’s stamp (#1893)', () => {
    const options = { routerSecret: (env: Env) => env.ROUTER_SECRET };
    const request = (path = '/api/things', init: RequestInit = {}) =>
      new Request(`https://acme.example${path}`, { ...init, headers: { ...routed, ...(init.headers as Record<string, string> | undefined) } });

    it('a line that cannot be written never changes the answer or the error', async () => {
      const original = console.log;
      console.log = () => {
        throw new Error('console is gone');
      };
      try {
        const ok = withInvocationLog<Env>({ fetch: async () => new Response('ok', { status: 201 }) }, options);
        expect((await ok.fetch!(request(), ENV, {})).status).toBe(201);
        const boom = new Error('the vertical failed');
        const failing = withInvocationLog<Env>({ fetch: async () => { throw boom; } }, options);
        await expect(failing.fetch!(request(), ENV, {})).rejects.toBe(boom);
      } finally {
        console.log = original;
      }
    });

    it('stamps a worker that mounts nothing, whatever it is written in', async () => {
      const cap = capture();
      try {
        const worker = withInvocationLog<Env>({ fetch: async () => new Response('ok', { status: 201 }) }, options);
        const res = await worker.fetch!(request(), ENV, {});
        expect(res.status).toBe(201);
        expect(cap.lines).toHaveLength(1);
        expect(cap.lines[0]).toMatchObject({ substrat: 'invocation', tenantId: TENANT, scopeId: SCOPE, status: 201, threw: false, level: 'info', path: '/api/things' });
      } finally {
        cap.restore();
      }
    });

    it('writes ONE line when the vertical also mounts the middleware — and hands the chain the platform’s stamp', async () => {
      const cap = capture();
      try {
        let seen: InvocationRecord | undefined;
        const app = new Hono<{ Bindings: Env; Variables: { [INVOCATION_RECORD_KEY]: InvocationRecord } }>();
        app.use('*', invocationLog<Env>(options));
        app.post('/api/things', (c) => {
          seen = c.get(INVOCATION_RECORD_KEY);
          seen.operation = 'things/create';
          return c.json({}, 201);
        });
        const req = request('/api/things', { method: 'POST' });
        await withInvocationLog<Env>(app as never, options).fetch!(req, ENV, {});
        expect(cap.lines).toHaveLength(1);
        // The record the route filled is the one the platform's line was written from.
        expect(seen).toBe(invocationStampOf(req)!.record);
        expect(cap.lines[0]).toMatchObject({ operation: 'things/create', status: 201, invocationId: invocationStampOf(req)!.invocationId });
      } finally {
        cap.restore();
      }
    });

    it('records a throw as an error and re-throws it untouched', async () => {
      const cap = capture();
      try {
        const boom = new Error('boom');
        const worker = withInvocationLog<Env>({ fetch: async () => { throw boom; } }, options);
        await expect(worker.fetch!(request(), ENV, {})).rejects.toBe(boom);
        expect(cap.lines[0]).toMatchObject({ status: null, threw: true, level: 'error' });
      } finally {
        cap.restore();
      }
    });

    it('writes nothing for a request the router did not sign', async () => {
      const cap = capture();
      try {
        const worker = withInvocationLog<Env>({ fetch: async () => new Response('ok') }, options);
        await worker.fetch!(new Request('https://acme.example/x', { headers: { 'x-substrat-tenant': TENANT } }), ENV, {});
        expect(cap.lines).toEqual([]);
      } finally {
        cap.restore();
      }
    });

    it('passes the other handlers through, bound to the worker, and leaves a worker with no fetch alone', async () => {
      const worker = {
        marker: 'me',
        fetch: async () => new Response('ok'),
        scheduled(this: { marker: string }) {
          return this.marker;
        },
      };
      const wrapped = withInvocationLog<Env>(worker as never, options);
      expect((wrapped['scheduled'] as () => string)()).toBe('me');
      const noFetch = { queue: () => 1 };
      expect(withInvocationLog<Env>(noFetch as never, options)).toBe(noFetch);
    });
  });
});

// #1904: the router meters the request with the vertical's record, carried on one header.
describe('withInvocationLog — the record handed back to the router (#1904)', () => {
  const options = { routerSecret: (env: Env) => env.ROUTER_SECRET };
  const HEADER = 'x-substrat-invocation-record';
  /** A worker whose handler fills the record the way `mountOperations` does. */
  const operationWorker = (fill: InvocationRecord, response = () => new Response('ok')) =>
    withInvocationLog<Env>(
      {
        fetch: async (req) => {
          Object.assign(invocationStampOf(req)!.record, fill);
          return response();
        },
      },
      options,
    );
  const quiet = () => {
    const cap = capture();
    return cap;
  };

  it('carries operation, problem code and principal kind on a routed request', async () => {
    const cap = quiet();
    try {
      const res = (await operationWorker({ operation: 'tickets/close', problemCode: 'conflict', principalKind: 'user' }).fetch!(
        new Request('https://acme.example/api/x', { headers: routed }),
        ENV,
        {},
      )) as Response;
      const carried = new URLSearchParams(res.headers.get(HEADER)!);
      expect(Object.fromEntries(carried)).toEqual({ operation: 'tickets/close', problemCode: 'conflict', principalKind: 'user' });
    } finally {
      cap.restore();
    }
  });

  it('never carries it to a caller the router did not vouch for', async () => {
    const cap = quiet();
    try {
      const { 'x-substrat-router': _signature, ...unsigned } = routed;
      const res = (await operationWorker({ operation: 'tickets/close' }).fetch!(
        new Request('https://acme.example/api/x', { headers: unsigned }),
        ENV,
        {},
      )) as Response;
      expect(res.headers.get(HEADER)).toBeNull();
    } finally {
      cap.restore();
    }
  });

  it('carries nothing when no operation ran, and survives immutable headers', async () => {
    const cap = quiet();
    try {
      const plain = (await operationWorker({}).fetch!(new Request('https://acme.example/', { headers: routed }), ENV, {})) as Response;
      expect(plain.headers.get(HEADER)).toBeNull();

      // A response passed straight through from a fetch has immutable headers.
      const frozen = new Response('asset', { status: 203 });
      Object.defineProperty(frozen, 'headers', {
        value: { set: () => { throw new TypeError('immutable'); }, get: () => null },
      });
      const res = await operationWorker({ operation: 'tickets/close' }, () => frozen).fetch!(
        new Request('https://acme.example/', { headers: routed }),
        ENV,
        {},
      );
      expect(res.status).toBe(203);
      expect(cap.lines).toHaveLength(2);
    } finally {
      cap.restore();
    }
  });
});

// #1331: the field walk's report rides the line when a mount filled it — and only then.
describe('the line’s outputFields (#1331)', () => {
  const lineFor = async (fill: InvocationRecord) => {
    const cap = capture();
    try {
      const worker = withInvocationLog<Env>(
        {
          fetch: async (req) => {
            Object.assign(invocationStampOf(req)!.record, fill);
            return new Response('ok');
          },
        },
        { routerSecret: (env) => env.ROUTER_SECRET },
      );
      await worker.fetch!(new Request('https://acme.example/api/x', { headers: routed }), ENV, {});
      expect(cap.lines).toHaveLength(1);
      return cap.lines[0]!;
    } finally {
      cap.restore();
    }
  };

  it('carries the report a mount filled in', async () => {
    const line = await lineFor({ operation: 'acme/op', outputFields: { present: ['id'], absent: ['note'] } });
    expect(line.outputFields).toEqual({ present: ['id'], absent: ['note'] });
  });

  it('omits the key — not null — when nothing was walked, so an unarmed line is unchanged', async () => {
    const line = await lineFor({ operation: 'acme/op' });
    expect(Object.keys(line)).toEqual([
      'substrat', 'tenantId', 'scopeId', 'vertical', 'surface', 'method', 'path', 'status', 'threw',
      'durationMs', 'invocationId', 'level', 'operation', 'problemCode', 'principalKind', 'eventCount',
      'eventTypes', 'entities', 'versionId',
    ]);
  });
});
