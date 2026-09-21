import { describe, it, expect } from 'vitest';
import { tenantId, scopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
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

const rejecting = (message: string) =>
  new VerticalClient({
    fetch: (() => Promise.reject(new Error(message))) as unknown as typeof fetch,
    platformSecret: 'secret',
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
