/**
 * The link-share exchange over HTTP (#1672), against a real scope host.
 *
 * The contract suite drives the host directly; this drives the route a browser meets —
 * the secret POSTed once, the session coming back ONLY as an HttpOnly cookie, the cookie
 * then being all a later call carries — and ends where a link share has to end: the
 * shared document reads, its sibling is refused and the refusal is recorded against the
 * capability. A scenario that never went through `app.request` would prove the host and
 * say nothing about the seam a vertical actually mounts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type EntityRef,
  type Instant,
  type MintedCapability,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { capMod } from '@substrat-run/contract-tests';
import {
  CAPABILITY_COOKIE,
  capabilitySessionOf,
  linkShareStub,
  mountCapabilityExchange,
  problemResponse,
} from '../src/index.js';

const CAP_READ = permissionKey.parse('cap:read');
const folder = (id: string): EntityRef => ({ entityType: 'folder', entityId: id });
const doc = (id: string): EntityRef => ({ entityType: 'doc', entityId: id });

describe('mountCapabilityExchange — a link share, end to end over HTTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-cap-http-'));
  const host = new SqliteScopeHost({ dir });
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const alice = principalId.parse(ulid()); // holds cap:read — the minter
  const carol = principalId.parse(ulid()); // signed in, holds nothing
  const staff = platformActorId.parse(ulid());
  const node = { tenantId: t1, scopeId: s1 };

  // What a vertical mounts: the exchange, and link-share routes whose stub is the capability
  // FIRST, then the signed-in principal (`x-test-principal` stands in for a session).
  const app = new Hono();
  mountCapabilityExchange(app, { host: () => host, node: () => node });
  const stubFor = async (c: Parameters<typeof linkShareStub>[0]) =>
    linkShareStub(c, host, node, () => {
      const who = c.req.header('x-test-principal');
      return who ? host.getScope(principalId.parse(who), t1, s1) : undefined;
    });
  app.post('/api/read', async (c) => {
    try {
      const stub = await stubFor(c);
      if (!stub) return c.json({ error: 'no session' }, 401);
      return c.json(await stub.invoke('cap/read', await c.req.json()));
    } catch (err) {
      return problemResponse(c, err);
    }
  });
  app.get('/api/whoami', async (c) => {
    const stub = await stubFor(c);
    return c.json({ as: stub ? await stub.invoke('cap/whoami') : null });
  });
  app.get('/api/session', (c) => c.json({ session: capabilitySessionOf(c) ?? null }));

  const exchange = (secret: unknown, init: { contentType?: string; origin?: string } = {}) =>
    app.request(`${init.origin ?? 'http://docs.test'}/api/capability/exchange`, {
      method: 'POST',
      headers: { 'content-type': init.contentType ?? 'application/json' },
      body: JSON.stringify({ secret }),
    });
  const cookieOf = (res: Response): string => {
    const set = res.headers.get('set-cookie') ?? '';
    const m = set.match(new RegExp(`${CAPABILITY_COOKIE}=([^;]+)`));
    if (!m) throw new Error(`no ${CAPABILITY_COOKIE} cookie in: ${set}`);
    return m[1]!;
  };
  const read = (cookie: string | null, entity: EntityRef, signedInAs?: string) =>
    app.request('http://docs.test/api/read', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie: `${CAPABILITY_COOKIE}=${cookie}` } : {}),
        ...(signedInAs ? { 'x-test-principal': signedInAs } : {}),
      },
      body: JSON.stringify({ entity }),
    });
  const whoami = async (cookie: string | null, signedInAs?: string) =>
    (
      (await (
        await app.request('http://docs.test/api/whoami', {
          headers: {
            ...(cookie ? { cookie: `${CAPABILITY_COOKIE}=${cookie}` } : {}),
            ...(signedInAs ? { 'x-test-principal': signedInAs } : {}),
          },
        })
      ).json()) as { as: string | null }
    ).as;
  const mint = async (spec: Record<string, unknown>): Promise<MintedCapability> =>
    (await host.getScope(alice, t1, s1)).invoke<MintedCapability>('cap/share', spec);

  beforeAll(async () => {
    host.registerModule(capMod);
    await host.admin.createTenant(staff, { id: t1, slug: 'cap-http', name: 'Cap HTTP' });
    await host.admin.grantEntitlement(staff, t1, 'cap');
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'cap-vertical' });
    await host.admin.activateScope(staff, t1, s1);
    await host.admin.defineRole(staff, t1, { key: 'owner', permissions: [CAP_READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t1, scopeId: null } });
    const stub = await host.getScope(alice, t1, s1);
    await stub.invoke('cap/link', { child: doc('d1'), parent: folder('F') });
    await stub.invoke('cap/link', { child: doc('d3'), parent: folder('G') });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exchange → cookie → read the shared document → refused its sibling, and the refusal recorded', async () => {
    const minted = await mint({ entity: folder('F'), permissions: [CAP_READ] });
    const res = await exchange(minted.secret);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ capabilityId: minted.id, entity: folder('F') });
    const session = cookieOf(res);

    const ok = await read(session, doc('d1'));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ read: doc('d1') });

    const refused = await read(session, doc('d3'));
    expect(refused.status).toBe(403);

    const denials = await (await host.getScope(alice, t1, s1)).invoke<{ actor: string; permission: string }[]>(
      'cap/denials',
    );
    expect(denials).toContainEqual(
      expect.objectContaining({ actor: JSON.stringify({ capability: minted.id }), permission: 'cap:read' }),
    );
  });

  it('on a link-share route the link wins over a signed-in visitor who holds no access of their own', async () => {
    const minted = await mint({ entity: folder('F'), permissions: [CAP_READ] });
    const session = cookieOf(await exchange(minted.secret));
    // carol is signed in and holds nothing — yet with the link's cookie the shared doc reads.
    const withLink = await read(session, doc('d1'), carol);
    expect(withLink.status).toBe(200);
    expect(await whoami(session, carol)).toBe(minted.id);
    // The twin: the same visitor with no capability cookie acts as themselves, and is refused.
    expect((await read(null, doc('d1'), carol)).status).toBe(403);
    expect(await whoami(null, carol)).toBe(carol);
  });

  it('with no capability cookie the signed-in principal decides, exactly as without link shares', async () => {
    expect((await read(null, doc('d1'), alice)).status).toBe(200);
    expect(await whoami(null, alice)).toBe(alice);
    // Nobody at all: no stub.
    expect((await read(null, doc('d1'))).status).toBe(401);
  });

  it('the session travels ONLY in an HttpOnly cookie — never in the body — and nothing is cached', async () => {
    const minted = await mint({ entity: folder('F'), permissions: [CAP_READ] });
    const res = await exchange(minted.secret);
    const session = cookieOf(res);
    const text = await res.text();
    expect(text).not.toContain(session);
    expect(text).not.toContain(minted.secret);
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Path=\//);
    expect(set).toMatch(/Max-Age=\d+/);
    expect(set).not.toMatch(/Secure/i); // plain http here — see the https twin below
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('marks the cookie Secure when the page is served over https', async () => {
    const minted = await mint({ entity: folder('F'), permissions: [CAP_READ] });
    const res = await exchange(minted.secret, { origin: 'https://docs.test' });
    expect(res.headers.get('set-cookie')).toMatch(/Secure/i);
  });

  it('a revoked link refuses the next call on a cookie already issued', async () => {
    const minted = await mint({ entity: folder('F'), permissions: [CAP_READ] });
    const session = cookieOf(await exchange(minted.secret));
    expect((await read(session, doc('d1'))).status).toBe(200);
    await (await host.getScope(alice, t1, s1)).invoke('cap/unshare', { id: minted.id });
    expect((await read(session, doc('d1'))).status).toBe(401);
  });

  it('an unknown, used-up and claim secret all get the same 404 — and the claim is not spent', async () => {
    const once = await mint({ entity: folder('F'), permissions: [CAP_READ], maxUses: 1 });
    expect((await exchange(once.secret)).status).toBe(200);
    const usedUp = await exchange(once.secret);
    const unknown = await exchange(`sbcap_${'A'.repeat(43)}`);
    const claim = await host.admin.mintCapability(staff, t1, s1, {
      principal: principalId.parse(ulid()),
      expiresAt: new Date(Date.now() + 60_000).toISOString() as Instant,
      maxUses: 1,
    });
    const claimRes = await exchange(claim.secret);
    const bodies = await Promise.all([usedUp, unknown, claimRes].map(async (r) => [r.status, (await r.json()).detail]));
    expect(bodies).toEqual([
      [404, 'This link is not valid, or no longer is.'],
      [404, 'This link is not valid, or no longer is.'],
      [404, 'This link is not valid, or no longer is.'],
    ]);
    expect((await host.exchangeCapability(t1, s1, claim.secret, { mode: 'become' }))?.kind).toBe('principal');
  });

  it('refuses a body that is not declared JSON — a cross-site form cannot plant a session', async () => {
    const minted = await mint({ entity: folder('F'), permissions: [CAP_READ], maxUses: 1 });
    const res = await exchange(minted.secret, { contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
    // Refused BEFORE the exchange: the single use is still there.
    expect((await exchange(minted.secret)).status).toBe(200);
  });
});
