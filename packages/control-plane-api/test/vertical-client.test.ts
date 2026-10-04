import { describe, it, expect } from 'vitest';
import { platformActorId, tenantId, scopeId } from '@substrat-run/contracts';
import { runPlatformSweep, ulid, type ScopeHost } from '@substrat-run/kernel';
import { VerticalClient, ControlPlaneError } from '../src/index.js';

/**
 * The transport seam (#391): a dispatch/cold-start REJECTION (the fetch itself throws)
 * is not a vertical's answer — before the fix it propagated raw and the API boundary
 * collapsed it to the generic 500 "internal error". It must surface as a 502 naming the
 * verb and the runtime's own message, while a non-ok RESPONSE keeps passing through as
 * the vertical's own status.
 */

const t = tenantId.parse(ulid());
const s = scopeId.parse(ulid());

/**
 * #2010: the answers a deployment that HAS a route can give and then lose part of — a 200
 * whose body is truncated JSON, or whose stream fails mid-read. And two HTML pages no client
 * can tell apart (Codex #2014 r1): the app shell an old deployment's asset layer serves for a
 * path it does not route, and an error page from something in between after a switch that
 * moved. Neither proves the route is absent; only a status does.
 */
const html = (body: string) => () =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const spaShell = html(
  '<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>Desk</title>' +
    '<script type="module" crossorigin src="/assets/index-Bx1.js"></script></head><body><div id="root"></div></body></html>',
);
const gatewayPage = html('<!doctype html><html><body>Gateway timeout after upstream response</body></html>');
const truncated = (body: string) => () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
const brokenStream = () =>
  new Response(new ReadableStream({ start: (c) => c.error(new Error('stream reset')) }), { status: 200 });

const rejecting = (message: string) =>
  new VerticalClient({
    fetch: (() => Promise.reject(new Error(message))) as unknown as typeof fetch,
    platformSecret: 'secret',
  });

it('deleteScope sends the tenant with the scope to the vertical (#1802)', async () => {
  let body: unknown;
  const client = new VerticalClient({
    fetch: (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
    platformSecret: 'secret',
  });
  await client.deleteScope({ tenantId: t, scopeId: s });
  expect(body).toEqual({ tenantId: t, scopeId: s });
});

it('normalizes pre-metrics migration replies without discarding recorded values', async () => {
  const urls: string[] = [];
  const replies = [
    [{ moduleId: 'acme', version: '0001', appliedAt: '2026-01-01T00:00:00.000Z' }],
    [{ moduleId: 'acme', version: '0002', appliedAt: '2026-02-01T00:00:00.000Z', durationMs: 42, rowsChanged: 7 }],
  ];
  const client = new VerticalClient({
    fetch: (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(replies.shift()), { status: 200 });
    }) as unknown as typeof fetch,
    platformSecret: 'secret',
  });
  expect(await client.appliedMigrations(s)).toEqual([
    { moduleId: 'acme', version: '0001', appliedAt: '2026-01-01T00:00:00.000Z', durationMs: null, rowsChanged: null },
  ]);
  expect(await client.appliedMigrations(s)).toEqual([
    { moduleId: 'acme', version: '0002', appliedAt: '2026-02-01T00:00:00.000Z', durationMs: 42, rowsChanged: 7 },
  ]);
  expect(urls.every((url) => url.includes(`/internal/migrations?scopeId=${s}`))).toBe(true);
});

describe('VerticalClient.listCapabilities (#1686)', () => {
  const record = {
    mode: 'act',
    id: ulid(),
    label: 'client review',
    mintedBy: ulid(),
    mintedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: null,
    maxUses: null,
    uses: 0,
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    entity: { entityType: 'folder', entityId: 'F1' },
    permissions: ['doc:read'],
    operations: null,
  };
  const clientAnswering = (body: unknown, urls: string[] = []) =>
    new VerticalClient({
      fetch: (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });

  it('sends the scope and the filter in the one encoding, and returns the records', async () => {
    const urls: string[] = [];
    const rows = await clientAnswering({ entries: [record], nextCursor: record.id }, urls).listCapabilities(s, {
      entity: { entityType: 'folder', entityId: 'F1' },
      includeRevoked: true,
      limit: 5,
      cursor: record.id as never,
    });
    expect(rows).toEqual({ entries: [record], nextCursor: record.id });
    const url = new URL(urls[0]!, 'http://x');
    expect(url.pathname).toBe('/internal/capabilities');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      scopeId: s,
      entityType: 'folder',
      entityId: 'F1',
      includeRevoked: 'true',
      limit: '5',
      cursor: record.id,
    });
  });

  // The platform parses on arrival, so a vertical that answers with more than the record —
  // an older build selecting `*`, say — cannot pass a hash through the control plane.
  it('drops anything but the record: a hash a vertical sent never reaches the caller', async () => {
    const hash = 'ab'.repeat(32);
    const rows = await clientAnswering({
      entries: [{ ...record, token_hash: hash, tokenHash: hash }],
      nextCursor: null,
      token_hash: hash,
    }).listCapabilities(s);
    expect(rows).toEqual({ entries: [record], nextCursor: null });
    expect(JSON.stringify(rows)).not.toContain(hash);
  });

  it('refuses a shape that is not a record rather than relaying it', async () => {
    await expect(clientAnswering({ entries: [{ id: 'x' }], nextCursor: null }).listCapabilities(s)).rejects.toThrow();
    // …and so is a bare array, the shape this read had before it paged.
    await expect(clientAnswering([record]).listCapabilities(s)).rejects.toThrow();
  });
});

describe('VerticalClient — transport rejections become diagnosable 502s (#391)', () => {
  it('configureInstance: a thrown fetch is a 502 naming the verb and the cause', async () => {
    const err = await rejecting('Worker threw exception')
      .configureInstance({ tenantId: t, scopeId: s, entries: [{ key: 'k', value: 'v' }] })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).status).toBe(502);
    expect((err as ControlPlaneError).message).toBe(
      'vertical unreachable during configure: Worker threw exception',
    );
  });

  it('provisionInstance and introspection reads wrap the same way', async () => {
    const client = rejecting('Durable Object reset');
    await expect(
      client.provisionInstance({ tenantId: t, scopeId: s, owner: 'o' as never, slug: 'x', name: 'X' }),
    ).rejects.toThrow(/vertical unreachable during provisioning: Durable Object reset/);
    await expect(client.listScopeTables(s)).rejects.toThrow(
      /vertical unreachable during introspection: Durable Object reset/,
    );
  });

  /**
   * The outbound attachment read (#711). Two halves — this client and
   * `mountPlatformSurface`'s `GET /internal/connector-attachment/:id` — have to
   * agree on a wire format that is deliberately NOT JSON: bytes in the body, the
   * record in a header, because a contract is megabytes and base64 would inflate
   * and re-encode it on both ends. A format nobody tests is a format that drifts.
   */
  describe('connectorOpenAttachment (#711)', () => {
    const bytes = new TextEncoder().encode('%PDF-1.4 the avtal');
    const record = {
      id: 'att-1',
      entity: { entityType: 'protocol', entityId: 'p1' },
      filename: 'avtal.pdf',
      contentType: 'application/pdf',
      size: bytes.byteLength,
      sha256: 'a'.repeat(64),
      visibility: 'customer',
      createdBy: '01JCONN0000000000000000000',
      createdAt: '2026-08-17T00:00:00.000Z',
    };
    const args = {
      connectionId: '01JCONN0000000000000000000' as never,
      tenantId: t,
      scopeId: s,
      attachmentId: 'att-1',
    };

    it('reads the bytes from the body and the record from the header', async () => {
      let url = '';
      const client = new VerticalClient({
        fetch: (async (u: string) => {
          url = u;
          return new Response(bytes, {
            status: 200,
            headers: {
              'content-type': 'application/pdf',
              'x-substrat-attachment': JSON.stringify(record),
            },
          });
        }) as unknown as typeof fetch,
        platformSecret: 'secret',
      });

      const opened = await client.connectorOpenAttachment(args);
      expect(new TextDecoder().decode(opened!.body)).toBe('%PDF-1.4 the avtal');
      expect(opened!.record.filename).toBe('avtal.pdf');
      expect(opened!.contentType).toBe('application/pdf');
      // The id rides the PATH and is encoded — an id with a slash in it must not
      // silently become a different route.
      expect(url).toContain('/internal/connector-attachment/att-1?');
      expect(url).toContain(`scopeId=${s}`);
    });

    it('answers null on 404, so a connector falls back rather than failing', async () => {
      const client = new VerticalClient({
        fetch: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
        platformSecret: 'secret',
      });
      await expect(client.connectorOpenAttachment(args)).resolves.toBeNull();
    });

    it('refuses bytes that arrive without the record that witnesses them', async () => {
      // The header carries the sha256 the far end checked the bytes against. A 200
      // without it is a wire-format disagreement, and treating the body as good
      // anyway would send unverified bytes to a signatory.
      const client = new VerticalClient({
        fetch: (async () =>
          new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } })) as unknown as typeof fetch,
        platformSecret: 'secret',
      });
      await expect(client.connectorOpenAttachment(args)).rejects.toThrow(/x-substrat-attachment/);
    });

    it("a refusal is still the vertical's own answer", async () => {
      const client = new VerticalClient({
        fetch: (async () =>
          new Response(JSON.stringify({ error: 'permission denied: protocol:read' }), {
            status: 403,
          })) as unknown as typeof fetch,
        platformSecret: 'secret',
      });
      await expect(client.connectorOpenAttachment(args)).rejects.toThrow(/protocol:read/);
    });
  });

  it("a non-ok RESPONSE is still the vertical's own answer, not a 502", async () => {
    const client = new VerticalClient({
      fetch: (async () =>
        new Response(JSON.stringify({ error: 'no live-config support' }), { status: 501 })) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    const err = await client
      .configureInstance({ tenantId: t, scopeId: s, entries: [] })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect((err as ControlPlaneError).status).toBe(501);
    expect((err as ControlPlaneError).message).toBe('no live-config support');
  });
});

/**
 * #424 case 1: the vertical's error body IS the diagnosis, whatever its shape. The
 * authhero-auth-core install failure answered a plain-text 503 whose body said exactly
 * what was wrong — and the old `res.json().catch(() => null)` dropped it, surfacing only
 * "vertical refused provisioning: 503 Service Unavailable". Any non-empty body must
 * survive to the operator.
 */
describe('VerticalClient — refusal bodies surface verbatim (#424)', () => {
  const answering = (status: number, body: string, statusText = '') =>
    new VerticalClient({
      fetch: (async () => new Response(body, { status, statusText })) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
  const provisionErr = async (client: VerticalClient) =>
    client
      .provisionInstance({ tenantId: t, scopeId: s, owner: 'o' as never, slug: 'x', name: 'X' })
      .then(() => undefined)
      .catch((e: unknown) => e as ControlPlaneError);

  it('a plain-text body is the message, prefixed with the verb + status', async () => {
    const err = await provisionErr(
      answering(503, 'no tenant store attached for t-x (binding AUTH_DB_TX) — provision first'),
    );
    expect(err!.status).toBe(503);
    expect(err!.message).toBe(
      'vertical refused provisioning (503): no tenant store attached for t-x (binding AUTH_DB_TX) — provision first',
    );
  });

  it('a JSON {error} body still passes through bare (the existing contract)', async () => {
    const err = await provisionErr(answering(403, JSON.stringify({ error: 'not a platform call' })));
    expect(err!.message).toBe('not a platform call');
  });

  it('JSON of any OTHER shape surfaces as its raw text rather than being dropped', async () => {
    const err = await provisionErr(answering(500, JSON.stringify({ message: 'boom', code: 7 })));
    expect(err!.message).toBe('vertical refused provisioning (500): {"message":"boom","code":7}');
  });

  it('only a genuinely empty body falls back to the status line', async () => {
    const err = await provisionErr(answering(503, '', 'Service Unavailable'));
    expect(err!.message).toBe('vertical refused provisioning: 503 Service Unavailable');
  });

  it('an oversized body is truncated, not dropped', async () => {
    const err = await provisionErr(answering(500, 'x'.repeat(2000)));
    expect(err!.message.length).toBeLessThan(600);
    expect(err!.message).toContain('x'.repeat(100));
  });
});

/**
 * #426 half 2: the SUCCESS body matters too. A vertical may report non-secret first-run
 * facts (a minted client id, migrations applied) alongside its ack — before this, the
 * body's only reader was the JSON parse and everything beyond the ack died with the
 * response. Extra fields become `result`; secret-shaped keys are dropped as a backstop
 * (credentials flow IN via `config`, never back out).
 */
describe('VerticalClient — the provision SUCCESS body becomes `result` (#426)', () => {
  const provisionWith = (body: unknown) =>
    new VerticalClient({
      fetch: (async () => new Response(JSON.stringify(body), { status: 201 })) as unknown as typeof fetch,
      platformSecret: 'secret',
    }).provisionInstance({ tenantId: t, scopeId: s, owner: 'o' as never, slug: 'x', name: 'X' });

  it('a bare ack yields no result at all', async () => {
    const out = await provisionWith({ tenantId: t, scopeId: s, owner: 'o' });
    expect(out).toEqual({ tenantId: t, scopeId: s, owner: 'o' });
    expect('result' in out).toBe(false);
  });

  it('extra top-level primitives and an explicit `result` object both ride, stringified', async () => {
    const out = await provisionWith({
      tenantId: t, scopeId: s, owner: 'o',
      clientId: 'client-abc',
      migrationsApplied: 7,
      result: { adminPath: '/admin', ready: true },
    });
    expect(out.result).toEqual({
      clientId: 'client-abc',
      migrationsApplied: '7',
      adminPath: '/admin',
      ready: 'true',
    });
  });

  it('secret-shaped keys are dropped, wherever they appear', async () => {
    const out = await provisionWith({
      tenantId: t, scopeId: s, owner: 'o',
      adminPassword: 'oops',
      clientSecret: 'oops',
      result: { apiToken: 'oops', privateKey: 'oops', clientId: 'kept' },
    });
    expect(out.result).toEqual({ clientId: 'kept' });
  });

  it('objects, arrays and nulls never ride — the result is flat strings only', async () => {
    const out = await provisionWith({
      tenantId: t, scopeId: s, owner: 'o',
      nested: { a: 1 }, list: [1, 2], nothing: null, clientId: 'kept',
    });
    expect(out.result).toEqual({ clientId: 'kept' });
  });

  it('the ack echoes the INPUT identifiers, not whatever the body claims', async () => {
    const out = await provisionWith({ tenantId: 'forged', scopeId: 'forged', owner: 'forged' });
    expect(out.tenantId).toBe(t);
    expect(out.scopeId).toBe(s);
    expect(out.owner).toBe('o');
  });
});

/**
 * #1545: the count and the reopen are different PATHS, not one path with a flag.
 *
 * The far end is the tenant's own deployment, shipped on its own clock, so it is routinely
 * older than this client. A `countOnly` field would be stripped by its Zod boundary and the
 * reopen would run — answering with a number shaped exactly like the count that was asked
 * for, during the one run whose whole promise is that it changes nothing. A path an older
 * deployment does not serve answers 404, which throws here, with the rows untouched.
 */
describe('VerticalClient — a redrain count never reaches the reopen (#1545)', () => {
  const drainedBefore = '2026-09-16T00:00:00.000Z';
  const spy = (answer: (path: string) => Response) => {
    const paths: string[] = [];
    const client = new VerticalClient({
      fetch: (async (u: string) => {
        paths.push(new URL(u).pathname);
        return answer(new URL(u).pathname);
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    return { client, paths };
  };

  it('asks the count route and reads `redrainable`', async () => {
    const { client, paths } = spy(() => new Response(JSON.stringify({ redrainable: 11 }), { status: 200 }));
    await expect(client.redrainEvents(s, drainedBefore, true)).resolves.toBe(11);
    expect(paths).toEqual(['/internal/redrain-count']);
  });

  it('without the flag it is the reopen, unchanged', async () => {
    const { client, paths } = spy(() => new Response(JSON.stringify({ redrained: 3 }), { status: 200 }));
    await expect(client.redrainEvents(s, drainedBefore)).resolves.toBe(3);
    expect(paths).toEqual(['/internal/redrain-events']);
  });

  it('a deployment that does not serve the count refuses, and nothing falls back to the reopen', async () => {
    const { client, paths } = spy((p) =>
      p === '/internal/redrain-count'
        ? new Response('404 Not Found', { status: 404 })
        : new Response(JSON.stringify({ redrained: 5000 }), { status: 200 }),
    );
    await expect(client.redrainEvents(s, drainedBefore, true)).rejects.toThrow(/404/);
    expect(paths).toEqual(['/internal/redrain-count']);
  });
});

/**
 * #1636: the Tier-2 read asks the vertical for what it stepped over, and has to take either
 * answer — a vertical deployed before `withSkipped` ignores the parameter and sends the bare
 * array, which must read as "said nothing about skips", never as a failure.
 */
describe('VerticalClient — the drain read carries the skip across the hop (#1636)', () => {
  const answering = (body: unknown, seen: string[] = []) =>
    new VerticalClient({
      fetch: (async (input: string) => {
        seen.push(input);
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });

  it('asks for the skip, and attaches it to the array it returns', async () => {
    const seen: string[] = [];
    const events = [{ id: 'e2' }];
    const read = await answering({ events, skipped: { count: 1, eventIds: ['e1'] } }, seen).undrainedEvents(s, 50);
    expect(seen[0]).toContain('withSkipped=1');
    expect([...read]).toEqual(events);
    expect(read.skipped).toEqual({ count: 1, eventIds: ['e1'] });
  });

  it('a clean read, and an older vertical’s bare array, both come back with no skip at all', async () => {
    const events = [{ id: 'e2' }];
    const clean = await answering({ events }).undrainedEvents(s, 50);
    expect([...clean]).toEqual(events);
    expect(clean.skipped).toBeUndefined();
    const old = await answering(events).undrainedEvents(s, 50);
    expect([...old]).toEqual(events);
    expect(old.skipped).toBeUndefined();
  });
});

/**
 * #1641: the control plane is the last side before the append-only lake, and a hosted
 * scope's events arrive from whatever adapter version its vertical was pushed with. A
 * vertical older than #1636 answers with the bare array and copies its lifted columns
 * unvalidated — so the sweep parses every event it received with the published schema, and
 * one that fails never ships and is counted. Driven end to end: the real `VerticalClient`,
 * answering as that old vertical would, behind the real `runPlatformSweep`.
 */
describe('VerticalClient → runPlatformSweep — an old vertical’s unvalidated event never reaches the lake (#1641)', () => {
  const staff = platformActorId.parse(ulid());
  const event = (over: Record<string, unknown> = {}) => ({
    id: ulid(),
    type: 'test.happened',
    schemaVersion: 1,
    occurredAt: '2026-09-01T00:00:00.000Z',
    tenantId: t,
    scopeId: s,
    actor: ulid(),
    entity: { entityType: 'thing', entityId: 'x1' },
    piiClass: 'none',
    payload: { ok: true },
    operation: null,
    version: null,
    causedBy: null,
    invocationId: null,
    ...over,
  });

  async function sweepOver(served: unknown[]) {
    // What a pre-#1636 vertical sends: the bare array, whatever `withSkipped` asked for.
    const client = new VerticalClient({
      fetch: (async () => new Response(JSON.stringify(served), { status: 200 })) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    const shipped: { id: string }[] = [];
    const marked: string[] = [];
    const host = {
      admin: {
        listScopes: async () => [{ id: s, tenantId: t, status: 'active' }],
        listConnections: async () => [],
        readUndrainedEvents: async (_a: unknown, _t: unknown, scope: typeof s, limit: number) =>
          client.undrainedEvents(scope, limit),
        markEventsDrained: async (_a: unknown, _t: unknown, _s: unknown, ids: string[]) => {
          marked.push(...ids);
          return ids.length;
        },
      },
      drainDue: async () => ({ attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 }),
    } as unknown as ScopeHost;
    const report = await runPlatformSweep(host, {
      actor: staff,
      fetch: (() => Promise.reject(new Error('unused'))) as never,
      sweepers: {},
      eventSink: {
        ship: async (_scope, events) => {
          shipped.push(...(events as { id: string }[]));
          return { ref: 'lake' };
        },
      },
    });
    return { report, shipped: shipped.map((e) => e.id), marked };
  }

  it('refuses the corrupt event, ships its clean twin, and counts it in the report', async () => {
    const clean = event();
    const corrupt = event({ version: '' });
    const { report, shipped, marked } = await sweepOver([corrupt, clean]);
    expect(shipped).toEqual([clean.id]);
    expect(marked).toEqual([clean.id]);
    expect(report.eventDrain!.skipped).toEqual([{ tenantId: t, scopeId: s, count: 1, eventIds: [corrupt.id] }]);
  });

  it('an old vertical’s clean answer ships whole, with nothing reported skipped — the positive twin', async () => {
    const both = [event(), event()];
    const { report, shipped } = await sweepOver(both);
    expect(shipped).toEqual(both.map((e) => e.id));
    expect(report.eventDrain).not.toHaveProperty('skipped');
  });
});

/**
 * #1524: a scope's database size, read through the deployment that holds it. The answer
 * lands in a sum, so anything that is not a size must throw here rather than read as 0,
 * which would pass for a real, small scope.
 */
describe('VerticalClient — database size (#1524)', () => {
  const answering = (status: number, body: string, seen: string[] = []) =>
    new VerticalClient({
      fetch: (async (input: string) => {
        seen.push(input);
        return new Response(body, { status });
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });

  it('asks the database-size route for the scope and reads `bytes`', async () => {
    const seen: string[] = [];
    await expect(answering(200, JSON.stringify({ bytes: 8192 }), seen).databaseSize(s)).resolves.toBe(8192);
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!).pathname).toBe('/internal/database-size');
    expect(new URL(seen[0]!).searchParams.get('scopeId')).toBe(s);
  });

  it('a 200 without a size is a wire disagreement, not a zero', async () => {
    for (const body of [{}, { bytes: '8192' }, { bytes: -1 }, { bytes: 1.5 }]) {
      await expect(answering(200, JSON.stringify(body)).databaseSize(s)).rejects.toThrow(/without a size/);
    }
  });

  it('a deployment that predates the route refuses, and the refusal propagates', async () => {
    await expect(answering(501, JSON.stringify({ error: 'cannot read a database size' })).databaseSize(s)).rejects.toThrow();
    await expect(answering(404, '404 Not Found').databaseSize(s)).rejects.toThrow();
  });
});

/**
 * The plain `/internal/*` verbs (`postInternal` / `getInternal`) share the skew rule (#2010):
 * a 200 that is not JSON may follow a write that ran — a rewind, a drain stamp — so it is a
 * 502 that says it may or may not have acted. Redeploying is named only as the remedy for the
 * case it cannot prove, and an HTML page says why it cannot (Codex #2014 r1).
 */
describe('VerticalClient — a plain internal answer (#2010)', () => {
  const answering = (res: () => Response) =>
    new VerticalClient({ fetch: (async () => res()) as unknown as typeof fetch, platformSecret: 'secret' });
  const verbs = [
    ['rewind (POST)', (c: VerticalClient) => c.rewindScope(s, 'bm-1')],
    ['database size (GET)', (c: VerticalClient) => c.databaseSize(s)],
  ] as const;

  it.each(verbs)('%s reads a valid 200', async (name, run) => {
    const body = name.startsWith('rewind') ? { rewindingTo: 'bm-1' } : { bytes: 8192 };
    await expect(run(answering(() => Response.json(body)))).resolves.toEqual(name.startsWith('rewind') ? body : 8192);
  });

  it.each(verbs)('%s: an HTML page, the app shell or an error page alike, may or may not have acted', async (_name, run) => {
    for (const res of [spaShell, gatewayPage]) {
      const err = (await run(answering(res)).then(() => null, (e: unknown) => e)) as ControlPlaneError;
      expect(err.status).toBe(502);
      expect(err.message).toMatch(/an HTML page: an old deployment's app shell cannot be told from an error page in between/);
      expect(err.message).toMatch(/may or may not have acted\. If this deployment answers its app for \/internal\/\*, it predates/);
    }
  });

  it.each(verbs)('%s: a truncated or unreadable 200 may or may not have acted', async (_name, run) => {
    for (const res of [truncated('{"rewindingTo":'), brokenStream, () => new Response('<!doctype html>', { status: 200 })]) {
      const err = (await run(answering(res)).then(() => null, (e: unknown) => e)) as ControlPlaneError;
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect(err.status).toBe(502);
      expect(err.message).toMatch(/— it may or may not have acted\./);
      expect(err.message).not.toMatch(/HTML page/);
    }
  });

  it.each(verbs)('%s: a 404 is still the refusal it is', async (_name, run) => {
    const err = (await run(answering(() => new Response('404 Not Found', { status: 404 }))).then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(err.status).toBe(404);
  });
});

/**
 * The schedule kill switch's hop (#1666). The caller is an operator pulling a kill
 * switch, so the one answer that proves a deployment was built BEFORE the far end existed —
 * the route's 404 — reads as "redeploy, nothing switched",
 * never as a success nor as a bug in the request. Every other failure says the position is
 * unknown (#2010), and a refusal the far end means (the platform secret, 403) stays the
 * vertical's own answer.
 */
describe('VerticalClient.setLifecycle (#1713)', () => {
  const lifecycle = { scope: 'suspended', tenant: 'active', at: '2026-10-01T00:00:00.000Z', revision: { epoch: 0, scope: 1, tenant: 0 } } as const;
  const input = { scopeId: s, lifecycle: lifecycle as never };
  const answering = (res: () => Response, seen: { path: string; body: unknown }[] = []) =>
    new VerticalClient({
      fetch: (async (u: string, init?: RequestInit) => {
        seen.push({ path: new URL(u).pathname, body: JSON.parse(String(init?.body)) });
        return res();
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });

  it('posts the lifecycle and reads the delivery', async () => {
    const seen: { path: string; body: unknown }[] = [];
    const answer = { applied: true, changed: true, lifecycle };
    const client = answering(() => new Response(JSON.stringify(answer), { status: 200 }), seen);
    await expect(client.setLifecycle(input)).resolves.toEqual(answer);
    expect(seen).toEqual([{ path: '/internal/lifecycle', body: { scopeId: s, lifecycle } }]);
  });

  it('#2016: carries the tenant the directory holds the scope under', async () => {
    const seen: { path: string; body: unknown }[] = [];
    const answer = { applied: true, changed: true, lifecycle };
    const client = answering(() => new Response(JSON.stringify(answer), { status: 200 }), seen);
    await client.setLifecycle({ ...input, tenantId: t });
    expect(seen).toEqual([{ path: '/internal/lifecycle', body: { scopeId: s, lifecycle, tenantId: t } }]);
  });

  it('#2016: reads whether the scope holds a record of its tenant, and an older deployment\'s silence as absent', async () => {
    const recorded = { applied: true, changed: false, lifecycle, tenantRecorded: true };
    await expect(answering(() => new Response(JSON.stringify(recorded), { status: 200 })).setLifecycle(input)).resolves.toEqual(recorded);
    const older = { applied: true, changed: false, lifecycle };
    const answer = await answering(() => new Response(JSON.stringify(older), { status: 200 })).setLifecycle(input);
    expect(answer.tenantRecorded).toBeUndefined();
  });

  it.each([
    ['a route the deployment does not have (404)', () => new Response('404 Not Found', { status: 404 }), 501],
    ['an SPA shell (200, not JSON)', () => new Response('<!doctype html>', { status: 200 }), 502],
    ['a 200 of another shape', () => new Response(JSON.stringify({ ok: true }), { status: 200 }), 502],
    ["the deployment's own refusal", () => new Response(JSON.stringify({ error: 'no' }), { status: 501 }), 501],
  ])('%s throws, so no receipt is written', async (_name, res, status) => {
    const err = await answering(res).setLifecycle(input).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).status).toBe(status);
  });
});

describe('VerticalClient.systemSwitch (#1666)', () => {
  const input = { scopeId: s, moduleId: '@test/sched' as never, to: 'off' as const };
  const answering = (res: () => Response, seen: { path: string; body: unknown }[] = []) =>
    new VerticalClient({
      fetch: (async (u: string, init?: RequestInit) => {
        seen.push({ path: new URL(u).pathname, body: JSON.parse(String(init?.body)) });
        return res();
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });

  it('posts the switch and reads the outcome', async () => {
    const seen: { path: string; body: unknown }[] = [];
    const client = answering(
      () => new Response(JSON.stringify({ held: true, changed: true, permissions: ['sched:tick'] }), { status: 200 }),
      seen,
    );
    await expect(client.systemSwitch(input)).resolves.toEqual({ held: true, changed: true, permissions: ['sched:tick'] });
    expect(seen).toEqual([{ path: '/internal/system-switch', body: { scopeId: s, moduleId: '@test/sched', to: 'off' } }]);
  });

  it("posts the platform's tenantHeld when it is given (#1823)", async () => {
    const seen: { path: string; body: unknown }[] = [];
    const client = answering(
      () => new Response(JSON.stringify({ held: true, changed: true, permissions: [] }), { status: 200 }),
      seen,
    );
    await client.systemSwitch({ ...input, tenantHeld: true });
    expect(seen[0]?.body).toEqual({ scopeId: s, moduleId: '@test/sched', to: 'off', tenantHeld: true });
  });

  it("carries the deployment's tenant-grant attestation through, and an older answer's silence as absent (#1823)", async () => {
    const outcome = { held: true, changed: true, permissions: ['sched:tick'] };
    const attested = answering(() => new Response(JSON.stringify({ ...outcome, deniesTenantGrants: true }), { status: 200 }));
    await expect(attested.systemSwitch({ ...input, tenantHeld: true })).resolves.toEqual({ ...outcome, deniesTenantGrants: true });
    // An older deployment omits it: the parse leaves it absent for the platform to refuse on.
    const older = answering(() => new Response(JSON.stringify(outcome), { status: 200 }));
    expect(await older.systemSwitch({ ...input, tenantHeld: true })).not.toHaveProperty('deniesTenantGrants');
  });

  it.each([
    ['a route the deployment does not have (404)', () => new Response('404 Not Found', { status: 404 })],
  ])('%s — the explicit legacy signal — is a 501 that says to redeploy', async (_name, res) => {
    const err = await answering(res).systemSwitch(input).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).status).toBe(501);
    expect((err as ControlPlaneError).message).toMatch(/predates the schedule switch.*redeploy the vertical.*Nothing was switched/);
  });

  // #2010: a deployment that has the route can move the switch and then lose its answer. That
  // is not its proof that it predates the route, so it never says "Nothing was switched" nor
  // "redeploy": the position is unknown, and the operator is told to read it first.
  it.each([
    ['truncated JSON', truncated('{"held":true,"changed":')],
    ['a body whose stream fails mid-read', brokenStream],
    ['an HTML document not served as HTML', () => new Response('<!doctype html><html></html>', { status: 200 })],
    ["the app shell an old deployment's asset layer serves", spaShell],
    ['an HTML error page from something in between', gatewayPage],
    ['text/html that is not a document', () => new Response('oops', { status: 200, headers: { 'content-type': 'text/html' } })],
  ])('a 200 with %s leaves the position unknown — a 502 that says to confirm it first', async (_name, res) => {
    const err = (await answering(res).systemSwitch(input).then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(new RegExp(`scope ${s} may or may not have moved\\. Confirm its position \\(read the scope's schedule status\\)`));
    expect(err.message).not.toMatch(/Nothing was switched|redeploy/i);
  });

  /**
   * Everything else is a FAILURE, and never claims "Nothing was switched": the request may
   * have landed and moved the switch before the answer was lost.
   */
  // Codex #2014 r1, reproduced through the real client: the far end MOVES the switch, and what
  // comes back is an HTML error page from something in between. That must never read as the
  // old deployment's app shell, "Nothing was switched", because the switch did move.
  it('a switch that moved, answered by an HTML error page, is position-unknown — never "Nothing was switched"', async () => {
    let position: 'on' | 'off' = 'on';
    const client = new VerticalClient({
      fetch: (async (_u: string, init?: RequestInit) => {
        position = (JSON.parse(String(init?.body)) as { to: 'on' | 'off' }).to;
        return gatewayPage();
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    const err = (await client.systemSwitch(input).then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(position).toBe('off');
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/may or may not have moved\. Confirm its position/);
    expect(err.message).not.toMatch(/Nothing was switched|redeploy/i);
  });

  it('a transport failure surfaces as the 502 it is, never as "nothing was switched"', async () => {
    const client = new VerticalClient({
      fetch: (() => Promise.reject(new Error('Network connection lost'))) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    const err = (await client.systemSwitch(input).then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/unreachable during system-switch: Network connection lost/);
    expect(err.message).not.toMatch(/Nothing was switched/);
  });

  it("a genuine 502 from the far end is the vertical's own failure, not a legacy signal", async () => {
    const err = (await answering(() => new Response(JSON.stringify({ error: 'upstream DO reset' }), { status: 502 }))
      .systemSwitch(input)
      .then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(err.status).toBe(502);
    expect(err.message).toBe('upstream DO reset');
  });

  it('a 200 JSON of the wrong shape is a failure that says to confirm the position first', async () => {
    const err = (await answering(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .systemSwitch(input)
      .then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/may or may not have moved.*Confirm its position/);
  });

  it("the far end's own 501 (a host without the method) passes through verbatim", async () => {
    const err = (await answering(
      () => new Response(JSON.stringify({ error: 'this deployment cannot switch schedules (#1666) — redeploy it' }), { status: 501 }),
    )
      .systemSwitch(input)
      .then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(err.status).toBe(501);
    expect(err.message).toMatch(/redeploy it/);
  });

  it("a refusal the far end means is still the vertical's own answer", async () => {
    const err = await answering(() => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }))
      .systemSwitch(input)
      .then(() => null, (e: unknown) => e);
    expect((err as ControlPlaneError).status).toBe(403);
  });
});

/**
 * #1722: the fenced wipe of a carried copy. Only the deployment's own proof that it cannot fence
 * (a 404, a 501) becomes `'unfenced'`, the one answer that lets the caller wipe
 * unconditionally instead. A failure in transit may have wiped or not, so it surfaces as one.
 */
describe('VerticalClient.wipeCarriedCopy (#1722)', () => {
  const input = { scopeId: s, expectLoadStamp: 'stamp-1', carriedTo: 'v2-script', at: '2026-10-03T00:00:00.000Z' };
  const answering = (res: () => Response, seen: { path: string; body: unknown }[] = []) =>
    new VerticalClient({
      fetch: (async (u: string, init?: RequestInit) => {
        seen.push({ path: new URL(u).pathname, body: JSON.parse(String(init?.body)) });
        return res();
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });

  it('posts the stamp and the tombstone and reads the outcome, a refusal included', async () => {
    const seen: { path: string; body: unknown }[] = [];
    await expect(answering(() => Response.json({ wiped: true }), seen).wipeCarriedCopy(input)).resolves.toEqual({ wiped: true });
    await expect(answering(() => Response.json({ wiped: false })).wipeCarriedCopy(input)).resolves.toEqual({ wiped: false });
    expect(seen).toEqual([{ path: '/internal/wipe-carried', body: input }]);
    // The revision the export read rides along when there is one.
    const withRevision: { path: string; body: unknown }[] = [];
    await answering(() => Response.json({ wiped: true }), withRevision).wipeCarriedCopy({ ...input, expectRevision: '7' });
    expect(withRevision[0]!.body).toEqual({ ...input, expectRevision: '7' });
  });

  it.each([
    ['a route the deployment does not have (404)', () => new Response('404 Not Found', { status: 404 })],
    ['a host without the method (501)', () => Response.json({ error: 'redeploy it' }, { status: 501 })],
  ])('%s is unfenced', async (_name, res) => {
    await expect(answering(res).wipeCarriedCopy(input)).resolves.toBe('unfenced');
  });

  // Codex #2008 r1: a 200 whose body fails to read is NOT a deployment that predates the route.
  // The fenced wipe may have committed before the answer was lost; reading it as unfenced would
  // send the caller to the unconditional fallback, which the fence exists to prevent.
  it('a 200 whose body fails to read is a failure, never unfenced', async () => {
    const broken = () =>
      new Response(new ReadableStream({ start: (c) => c.error(new Error('stream reset')) }), { status: 200 });
    const err = (await answering(broken).wipeCarriedCopy(input).then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/reading the vertical's answer to wipe-carried failed.*stream reset.*may or may not have acted/);
  });

  // Codex #2008 r2 and #2014 r1: only a status is skew. A truncated answer, or any HTML page —
  // an old deployment's app shell cannot be told from an error page after a wipe that committed
  // — may follow a wipe that ran, so it is a failure, never the unconditional fallback.
  it.each([
    ['truncated JSON', () => new Response('{"wiped":', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['a document not served as HTML', () => new Response('<!doctype html><html></html>', { status: 200 })],
    ['text/html that is not a document', () => new Response('oops', { status: 200, headers: { 'content-type': 'text/html' } })],
    ["the app shell an old deployment's asset layer serves", spaShell],
    ['an HTML error page from something in between', gatewayPage],
  ])('%s is a failure, never unfenced', async (_name, res) => {
    const err = (await answering(res).wipeCarriedCopy(input).then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/with a body that is not JSON.*— it may or may not have acted/);
  });

  it('a transport failure, a 5xx and a wrong shape are failures, never unfenced', async () => {
    const lost = new VerticalClient({
      fetch: (() => Promise.reject(new Error('Network connection lost'))) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ControlPlaneError);
    expect((await failure(lost.wipeCarriedCopy(input)))?.status).toBe(502);
    expect((await failure(answering(() => Response.json({ error: 'DO reset' }, { status: 500 })).wipeCarriedCopy(input)))?.status).toBe(500);
    const shape = await failure(answering(() => Response.json({ ok: true })).wipeCarriedCopy(input));
    expect(shape?.status).toBe(502);
    expect(shape?.message).toMatch(/may or may not be wiped/);
  });
});

describe('VerticalClient.loadMarker (#1722)', () => {
  const client = (res: () => Response, urls: string[] = []) =>
    new VerticalClient({
      fetch: (async (u: string) => {
        urls.push(u);
        return res();
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });

  it('reads the marker, nulls included', async () => {
    const urls: string[] = [];
    await expect(client(() => Response.json({ loadStamp: 'st', revision: 'ev' }), urls).loadMarker(s)).resolves.toEqual({
      loadStamp: 'st',
      revision: 'ev',
    });
    await expect(client(() => Response.json({ loadStamp: null, revision: null })).loadMarker(s)).resolves.toEqual({
      loadStamp: null,
      revision: null,
    });
    expect(new URL(urls[0]!).pathname).toBe('/internal/load-marker');
    expect(new URL(urls[0]!).searchParams.get('scopeId')).toBe(s);
  });

  it.each([
    ['a 404', () => new Response('404 Not Found', { status: 404 })],
    ['a 501', () => Response.json({ error: 'redeploy it' }, { status: 501 })],
  ])('%s is unfenced', async (_n, res) => {
    await expect(client(res).loadMarker(s)).resolves.toBe('unfenced');
  });

  it('a body that fails to read, a 5xx and a wrong shape are failures', async () => {
    const failure = (res: () => Response) => client(res).loadMarker(s).then(() => null, (e: unknown) => e as ControlPlaneError);
    const broken = () => new Response(new ReadableStream({ start: (c) => c.error(new Error('reset')) }), { status: 200 });
    expect((await failure(broken))?.status).toBe(502);
    expect((await failure(() => Response.json({ error: 'x' }, { status: 500 })))?.status).toBe(500);
    expect((await failure(() => Response.json({ loadStamp: 7, revision: null })))?.status).toBe(502);
    // Codex #2008 r2: a truncated marker would otherwise drop the fence from the restore.
    expect((await failure(() => new Response('{"loadStamp":', { status: 200 })))?.status).toBe(502);
    // Codex #2014 r1: an HTML page is not the deployment's proof it predates the route.
    expect((await failure(spaShell))?.status).toBe(502);
    expect((await failure(gatewayPage))?.status).toBe(502);
  });
});

describe('VerticalClient kept copies (#1722)', () => {
  const client = (res: () => Response, seen: unknown[] = []) =>
    new VerticalClient({
      fetch: (async (_u: string, init?: RequestInit) => {
        if (init?.body) seen.push(JSON.parse(String(init.body)));
        return res();
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
  const kept = { carriedTo: 'v2', keptAt: '2026-10-03T00:00:00.000Z', revision: '4' };

  it('reads a kept copy, none, and none from a deployment that predates them', async () => {
    expect(await client(() => Response.json({ kept })).keptCopy(s)).toEqual(kept);
    expect(await client(() => Response.json({ kept: null })).keptCopy(s)).toBeNull();
    expect(await client(() => new Response('nope', { status: 404 })).keptCopy(s)).toBeNull();
    const shape = await client(() => Response.json({ kept: { carriedTo: 1 } })).keptCopy(s).then(() => null, (e: unknown) => e as ControlPlaneError);
    expect(shape?.status).toBe(502);
  });

  it('releases with the revision, and reads the refusal; a deployment that predates it is a 501', async () => {
    const seen: unknown[] = [];
    expect(await client(() => Response.json({ released: true }), seen).releaseKeptCopy({ scopeId: s, revision: '9' })).toEqual({ released: true });
    expect(seen).toEqual([{ scopeId: s, revision: '9' }]);
    expect(await client(() => Response.json({ refused: 'not-kept' })).releaseKeptCopy({ scopeId: s, revision: '9' })).toEqual({ refused: 'not-kept' });
    const old = await client(() => new Response('nope', { status: 404 })).releaseKeptCopy({ scopeId: s, revision: '9' }).then(() => null, (e: unknown) => e as ControlPlaneError);
    expect(old?.status).toBe(501);
  });

  it('discards with the revision, and reads the refusal; a deployment that predates it is a 501', async () => {
    const seen: unknown[] = [];
    const input = { scopeId: s, revision: '9', carriedTo: 'v2', at: '2026-10-03T00:00:00.000Z' };
    expect(await client(() => Response.json({ discarded: true }), seen).discardKeptCopy(input)).toEqual({ discarded: true });
    expect(seen).toEqual([input]);
    expect(await client(() => Response.json({ refused: 'changed' })).discardKeptCopy(input)).toEqual({ refused: 'changed' });
    const old = await client(() => new Response('nope', { status: 404 })).discardKeptCopy(input).then(() => null, (e: unknown) => e as ControlPlaneError);
    expect(old?.status).toBe(501);
  });
});

it('restoreScope sends the stamp a carry leaves on its copy, and none when not given one (#1722)', async () => {
  const bodies: unknown[] = [];
  const client = new VerticalClient({
    fetch: (async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ tables: 0 });
    }) as unknown as typeof fetch,
    platformSecret: 'secret',
  });
  await client.restoreScope(t, s, [], { loadStamp: 'stamp-9', expect: { loadStamp: null, revision: 'ev' } });
  await client.restoreScope(t, s, []);
  expect(bodies).toEqual([
    { tenantId: t, scopeId: s, tables: [], loadStamp: 'stamp-9', expect: { loadStamp: null, revision: 'ev' } },
    { tenantId: t, scopeId: s, tables: [] },
  ]);
});

it('exportScopeStamped asks for the stamp and reads it off the export, null from a deployment that sends none (#1722)', async () => {
  const replies = [
    new Response('[]', { status: 200, headers: { 'x-substrat-load-stamp': 'stamp-3', 'x-substrat-write-revision': '7' } }),
    new Response('[]', { status: 200 }),
  ];
  const urls: string[] = [];
  const client = new VerticalClient({
    fetch: (async (u: string) => {
      urls.push(u);
      return replies.shift();
    }) as unknown as typeof fetch,
    platformSecret: 'secret',
  });
  expect(await client.exportScopeStamped(s)).toEqual({ tables: [], loadStamp: 'stamp-3', revision: '7' });
  expect(await client.exportScopeStamped(s)).toEqual({ tables: [], loadStamp: null, revision: null });
  expect(urls.every((u) => new URL(u).searchParams.get('stamp') === '1')).toBe(true);
});

/**
 * The status read's hop (#1674) — `systemGrantsStatus`, the read half of the switch above.
 * Same skew contract, on purpose: a deployment that predates the read must answer
 * "redeploy", never a wrong `on`, exactly like `systemSwitch` does for the write.
 */
describe('VerticalClient.systemGrantsStatus (#1674)', () => {
  const input = { scopeId: s };
  const answering = (res: () => Response, seen: { path: string; search: string }[] = []) =>
    new VerticalClient({
      fetch: (async (u: string) => {
        const url = new URL(u);
        seen.push({ path: url.pathname, search: url.search });
        return res();
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });

  it('gets the status by scope id and reads the entries', async () => {
    const seen: { path: string; search: string }[] = [];
    const client = answering(
      () => new Response(JSON.stringify([{ moduleId: '@test/sched', schedules: 'off' }]), { status: 200 }),
      seen,
    );
    await expect(client.systemGrantsStatus(input)).resolves.toEqual([{ moduleId: '@test/sched', schedules: 'off' }]);
    expect(seen).toEqual([{ path: '/internal/system-grants', search: `?scopeId=${s}` }]);
  });

  it.each([
    ['a route the deployment does not have (404)', () => new Response('404 Not Found', { status: 404 })],
  ])('%s — the explicit legacy signal — is a 501 that says to redeploy', async (_name, res) => {
    const err = await answering(res).systemGrantsStatus(input).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).status).toBe(501);
    expect((err as ControlPlaneError).message).toMatch(/predates the schedule switch's status read.*redeploy the vertical/);
  });

  it.each([
    ['truncated JSON', truncated('[{"moduleId":')],
    ['a body whose stream fails mid-read', brokenStream],
    ['an HTML document not served as HTML', () => new Response('<!doctype html><html></html>', { status: 200 })],
    ["the app shell an old deployment's asset layer serves", spaShell],
    ['an HTML error page from something in between', gatewayPage],
  ])('a 200 with %s is a failed read (502), never "predates" (#2010)', async (_name, res) => {
    const err = (await answering(res).systemGrantsStatus(input).then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/could not be read\. Nothing was changed; retry the read/);
    expect(err.message).not.toMatch(/predates|redeploy/);
  });

  it('a transport failure surfaces as the 502 it is', async () => {
    const client = new VerticalClient({
      fetch: (() => Promise.reject(new Error('Network connection lost'))) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    const err = (await client.systemGrantsStatus(input).then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/unreachable during system-grants: Network connection lost/);
  });

  it('a 200 JSON of the wrong shape is a failure, not a silent wrong answer', async () => {
    const err = (await answering(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .systemGrantsStatus(input)
      .then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/unexpected shape/);
  });

  it("the far end's own 501 (a host without the method) passes through verbatim", async () => {
    const err = (await answering(
      () => new Response(JSON.stringify({ error: 'this deployment cannot read schedule switches (#1674) — redeploy it' }), { status: 501 }),
    )
      .systemGrantsStatus(input)
      .then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(err.status).toBe(501);
    expect(err.message).toMatch(/redeploy it/);
  });

  it("a refusal the far end means is still the vertical's own answer", async () => {
    const err = await answering(() => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }))
      .systemGrantsStatus(input)
      .then(() => null, (e: unknown) => e);
    expect((err as ControlPlaneError).status).toBe(403);
  });
});

/**
 * The preview-client hops (#1704) — check, mint and retire at a team auth-server. The skew rule
 * is `systemSwitch`'s plus the auth-server's own fallback: its `/internal/*` catch-all answers a
 * JSON 501, so a 501 is "predates" here too, alongside a 404. Whatever the
 * cause, "predates" must never be mistaken for "the parent does not sign in here" — the caller
 * turns it into "redeploy", not into "external".
 */
describe('VerticalClient preview-client verbs (#1704)', () => {
  const issuer = scopeId.parse(ulid());
  const address = { tenantId: t, scopeId: issuer };
  const check = { ...address, parentScopeId: s, parentRedirectUris: ['https://desk.acme.test/api/auth/callback'] };
  const mint = {
    ...check,
    previewScopeId: scopeId.parse(ulid()),
    redirectUri: 'https://desk--pr-7.acme.test/api/auth/callback',
    postLogoutRedirectUri: 'https://desk--pr-7.acme.test/',
    clientName: 'Desk (pr-7)',
  };
  const retire = { ...address, previewScopeId: mint.previewScopeId, keep: 'c1' };
  const answering = (res: () => Response, seen: { method: string; path: string; body: unknown }[] = []) =>
    new VerticalClient({
      fetch: (async (u: string, init: RequestInit) => {
        seen.push({ method: init.method ?? 'GET', path: new URL(u).pathname, body: JSON.parse(String(init.body)) });
        return res();
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
  const verbs = [
    ['check', (c: VerticalClient) => c.checkPreviewClient(check)],
    ['mint', (c: VerticalClient) => c.mintPreviewClient(mint)],
    ['retire', (c: VerticalClient) => c.retirePreviewClients(retire)],
  ] as const;

  it('speaks the contract’s paths and methods, and reads each answer', async () => {
    const seen: { method: string; path: string; body: unknown }[] = [];
    await expect(answering(() => Response.json({ claimed: true }), seen).checkPreviewClient(check)).resolves.toEqual({ claimed: true });
    await expect(
      answering(() => Response.json({ clientId: 'c1', clientSecret: 'shh', generation: 3 }, { status: 201 }), seen).mintPreviewClient(mint),
    ).resolves.toEqual({ clientId: 'c1', clientSecret: 'shh', generation: 3 });
    await expect(
      answering(() => Response.json({ deleted: ['c0'], kept: true, superseded: false }), seen).retirePreviewClients(retire),
    ).resolves.toEqual({ deleted: ['c0'], kept: true, superseded: false });
    expect(seen).toEqual([
      { method: 'POST', path: '/internal/preview-client/check', body: check },
      { method: 'POST', path: '/internal/preview-client', body: mint },
      { method: 'DELETE', path: '/internal/preview-client', body: retire },
    ]);
  });

  it.each([
    ['the auth-server’s own /internal/* fallback (501)', () => Response.json({ error: 'auth-server does not implement POST /internal/preview-client' }, { status: 501 })],
    ['a route the deployment does not have (404)', () => new Response('404 Not Found', { status: 404 })],
  ])('%s is a 501 that says to redeploy the auth server — for every verb', async (_name, res) => {
    for (const [, run] of verbs) {
      const err = await run(answering(res)).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect((err as ControlPlaneError).status).toBe(501);
      expect((err as ControlPlaneError).message).toMatch(/predates preview clients.*redeploy it/);
    }
  });

  // #2010: a mint that ran and lost its answer may have left a client behind; it is a 502 that
  // says so, never "Nothing was minted or deleted there".
  it.each([
    ['truncated JSON', truncated('{"clientId":"c1","clientSecret":')],
    ['a body whose stream fails mid-read', brokenStream],
    ['an HTML document not served as HTML', () => new Response('<!doctype html><html></html>', { status: 200 })],
    ["the app shell an old deployment's asset layer serves", spaShell],
    ['an HTML error page from something in between', gatewayPage],
  ])('a 200 with %s is a 502 that may or may not have acted — for every verb', async (_name, res) => {
    for (const [, run] of verbs) {
      const err = (await run(answering(res)).then(() => null, (e: unknown) => e)) as ControlPlaneError;
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect(err.status).toBe(502);
      expect(err.message).toMatch(new RegExp(`auth server serving scope ${issuer} may or may not have acted on it`));
      expect(err.message).not.toMatch(/Nothing was minted|redeploy|clientSecret/);
    }
  });

  it('a refusal passes through verbatim: another tenant’s issuer (403), an unclaimed parent (409)', async () => {
    for (const status of [403, 409]) {
      const err = await answering(() => Response.json({ error: `refused ${status}` }, { status }))
        .mintPreviewClient(mint)
        .then(() => null, (e: unknown) => e);
      expect((err as ControlPlaneError).status).toBe(status);
      expect((err as ControlPlaneError).message).toBe(`refused ${status}`);
    }
  });

  it('a transport failure is a 502, and a wrong-shaped mint is a 502 that never quotes the secret it carried', async () => {
    const down = new VerticalClient({
      fetch: (() => Promise.reject(new Error('Network connection lost'))) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    expect(((await down.checkPreviewClient(check).then(() => null, (e: unknown) => e)) as ControlPlaneError).status).toBe(502);
    const err = (await answering(() => Response.json({ clientId: 'c1', clientSecret: 'TOP-SECRET-VALUE' }, { status: 201 }))
      .mintPreviewClient(mint)
      .then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/unexpected shape/);
    expect(err.message).not.toContain('TOP-SECRET-VALUE');
  });
});

/**
 * The peer kill switch's hop (#1706) — `systemSwitch`'s contract with the subject swapped,
 * and it is held to the same rules for the same reason: the caller is an operator cutting
 * one of a tenant's apps off from another's data. A deployment built before the far end
 * existed must read as "redeploy, nothing switched", and everything else must read as the
 * failure it is — a peer reported cut off while its calls keep being admitted is the one
 * answer this switch must never give.
 */
describe('VerticalClient.peerSwitch (#1706)', () => {
  const input = { scopeId: s, vertical: 'acme/board-room', to: 'off' as const };
  const answering = (res: () => Response, seen: { path: string; body: unknown }[] = []) =>
    new VerticalClient({
      fetch: (async (u: string, init?: RequestInit) => {
        seen.push({ path: new URL(u).pathname, body: JSON.parse(String(init?.body)) });
        return res();
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });

  it('posts the switch and reads the outcome', async () => {
    const seen: { path: string; body: unknown }[] = [];
    const client = answering(
      () => new Response(JSON.stringify({ held: true, changed: true, permissions: ['crm:read'] }), { status: 200 }),
      seen,
    );
    await expect(client.peerSwitch(input)).resolves.toEqual({ held: true, changed: true, permissions: ['crm:read'] });
    expect(seen).toEqual([
      { path: '/internal/peer-switch', body: { scopeId: s, vertical: 'acme/board-room', to: 'off' } },
    ]);
  });

  it('a peer the scope holds nothing for is an answer, not a legacy signal', async () => {
    // The route answers `held: false` with a 200; only a 404 means "no such route".
    await expect(
      answering(() => new Response(JSON.stringify({ held: false, changed: false, permissions: [] }), { status: 200 }))
        .peerSwitch(input),
    ).resolves.toEqual({ held: false, changed: false, permissions: [] });
  });

  it.each([
    ['a route the deployment does not have (404)', () => new Response('404 Not Found', { status: 404 })],
  ])('%s — the explicit legacy signal — is a 501 that says to redeploy', async (_name, res) => {
    const err = await answering(res)
      .peerSwitch(input)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).status).toBe(501);
    expect((err as ControlPlaneError).message).toMatch(
      /predates the peer kill switch.*redeploy the vertical.*Nothing was switched/,
    );
  });

  it.each([
    ['truncated JSON', truncated('{"held":true,"changed":')],
    ['a body whose stream fails mid-read', brokenStream],
    ['an HTML document not served as HTML', () => new Response('<!doctype html><html></html>', { status: 200 })],
    ["the app shell an old deployment's asset layer serves", spaShell],
    ['an HTML error page from something in between', gatewayPage],
  ])('a 200 with %s leaves the position unknown — a 502 that says to confirm it first (#2010)', async (_name, res) => {
    const err = (await answering(res).peerSwitch(input).then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/peer 'acme\/board-room'.*may or may not have moved\. Confirm its position \(read the scope's peer status\)/);
    expect(err.message).not.toMatch(/Nothing was switched|redeploy/i);
  });

  it('a transport failure surfaces as the 502 it is, never as "nothing was switched"', async () => {
    const client = new VerticalClient({
      fetch: (() => Promise.reject(new Error('Network connection lost'))) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    const err = (await client.peerSwitch(input).then(
      () => null,
      (e: unknown) => e,
    )) as ControlPlaneError;
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/unreachable during peer-switch: Network connection lost/);
    expect(err.message).not.toMatch(/Nothing was switched/);
  });

  it('a 200 JSON of the wrong shape is a failure that names the peer and says to confirm', async () => {
    const err = (await answering(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .peerSwitch(input)
      .then(
        () => null,
        (e: unknown) => e,
      )) as ControlPlaneError;
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/peer 'acme\/board-room'.*may or may not have moved.*Confirm its position/);
  });

  it("the far end's own 501 (a host without the method) passes through verbatim", async () => {
    const err = (await answering(
      () =>
        new Response(JSON.stringify({ error: 'this deployment cannot switch peers (#1706) — redeploy it' }), {
          status: 501,
        }),
    )
      .peerSwitch(input)
      .then(
        () => null,
        (e: unknown) => e,
      )) as ControlPlaneError;
    expect(err.status).toBe(501);
    expect(err.message).toMatch(/redeploy it/);
  });

  it("a refusal the far end means is still the vertical's own answer", async () => {
    const err = await answering(() => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }))
      .peerSwitch(input)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((err as ControlPlaneError).status).toBe(403);
  });
});

/**
 * The peer switch's READ hop (#1706) — `peerGrantsStatus`. The same skew contract as the
 * write above and as #1674's read, for the same reason: a deployment that predates this
 * route must answer "redeploy", never an empty list, which a control plane would otherwise
 * show a tenant as "no other app may call in here".
 */
describe('VerticalClient.peerGrantsStatus (#1706)', () => {
  const answering = (res: () => Response, seen: string[] = []) =>
    new VerticalClient({
      fetch: (async (u: string) => {
        seen.push(new URL(u).pathname + new URL(u).search);
        return res();
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });

  it('asks for the scope and reads the positions back', async () => {
    const seen: string[] = [];
    const client = answering(
      () => new Response(JSON.stringify([{ vertical: 'acme/board-room', calls: 'off' }]), { status: 200 }),
      seen,
    );
    await expect(client.peerGrantsStatus({ scopeId: s })).resolves.toEqual([
      { vertical: 'acme/board-room', calls: 'off' },
    ]);
    expect(seen).toEqual([`/internal/peer-grants?scopeId=${s}`]);
  });

  it.each([
    ['a route the deployment does not have (404)', () => new Response('404 Not Found', { status: 404 })],
  ])('%s is a 501 that says to redeploy, never an empty list', async (_name, res) => {
    const err = await answering(res)
      .peerGrantsStatus({ scopeId: s })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((err as ControlPlaneError).status).toBe(501);
    expect((err as ControlPlaneError).message).toMatch(/predates the peer switch's status read/);
  });

  it.each([
    ['truncated JSON', truncated('[{"vertical":')],
    ['a body whose stream fails mid-read', brokenStream],
    ['an HTML document not served as HTML', () => new Response('<!doctype html><html></html>', { status: 200 })],
    ["the app shell an old deployment's asset layer serves", spaShell],
    ['an HTML error page from something in between', gatewayPage],
  ])('a 200 with %s is a failed read (502), never "predates" (#2010)', async (_name, res) => {
    const err = (await answering(res).peerGrantsStatus({ scopeId: s }).then(() => null, (e: unknown) => e)) as ControlPlaneError;
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/peer status of scope .* could not be read\. Nothing was changed; retry the read/);
    expect(err.message).not.toMatch(/predates|redeploy/);
  });

  it('a 200 JSON of the wrong shape is a 502, not a legacy signal', async () => {
    const err = await answering(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .peerGrantsStatus({ scopeId: s })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((err as ControlPlaneError).status).toBe(502);
  });

  it("the far end's own 501 passes through verbatim", async () => {
    const err = await answering(
      () =>
        new Response(JSON.stringify({ error: 'this deployment cannot read peer switches (#1706) — redeploy it' }), {
          status: 501,
        }),
    )
      .peerGrantsStatus({ scopeId: s })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((err as ControlPlaneError).status).toBe(501);
    expect((err as ControlPlaneError).message).toMatch(/redeploy it/);
  });
});

describe("VerticalClient — a restore names the dump's source (#1869)", () => {
  const sent = () => {
    const bodies: Record<string, unknown>[] = [];
    const client = new VerticalClient({
      fetch: (async (_u: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ tables: 0 }), { status: 200 });
      }) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    return { client, bodies };
  };
  const source = scopeId.parse(ulid());

  it('sends sourceScopeId, and exact only when the platform exported the tables', async () => {
    const { client, bodies } = sent();
    await client.restoreScope(t, s, [], { sourceScopeId: source, exact: true });
    await client.restoreScope(t, s, [], { sourceScopeId: source, exact: false });
    await client.restoreScope(t, s, []);
    // `exact` with no source is refused here, before anything is sent.
    await expect(client.restoreScope(t, s, [], { exact: true })).rejects.toThrow(/`exact` needs `sourceScopeId`/);
    expect(bodies).toEqual([
      { tenantId: t, scopeId: s, tables: [], sourceScopeId: source, exact: true },
      { tenantId: t, scopeId: s, tables: [], sourceScopeId: source },
      { tenantId: t, scopeId: s, tables: [] },
    ]);
  });
});
