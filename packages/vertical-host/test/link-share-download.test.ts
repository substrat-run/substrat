/**
 * Files through a link share, over HTTP (#1686), against a real scope host.
 *
 * The contract suite drives `getCapabilityAttachments` directly; this drives the route a
 * browser meets — the link exchanged once for the `sb_capability` cookie, then a GET that
 * carries nothing but that cookie — and checks what a download must never get wrong: which
 * files it reaches, who it acts as when the visitor is also signed in, and that the
 * response says nothing a cache or a sniffing browser could turn into a leak.
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
  type AttachmentRecord,
  type CapabilityRecord,
  type EntityRef,
  type Instant,
  type MintedCapability,
} from '@substrat-run/contracts';
import { manualClock, ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { capMod } from '@substrat-run/contract-tests';
import {
  CAPABILITY_COOKIE,
  attachmentDisposition,
  linkShareAttachments,
  mountCapabilityExchange,
  mountLinkShareDownload,
  problemResponse,
} from '../src/index.js';

const CAP_READ = permissionKey.parse('cap:read');
const CAP_WRITE = permissionKey.parse('cap:write');
const CAP_ADMIN = permissionKey.parse('cap:admin');
const folder = (id: string): EntityRef => ({ entityType: 'folder', entityId: id });
const doc = (id: string): EntityRef => ({ entityType: 'doc', entityId: id });
const HOUR = 3_600_000;

describe('mountLinkShareDownload — files through a link share, over HTTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-cap-dl-'));
  const clock = manualClock();
  clock.set(new Date().toISOString());
  const host = new SqliteScopeHost({ dir, clock: clock.read });
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const alice = principalId.parse(ulid()); // owner — the minter, and a signed-in reader
  const carol = principalId.parse(ulid()); // signed in, holds nothing
  const staff = platformActorId.parse(ulid());
  const node = { tenantId: t1, scopeId: s1 };
  const files: Record<'F' | 'd1' | 'd3', AttachmentRecord> = {} as never;

  // What a vertical mounts: the exchange and the download, the signed-in principal standing
  // in as `x-test-principal`. Plus a write route through the same helper, to show the surface
  // a link share gets refuses a write over HTTP as well.
  const app = new Hono();
  const principalOf = (c: { req: { header: (k: string) => string | undefined } }) => {
    const who = c.req.header('x-test-principal');
    return who ? principalId.parse(who) : undefined;
  };
  mountCapabilityExchange(app, { host: () => host, node: () => node });
  mountLinkShareDownload(app, { host: () => host, node: () => node, principal: principalOf });
  app.post('/api/upload', async (c) => {
    try {
      const surface = await linkShareAttachments(c, host, node, () => principalOf(c));
      if (!surface) return c.json({ error: 'no session' }, 401);
      const rec = await surface.upload({
        entity: doc('d1'),
        filename: 'planted.txt',
        contentType: 'text/plain',
        visibility: 'internal',
        body: new TextEncoder().encode('planted'),
      });
      return c.json(rec);
    } catch (err) {
      return problemResponse(c, err);
    }
  });

  const mint = async (spec: Record<string, unknown>): Promise<MintedCapability> =>
    (await host.getScope(alice, t1, s1)).invoke<MintedCapability>('cap/share', spec);
  const cookieFor = async (secret: string): Promise<string> => {
    const res = await app.request('http://docs.test/api/capability/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
    const m = (res.headers.get('set-cookie') ?? '').match(new RegExp(`${CAPABILITY_COOKIE}=([^;]+)`));
    if (!m) throw new Error(`no cookie (status ${res.status})`);
    return m[1]!;
  };
  const headers = (cookie: string | null, signedInAs?: string) => ({
    ...(cookie ? { cookie: `${CAPABILITY_COOKIE}=${cookie}` } : {}),
    ...(signedInAs ? { 'x-test-principal': signedInAs } : {}),
  });
  const download = (id: string, cookie: string | null, signedInAs?: string) =>
    app.request(`http://docs.test/api/capability/attachments/${id}`, { headers: headers(cookie, signedInAs) });
  const denials = async () =>
    (await host.getScope(alice, t1, s1)).invoke<{ actor: string; permission: string; operation: string }[]>(
      'cap/denials',
    );
  const recordOf = async (id: string) =>
    (await (await host.getScope(alice, t1, s1)).invoke<CapabilityRecord[]>('cap/list', { includeRevoked: true })).find(
      (r) => r.id === id,
    )!;

  beforeAll(async () => {
    host.registerModule(capMod);
    await host.admin.createTenant(staff, { id: t1, slug: 'cap-dl', name: 'Cap Download' });
    await host.admin.grantEntitlement(staff, t1, 'cap');
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'cap-vertical' });
    await host.admin.activateScope(staff, t1, s1);
    await host.provisionBlobStore(staff, { tenantId: t1, vertical: 'cap-vertical', binding: 'ATTACHMENTS' });
    await host.admin.defineRole(staff, t1, {
      key: 'owner',
      permissions: [CAP_READ, CAP_WRITE, CAP_ADMIN],
      source: 'vertical',
    });
    await host.admin.defineRole(staff, t1, { key: 'reader', permissions: [CAP_READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t1, scopeId: null } });
    const stub = await host.getScope(alice, t1, s1);
    await stub.invoke('cap/link', { child: doc('d1'), parent: folder('F') });
    await stub.invoke('cap/link', { child: doc('d3'), parent: folder('G') });
    const mine = await host.attachments(alice, t1, s1);
    const put = (entity: EntityRef, filename: string, body: string) =>
      mine.upload({ entity, filename, contentType: 'text/plain', visibility: 'internal', body: new TextEncoder().encode(body) });
    files.F = await put(folder('F'), 'index.txt', 'the folder');
    files.d1 = await put(doc('d1'), 'rapport "Q3" – å.txt', 'the document');
    files.d3 = await put(doc('d3'), 'secret.txt', 'the sibling');
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('downloads the shared folder’s file and one on a document inside it, with headers that leak nothing', async () => {
    const minted = await mint({ entity: folder('F'), permissions: [CAP_READ] });
    const cookie = await cookieFor(minted.secret);

    const own = await download(files.F.id, cookie);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe('the folder');

    const child = await download(files.d1.id, cookie);
    expect(child.status).toBe(200);
    expect(await child.text()).toBe('the document');
    expect(child.headers.get('cache-control')).toBe('private, no-store');
    expect(child.headers.get('referrer-policy')).toBe('no-referrer');
    expect(child.headers.get('x-content-type-options')).toBe('nosniff');
    expect(child.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(child.headers.get('content-type')).toBe('text/plain');
    expect(child.headers.get('content-length')).toBe(String('the document'.length));
    expect(child.headers.get('content-disposition')).toBe(attachmentDisposition(files.d1.filename));
    // No session token, secret or hash comes back to the page.
    expect(child.headers.get('set-cookie')).toBeNull();
  });

  it('Content-Disposition is always an attachment, and the uploader’s name never reaches it raw', () => {
    const d = attachmentDisposition('rapport "Q3" – å.txt');
    expect(d).toBe(
      `attachment; filename="rapport _Q3_ _ _.txt"; filename*=UTF-8''rapport%20%22Q3%22%20%E2%80%93%20%C3%A5.txt`,
    );
    // A header-injection attempt stays inside its quotes, CR/LF replaced.
    expect(attachmentDisposition('a\r\nSet-Cookie: x=1')).toBe(
      `attachment; filename="a__Set-Cookie: x=1"; filename*=UTF-8''a%0D%0ASet-Cookie%3A%20x%3D1`,
    );
  });

  it('refuses the sibling folder’s file with 403, recorded against the capability — and the refusal is not cacheable either', async () => {
    const minted = await mint({ entity: folder('F'), permissions: [CAP_READ] });
    const res = await download(files.d3.id, await cookieFor(minted.secret));
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await denials()).toContainEqual(
      expect.objectContaining({
        actor: JSON.stringify({ capability: minted.id }),
        permission: 'cap:read',
        operation: 'attachments.open',
      }),
    );
    // The twin: the owner, signed in with no cookie, downloads the same file.
    expect((await download(files.d3.id, null, alice)).status).toBe(200);
  });

  it('refuses once the minter can no longer read, and allows again when they can', async () => {
    const dan = principalId.parse(ulid());
    const role = { principalId: dan, roleKey: 'reader', node: { tenantId: t1, scopeId: s1 } };
    await host.admin.assignRole(staff, role);
    const minted = (await (await host.getScope(dan, t1, s1)).invoke('cap/share', {
      entity: folder('F'),
      permissions: [CAP_READ],
    })) as MintedCapability;
    const cookie = await cookieFor(minted.secret);
    expect((await download(files.d1.id, cookie)).status).toBe(200);
    await host.admin.unassignRole(staff, role);
    expect((await download(files.d1.id, cookie)).status).toBe(403);
    await host.admin.assignRole(staff, role);
    expect((await download(files.d1.id, cookie)).status).toBe(200);
  });

  it('refuses after a revoke (401), and after the link expires (401)', async () => {
    const revoked = await mint({ entity: folder('F'), permissions: [CAP_READ] });
    const revokedCookie = await cookieFor(revoked.secret);
    expect((await download(files.d1.id, revokedCookie)).status).toBe(200);
    await (await host.getScope(alice, t1, s1)).invoke('cap/unshare', { id: revoked.id });
    expect((await download(files.d1.id, revokedCookie)).status).toBe(401);

    const expiring = await mint({
      entity: folder('F'),
      permissions: [CAP_READ],
      expiresAt: new Date(Date.parse(clock.now()) + HOUR).toISOString() as Instant,
    });
    const expiringCookie = await cookieFor(expiring.secret);
    expect((await download(files.d1.id, expiringCookie)).status).toBe(200);
    clock.advance(HOUR + 1);
    expect((await download(files.d1.id, expiringCookie)).status).toBe(401);
  });

  it('a download is not a use', async () => {
    const minted = await mint({ entity: folder('F'), permissions: [CAP_READ], maxUses: 1 });
    const cookie = await cookieFor(minted.secret);
    for (let i = 0; i < 3; i++) expect((await download(files.d1.id, cookie)).status).toBe(200);
    expect((await recordOf(minted.id)).uses).toBe(1);
  });

  it('an upload through the link-share surface is refused and recorded, even with the write key', async () => {
    const minted = await mint({ entity: folder('F'), permissions: [CAP_READ, CAP_WRITE] });
    const res = await app.request('http://docs.test/api/upload', {
      method: 'POST',
      headers: headers(await cookieFor(minted.secret)),
    });
    expect(res.status).toBe(403);
    expect(await denials()).toContainEqual(
      expect.objectContaining({
        actor: JSON.stringify({ capability: minted.id }),
        permission: 'cap:write',
        operation: 'attachments.upload',
      }),
    );
    // The twin: the owner, signed in with no cookie, uploads through the same route.
    const owner = await app.request('http://docs.test/api/upload', { method: 'POST', headers: headers(null, alice) });
    expect(owner.status).toBe(200);
  });

  describe('who the download acts as', () => {
    it('with no cookie, a signed-in principal is used as themselves — the owner reads, carol is refused', async () => {
      expect((await download(files.d1.id, null, alice)).status).toBe(200);
      expect((await download(files.d1.id, null, carol)).status).toBe(403);
    });

    it('the capability wins over a signed-in principal: carol, holding nothing, downloads through the link', async () => {
      const minted = await mint({ entity: folder('F'), permissions: [CAP_READ] });
      expect((await download(files.d1.id, await cookieFor(minted.secret), carol)).status).toBe(200);
    });

    it('a host without the optional verb refuses a request carrying the cookie — it never answers as the signed-in visitor', async () => {
      // `getCapabilityAttachments` is optional on ScopeHost: a host built before it has only
      // `attachments`. Falling back to the principal there would break the precedence.
      const older = { attachments: host.attachments.bind(host) };
      const legacy = new Hono();
      mountLinkShareDownload(legacy, { host: () => older, node: () => node, principal: principalOf });
      const minted = await mint({ entity: folder('F'), permissions: [CAP_READ] });
      const cookie = await cookieFor(minted.secret);
      const url = `http://docs.test/api/capability/attachments/${files.d3.id}`;
      const refused = await legacy.request(url, { headers: headers(cookie, alice) });
      expect(refused.status).toBe(503);
      // The twin: the same host, no cookie — the owner reads as themselves.
      expect((await legacy.request(url, { headers: headers(null, alice) })).status).toBe(200);
    });

    it('with neither, 401; an unknown id through a live link, 404', async () => {
      expect((await download(files.d1.id, null)).status).toBe(401);
      const minted = await mint({ entity: folder('F'), permissions: [CAP_READ] });
      expect((await download(ulid(), await cookieFor(minted.secret))).status).toBe(404);
    });
  });
});
