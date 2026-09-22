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
  CAPABILITY_HEADER,
  CAPABILITY_SESSIONS_MAX,
  capabilitySessionOf,
  clearCapabilitySession,
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
    try {
      const stub = await stubFor(c);
      return c.json({ as: stub ? await stub.invoke('cap/whoami') : null });
    } catch (err) {
      return problemResponse(c, err);
    }
  });
  app.get('/api/session', (c) => c.json({ session: capabilitySessionOf(c) ?? null }));
  // What a page calls when it is done with a link (#1686): the named one, or all.
  app.post('/api/capability/clear', (c) => {
    try {
      clearCapabilitySession(c);
      return c.body(null, 204);
    } catch (err) {
      return problemResponse(c, err);
    }
  });

  const exchange = (secret: unknown, init: { contentType?: string; origin?: string } = {}) =>
    app.request(`${init.origin ?? 'http://docs.test'}/api/capability/exchange`, {
      method: 'POST',
      headers: { 'content-type': init.contentType ?? 'application/json' },
      body: JSON.stringify({ secret }),
    });
  const cookieOf = (res: Response): string => {
    const set = res.headers.get('set-cookie') ?? '';
    // Since #1686 each link has its own cookie, `sb_capability_<id>`; this is its `name=value`.
    const m = set.match(new RegExp(`(${CAPABILITY_COOKIE}_[0-9A-Z]{26}=[^;]+)`));
    if (!m) throw new Error(`no ${CAPABILITY_COOKIE}_<id> cookie in: ${set}`);
    return m[1]!;
  };
  const read = (cookie: string | null, entity: EntityRef, signedInAs?: string) =>
    app.request('http://docs.test/api/read', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(signedInAs ? { 'x-test-principal': signedInAs } : {}),
      },
      body: JSON.stringify({ entity }),
    });
  const whoami = async (cookie: string | null, signedInAs?: string) =>
    (
      (await (
        await app.request('http://docs.test/api/whoami', {
          headers: {
            ...(cookie ? { cookie } : {}),
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
    expect(text).not.toContain(session.slice(session.indexOf('.') + 1)); // the token itself
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

  // -------------------------------------------------------------------------
  // Several links in one browser (#1686).
  // -------------------------------------------------------------------------

  /** A browser's cookie jar, as far as these routes need one: set, replace, delete. */
  class Jar {
    readonly cookies = new Map<string, string>();
    take(res: Response): Response {
      for (const line of res.headers.getSetCookie()) {
        const pair = line.split(';')[0]!;
        const name = pair.slice(0, pair.indexOf('=')).trim();
        const value = pair.slice(pair.indexOf('=') + 1);
        if (/max-age=0(;|$)/i.test(line.replace(/\s/g, '')) || value === '') this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
      return res;
    }
    header(): string {
      return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    names(): string[] {
      return [...this.cookies.keys()].sort();
    }
  }
  const open = async (jar: Jar, secret: string) => {
    const res = jar.take(
      await app.request('http://docs.test/api/capability/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: jar.header() },
        body: JSON.stringify({ secret }),
      }),
    );
    expect(res.status).toBe(200);
    // Exchanges in one millisecond would tie; the eviction order is by exchange time.
    await new Promise((r) => setTimeout(r, 3));
    return res;
  };
  const as = (jar: Jar, capability?: string, signedInAs?: string): Record<string, string> => ({
    cookie: jar.header(),
    ...(capability ? { [CAPABILITY_HEADER]: capability } : {}),
    ...(signedInAs ? { 'x-test-principal': signedInAs } : {}),
  });
  const readAs = (jar: Jar, entity: EntityRef, capability?: string, signedInAs?: string) =>
    app.request('http://docs.test/api/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...as(jar, capability, signedInAs) },
      body: JSON.stringify({ entity }),
    });
  const whoamiAs = async (jar: Jar, capability?: string, signedInAs?: string) => {
    const res = await app.request('http://docs.test/api/whoami', { headers: as(jar, capability, signedInAs) });
    return res.status === 200 ? ((await res.json()) as { as: string | null }).as : res.status;
  };
  const shareOf = (entity: EntityRef) => mint({ entity, permissions: [CAP_READ] });

  it('two links opened in one browser are two usable shares, each acting only within its own entity', async () => {
    const jar = new Jar();
    const a = await shareOf(folder('F'));
    const b = await shareOf(folder('G'));
    await open(jar, a.secret);
    await open(jar, b.secret);
    expect(jar.names()).toEqual([`${CAPABILITY_COOKIE}_${a.id}`, `${CAPABILITY_COOKIE}_${b.id}`].sort());

    // A reads under F and not under G; B the other way round.
    expect((await readAs(jar, doc('d1'), a.id)).status).toBe(200);
    expect((await readAs(jar, doc('d3'), a.id)).status).toBe(403);
    expect((await readAs(jar, doc('d3'), b.id)).status).toBe(200);
    expect((await readAs(jar, doc('d1'), b.id)).status).toBe(403);
    expect(await whoamiAs(jar, a.id)).toBe(a.id);
    expect(await whoamiAs(jar, b.id)).toBe(b.id);
    // `?capability=` names the same way, for a link a browser follows without a header.
    const viaQuery = await app.request(`http://docs.test/api/whoami?capability=${a.id}`, { headers: as(jar) });
    expect(((await viaQuery.json()) as { as: string }).as).toBe(a.id);
    // Header and query disagreeing is refused, never picked between.
    const both = await app.request(`http://docs.test/api/whoami?capability=${a.id}`, { headers: as(jar, b.id) });
    expect(both.status).toBe(400);
  });

  it('a request naming nothing acts as the link opened last — what the one cookie did', async () => {
    const jar = new Jar();
    const a = await shareOf(folder('F'));
    const b = await shareOf(folder('G'));
    await open(jar, a.secret);
    await open(jar, b.secret);
    expect(await whoamiAs(jar)).toBe(b.id);
    // Opening A again makes it the newest, and still evicts nothing.
    await open(jar, a.secret);
    expect(jar.cookies.size).toBe(2);
    expect(await whoamiAs(jar)).toBe(a.id);
  });

  it('no try-all: a request naming B that carries only A’s session is refused, even signed in', async () => {
    const jar = new Jar();
    const a = await shareOf(folder('F'));
    const b = await shareOf(folder('G'));
    await open(jar, a.secret);
    // B is named; the browser holds only A. Refused as a revoked link is — A is not tried,
    // and neither is the signed-in owner, who could read d3 themselves.
    const refused = await readAs(jar, doc('d3'), b.id);
    expect(refused.status).toBe(401);
    expect((await readAs(jar, doc('d3'), b.id, alice)).status).toBe(401);
    expect(await whoamiAs(jar, b.id, alice)).toBe(401);
    // Nor does a name that is not an id at all reach anything.
    expect(await whoamiAs(jar, 'not-a-capability')).toBe(401);
    // The positive twin: naming A, A acts.
    expect((await readAs(jar, doc('d1'), a.id)).status).toBe(200);
  });

  it('the name only selects: A’s session under B’s cookie name still acts as A, within A’s entity', async () => {
    const jar = new Jar();
    const a = await shareOf(folder('F'));
    const b = await shareOf(folder('G'));
    await open(jar, a.secret);
    // Plant A's session under B's name — the most a browser's owner can do with their own jar.
    const forged = new Jar();
    forged.cookies.set(`${CAPABILITY_COOKIE}_${b.id}`, jar.cookies.get(`${CAPABILITY_COOKIE}_${a.id}`)!);
    expect(await whoamiAs(forged, b.id)).toBe(a.id);
    expect((await readAs(forged, doc('d3'), b.id)).status).toBe(403); // B's entity: no
    expect((await readAs(forged, doc('d1'), b.id)).status).toBe(200); // A's: as before
  });

  it(`holds at most ${CAPABILITY_SESSIONS_MAX} links, evicting the oldest — whose name is then refused like a revoked link`, async () => {
    const jar = new Jar();
    const links = [];
    for (let i = 0; i <= CAPABILITY_SESSIONS_MAX; i++) links.push(await shareOf(folder('F')));
    for (const link of links.slice(0, CAPABILITY_SESSIONS_MAX)) await open(jar, link.secret);
    expect(jar.cookies.size).toBe(CAPABILITY_SESSIONS_MAX);
    // Re-opening one already held replaces its own cookie and evicts nothing.
    await open(jar, links[1]!.secret);
    expect(jar.cookies.size).toBe(CAPABILITY_SESSIONS_MAX);
    // One more: the oldest exchange (links[0]) goes, and nothing else does.
    await open(jar, links[CAPABILITY_SESSIONS_MAX]!.secret);
    expect(jar.cookies.size).toBe(CAPABILITY_SESSIONS_MAX);
    expect(jar.cookies.has(`${CAPABILITY_COOKIE}_${links[0]!.id}`)).toBe(false);
    expect((await readAs(jar, doc('d1'), links[0]!.id)).status).toBe(401);
    for (const kept of links.slice(1)) expect(await whoamiAs(jar, kept.id)).toBe(kept.id);
    // Opening the evicted link again brings it back (it has uses left) — and evicts the
    // next oldest, links[2]; links[1] was re-opened above, so it is newer.
    await open(jar, links[0]!.secret);
    expect(await whoamiAs(jar, links[0]!.id)).toBe(links[0]!.id);
    expect(jar.cookies.has(`${CAPABILITY_COOKIE}_${links[2]!.id}`)).toBe(false);
    expect(jar.cookies.has(`${CAPABILITY_COOKIE}_${links[1]!.id}`)).toBe(true);
  });

  it('a pre-#1686 single `sb_capability` cookie keeps working with no re-exchange — and the next exchange retires it', async () => {
    const a = await shareOf(folder('F'));
    const fresh = new Jar();
    await open(fresh, a.secret);
    const value = fresh.cookies.get(`${CAPABILITY_COOKIE}_${a.id}`)!;
    // What a browser that exchanged before the deploy holds: the bare token, one name.
    const legacy = new Jar();
    legacy.cookies.set(CAPABILITY_COOKIE, value.slice(value.indexOf('.') + 1));
    expect(await whoamiAs(legacy)).toBe(a.id);
    expect((await readAs(legacy, doc('d1'))).status).toBe(200);
    expect((await readAs(legacy, doc('d3'))).status).toBe(403);
    // Still the link first over a signed-in visitor who holds nothing.
    expect(await whoamiAs(legacy, undefined, carol)).toBe(a.id);
    // It names no capability, so a request naming one cannot be shown it is that one.
    expect(await whoamiAs(legacy, a.id)).toBe(401);
    // Opening another link replaces it, as an exchange always did.
    const b = await shareOf(folder('G'));
    await open(legacy, b.secret);
    expect(legacy.names()).toEqual([`${CAPABILITY_COOKIE}_${b.id}`]);
  });

  it('clearing one link leaves the others open; clearing with none named forgets them all', async () => {
    const jar = new Jar();
    const a = await shareOf(folder('F'));
    const b = await shareOf(folder('G'));
    await open(jar, a.secret);
    await open(jar, b.secret);
    const clear = async (capability?: string) =>
      jar.take(await app.request('http://docs.test/api/capability/clear', { method: 'POST', headers: as(jar, capability) }));
    await clear(a.id);
    expect(jar.names()).toEqual([`${CAPABILITY_COOKIE}_${b.id}`]);
    expect((await readAs(jar, doc('d1'), a.id)).status).toBe(401);
    expect((await readAs(jar, doc('d3'), b.id)).status).toBe(200);
    // Nothing named: every capability session goes, and the principal decides again.
    jar.cookies.set(CAPABILITY_COOKIE, 'sbses_legacy');
    await clear();
    expect(jar.names()).toEqual([]);
    expect(await whoamiAs(jar, undefined, carol)).toBe(carol);
  });
});
