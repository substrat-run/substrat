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
