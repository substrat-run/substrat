/**
 * Redeeming an upload link over HTTP, against a real scope host.
 *
 * The contract suite drives `redeemUploadLink` directly; this drives the route a `curl` meets —
 * a PUT carrying nothing but the URL — and checks what the route must never get wrong: which
 * status each refusal gets, that a refusal spends nothing, how the media type and the file
 * name are decided, and that the answer says nothing a cache, a log or another origin could
 * turn into a handle on the link.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  UPLOAD_LINK_PATH_PREFIX,
  UPLOAD_LINK_SECRET_PREFIX,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type EntityRef,
  type MintedUploadLink,
  type UploadLinkRecord,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { UPL_MAX_BYTES, UPL_READ, UPL_WRITE, uploadLinkMod } from '@substrat-run/contract-tests';
import {
  UPLOAD_LINK_LOG_PREFIX,
  UPLOAD_LINK_LOG_SECRET_PREFIX,
  mountUploadLinkRedeem,
  redactUploadLinkSecret,
  resolveUploadMediaType,
  sniffMediaType,
} from '../src/index.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const PDF = bytes('%PDF-1.4 a contract');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('mountUploadLinkRedeem — an upload link, over HTTP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-upl-http-'));
  const host = new SqliteScopeHost({ dir });
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const alice = principalId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const node = { tenantId: t1, scopeId: s1 };

  // What a vertical mounts — behind a BLANKET cors layer, the trap the route must survive.
  const app = new Hono();
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'PUT', 'POST'], exposeHeaders: ['etag'] }));
  mountUploadLinkRedeem(app, { host: () => host, node: () => node });
  app.get('/elsewhere', (c) => c.text('ok'));

  /**
   * A second mount of the same route over a host that counts what the route asks of it — so a
   * test can say "refused WITHOUT touching the scope" (or without reaching the write) and mean it.
   */
  const counted = () => {
    const calls = { host: 0, inspect: 0, redeem: 0 };
    const spied: Pick<ScopeHost, 'inspectUploadLink' | 'redeemUploadLink'> = {
      inspectUploadLink: (...a) => {
        calls.inspect++;
        return host.inspectUploadLink(...a);
      },
      redeemUploadLink: (...a) => {
        calls.redeem++;
        return host.redeemUploadLink(...a);
      },
    };
    const spyApp = new Hono();
    mountUploadLinkRedeem(spyApp, {
      host: () => {
        calls.host++;
        return spied;
      },
      node: () => node,
    });
    return { calls, app: spyApp };
  };

  let n = 0;
  const target = (): EntityRef => ({ entityType: 'udoc', entityId: `http-doc-${++n}` });
  const mint = async (entity: EntityRef, extra: Record<string, unknown> = {}): Promise<MintedUploadLink> =>
    (await host.getScope(alice, t1, s1)).invoke<MintedUploadLink>('upl/mint', { entity, ...extra });
  const put = (
    path: string,
    body: Uint8Array | string,
    headers: Record<string, string> = {},
    method = 'PUT',
  ): Promise<Response> =>
    Promise.resolve(app.request(`http://crm.test${path}`, { method, body: body as BodyInit, headers }));
  const filesOf = async (entity: EntityRef) => (await host.attachments(alice, t1, s1)).list(entity);
  const stateOf = async (id: string) =>
    (await (await host.getScope(alice, t1, s1)).invoke<UploadLinkRecord[]>('upl/list', {})).find((l) => l.id === id)!
      .state;

  beforeAll(async () => {
    host.registerModule(uploadLinkMod);
    await host.admin.createTenant(staff, { id: t1, slug: 'upl-http', name: 'Upload http' });
    await host.admin.grantEntitlement(staff, t1, 'upl');
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'upl-vertical' });
    await host.admin.activateScope(staff, t1, s1);
    await host.provisionBlobStore(staff, { tenantId: t1, vertical: 'upl-vertical', binding: 'ATTACHMENTS' });
    await host.admin.defineRole(staff, t1, { key: 'owner', permissions: [UPL_READ, UPL_WRITE], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t1, scopeId: null } });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a bare PUT — what `curl --upload-file` sends — lands the file; the answer is 201 and says nothing about the link', async () => {
    const entity = target();
    const minted = await mint(entity);
    const res = await put(`${minted.path}?filename=contract.pdf`, PDF);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ filename: 'contract.pdf', contentType: 'application/pdf', size: PDF.byteLength });
    expect(Object.keys(body).sort()).toEqual(['contentType', 'filename', 'id', 'sha256', 'size']);
    const stored = await filesOf(entity);
    expect(stored.map((r) => r.id)).toEqual([body.id]);
    expect(stored[0]!.createdBy).toBe(alice);

    // Response hygiene: nothing cacheable, nothing that is a handle on the bytes or the link.
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    for (const h of ['etag', 'last-modified', 'location', 'content-location']) expect(res.headers.get(h)).toBeNull();
    expect(JSON.stringify(body)).not.toContain(minted.secret);
  });

  it('POST works as PUT does', async () => {
    const entity = target();
    const minted = await mint(entity);
    const res = await put(`${minted.path}?filename=a.txt`, 'hello', {}, 'POST');
    expect(res.status).toBe(201);
    expect(await filesOf(entity)).toHaveLength(1);
  });

  it('answers 410 once the link is used — and adds nothing', async () => {
    const entity = target();
    const minted = await mint(entity);
    expect((await put(`${minted.path}?filename=a.txt`, 'one')).status).toBe(201);
    const again = await put(`${minted.path}?filename=a.txt`, 'two');
    expect(again.status).toBe(410);
    expect(again.headers.get('content-type')).toContain('application/problem+json');
    expect(((await again.json()) as { reason?: string }).reason).toBe('upload_link_gone');
    expect(await filesOf(entity)).toHaveLength(1);
  });

  it('answers 410 for a revoked link', async () => {
    const entity = target();
    const minted = await mint(entity);
    await (await host.getScope(alice, t1, s1)).invoke('upl/revoke', { id: minted.id });
    expect((await put(`${minted.path}?filename=a.txt`, 'x')).status).toBe(410);
  });

  it('answers 404 for a secret that names nothing, with no way to tell it from a malformed one', async () => {
    const entity = target();
    for (const secret of ['sbup_' + 'A'.repeat(43), 'nonsense']) {
      const res = await put(`${UPLOAD_LINK_PATH_PREFIX}/udoc/${entity.entityId}/${secret}`, 'x');
      expect(res.status).toBe(404);
    }
  });

  it('a malformed secret is the same 404, answered without asking the host, the scope or its Durable Object', async () => {
    const entity = target();
    const at = (secret: string) => `http://crm.test${UPLOAD_LINK_PATH_PREFIX}/udoc/${entity.entityId}/${secret}`;
    // The twin first: a well-shaped secret that names nothing IS asked about, and its answer is the reference.
    const shaped = counted();
    const unknown = await shaped.app.request(at('sbup_' + 'A'.repeat(43)), { method: 'PUT', body: 'x' });
    expect(unknown.status).toBe(404);
    expect(shaped.calls).toMatchObject({ host: 1, inspect: 1, redeem: 0 });
    const reference = await unknown.text();

    for (const secret of [
      'nonsense',
      'sbup_',
      'sbup_' + 'A'.repeat(42),
      'sbup_' + 'A'.repeat(44),
      'sbup_' + '!'.repeat(43),
      'sbcap_' + 'A'.repeat(43),
      'x'.repeat(500),
    ]) {
      const { calls, app: spyApp } = counted();
      const res = await spyApp.request(at(encodeURIComponent(secret)), { method: 'PUT', body: 'x' });
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(reference);
      expect(calls).toEqual({ host: 0, inspect: 0, redeem: 0 });
    }
  });

  it('a path naming another target is the same 404 whatever the link’s state — pending, used or revoked — and spends nothing', async () => {
    const entity = target();
    const other = target();
    const wrongPath = (m: MintedUploadLink) => `${UPLOAD_LINK_PATH_PREFIX}/udoc/${other.entityId}/${m.secret}?filename=a.txt`;
    const pending = await mint(entity);
    const used = await mint(entity);
    expect((await put(`${used.path}?filename=a.txt`, 'x')).status).toBe(201);
    const revoked = await mint(entity);
    await (await host.getScope(alice, t1, s1)).invoke('upl/revoke', { id: revoked.id });

    const answers = await Promise.all(
      [pending, used, revoked].map(async (m) => {
        const res = await put(wrongPath(m), 'x');
        return { status: res.status, reason: ((await res.json()) as { reason?: string }).reason };
      }),
    );
    expect(answers).toEqual([1, 2, 3].map(() => ({ status: 404, reason: 'upload_link_wrong_target' })));
    expect(await filesOf(other)).toEqual([]);
    // The twin: at their own path the spent links are gone, and the pending one still works.
    expect((await put(`${used.path}?filename=a.txt`, 'x')).status).toBe(410);
    expect((await put(`${revoked.path}?filename=a.txt`, 'x')).status).toBe(410);
    expect((await put(`${pending.path}?filename=a.txt`, 'x')).status).toBe(201);
  });

  it('a path naming another entity or another type is 404 and spends nothing; the right path then works', async () => {
    const entity = target();
    const minted = await mint(entity);
    const otherEntity = target();
    expect((await put(`${UPLOAD_LINK_PATH_PREFIX}/udoc/${otherEntity.entityId}/${minted.secret}?filename=a.txt`, 'x')).status).toBe(404);
    expect((await put(`${UPLOAD_LINK_PATH_PREFIX}/unote/${entity.entityId}/${minted.secret}?filename=a.txt`, 'x')).status).toBe(404);
    expect(await stateOf(minted.id)).toBe('pending');
    expect(await filesOf(otherEntity)).toEqual([]);
    expect((await put(`${minted.path}?filename=a.txt`, 'x')).status).toBe(201);
  });

  it('refuses an oversize body with 413 — by Content-Length before a byte is read, and by count when none is declared — and spends nothing', async () => {
    const entity = target();
    const minted = await mint(entity);
    const big = new Uint8Array(UPL_MAX_BYTES + 1).fill(97);
    const declared = await put(`${minted.path}?filename=a.txt`, big, { 'content-length': String(big.byteLength) });
    expect(declared.status).toBe(413);
    // No Content-Length: the body is counted as it arrives, and refused past the ceiling.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(big.slice(0, 40));
        c.enqueue(big.slice(40));
        c.close();
      },
    });
    const counted = await app.fetch(
      new Request(`http://crm.test${minted.path}?filename=a.txt`, {
        method: 'PUT',
        body: stream,
        headers: { 'content-type': 'text/plain' },
        duplex: 'half',
      } as RequestInit),
    );
    expect(counted.status).toBe(413);
    expect(await filesOf(entity)).toEqual([]);
    expect(await stateOf(minted.id)).toBe('pending');
    // The twin: a file at the limit goes through on the same link.
    expect((await put(`${minted.path}?filename=a.txt`, new Uint8Array(UPL_MAX_BYTES).fill(97))).status).toBe(201);
  });

  it('stops reading a chunked body one chunk past the ceiling: it cancels the stream, answers 413, and never reaches the write', async () => {
    const entity = target();
    const minted = await mint(entity);
    const CHUNK = 16;
    const OFFERED = 1000; // 16 000 bytes on offer — far past the 64 the link admits
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          if (pulls === OFFERED) return c.close();
          pulls++;
          c.enqueue(new Uint8Array(CHUNK).fill(97));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const { calls, app: spyApp } = counted();
    const res = await spyApp.fetch(
      new Request(`http://crm.test${minted.path}?filename=a.txt`, {
        method: 'PUT',
        body: stream,
        headers: { 'content-type': 'text/plain' },
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { reason?: string }).reason).toBe('upload_link_too_large');
    // Read up to the first chunk that crosses the ceiling, and a little read-ahead — never the body.
    expect(pulls).toBeLessThanOrEqual(Math.ceil(UPL_MAX_BYTES / CHUNK) + 2);
    expect(cancelled).toBe(true);
    // Refused by the route, not by the kernel after the bytes were handed on.
    expect(calls).toMatchObject({ inspect: 1, redeem: 0 });
    expect(await stateOf(minted.id)).toBe('pending');
    expect(await filesOf(entity)).toEqual([]);
  });

  it('refuses a disallowed type with 415 and spends nothing; the same link then takes an allowed one', async () => {
    const entity = target();
    const minted = await mint(entity);
    const exe = await put(`${minted.path}?filename=a.exe`, 'MZ', { 'content-type': 'application/x-msdownload' });
    expect(exe.status).toBe(415);
    expect(((await exe.json()) as { reason?: string }).reason).toBe('upload_link_type_refused');
    expect(await stateOf(minted.id)).toBe('pending');
    expect((await put(`${minted.path}?filename=a.png`, PNG, { 'content-type': 'image/png' })).status).toBe(201);
  });

  it('refuses an SVG under the link’s `image/*` with 415 — a family admits no active type — while a PNG goes through', async () => {
    const entity = target();
    const minted = await mint(entity);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>';
    const res = await put(`${minted.path}?filename=a.svg`, svg, { 'content-type': 'image/svg+xml' });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { reason?: string }).reason).toBe('upload_link_type_refused');
    expect(await filesOf(entity)).toEqual([]);
    expect(await stateOf(minted.id)).toBe('pending');
    expect((await put(`${minted.path}?filename=a.png`, PNG, { 'content-type': 'image/png' })).status).toBe(201);
  });

  it('refuses a file whose bytes contradict its name — a PNG called .pdf — with 415', async () => {
    const entity = target();
    const minted = await mint(entity);
    expect((await put(`${minted.path}?filename=contract.pdf`, PNG)).status).toBe(415);
    expect((await put(`${minted.path}?filename=contract.pdf`, PDF, { 'content-type': 'image/png' })).status).toBe(415);
    expect(await filesOf(entity)).toEqual([]);
    expect((await put(`${minted.path}?filename=contract.pdf`, PDF)).status).toBe(201);
  });

  it('refuses an empty body with 400', async () => {
    const minted = await mint(target());
    expect((await put(`${minted.path}?filename=a.txt`, new Uint8Array(0))).status).toBe(400);
    expect(await stateOf(minted.id)).toBe('pending');
  });

  it('answers 403 when the minter no longer holds the write key, and the link is still pending', async () => {
    const carol = principalId.parse(ulid());
    const role = { principalId: carol, roleKey: 'owner', node: { tenantId: t1, scopeId: s1 } };
    await host.admin.assignRole(staff, role);
    const entity = target();
    const minted = await (await host.getScope(carol, t1, s1)).invoke<MintedUploadLink>('upl/mint', { entity });
    await host.admin.unassignRole(staff, role);
    expect((await put(`${minted.path}?filename=a.txt`, 'x')).status).toBe(403);
    expect(await stateOf(minted.id)).toBe('pending');
  });

  it('names the file from a fixed link name, then ?filename=, then Content-Disposition — as a leaf, never a path', async () => {
    const fixed = target();
    const m1 = await mint(fixed, { filename: 'signed.pdf' });
    await put(`${m1.path}?filename=ignored.pdf`, PDF);
    expect((await filesOf(fixed))[0]!.filename).toBe('signed.pdf');

    const viaHeader = target();
    const m2 = await mint(viaHeader);
    await put(m2.path, 'x', { 'content-disposition': 'attachment; filename="from header.txt"' });
    expect((await filesOf(viaHeader))[0]!.filename).toBe('from header.txt');

    const traversal = target();
    const m3 = await mint(traversal);
    await put(`${m3.path}?filename=${encodeURIComponent('../../etc/passwd')}`, 'x');
    expect((await filesOf(traversal))[0]!.filename).toBe('passwd');

    const none = target();
    const m4 = await mint(none);
    await put(m4.path, 'x');
    expect((await filesOf(none))[0]!.filename).toBe('upload');
  });

  it('a blanket CORS layer in front of the app does not make the answer readable cross-origin', async () => {
    const minted = await mint(target());
    const res = await put(`${minted.path}?filename=a.txt`, 'x', { origin: 'https://evil.example' });
    expect(res.status).toBe(201);
    for (const h of ['access-control-allow-origin', 'access-control-allow-credentials', 'access-control-expose-headers']) {
      expect(res.headers.get(h)).toBeNull();
    }
    // The twin: the layer IS doing its job on a route that is not this one.
    const other = await app.request('http://crm.test/elsewhere', { headers: { origin: 'https://evil.example' } });
    expect(other.headers.get('access-control-allow-origin')).toBe('*');
  });

  describe('the secret in the path never reaches the invocation log', () => {
    it('is redacted, and the prefix the log spells is the contract’s', () => {
      expect(UPLOAD_LINK_LOG_PREFIX).toBe(UPLOAD_LINK_PATH_PREFIX);
      expect(redactUploadLinkSecret('/api/attachment-uploads/udoc/D1/sbup_abc123')).toBe(
        '/api/attachment-uploads/udoc/D1/[redacted]',
      );
      // The twin: no other path is touched.
      expect(redactUploadLinkSecret('/api/attachments/udoc/D1')).toBe('/api/attachments/udoc/D1');
      expect(redactUploadLinkSecret('/api/capability/attachments/01ABC')).toBe('/api/capability/attachments/01ABC');
    });

    it('is redacted wherever a secret-shaped segment sits, so a route of the vertical’s own that carries one is covered too', () => {
      expect(UPLOAD_LINK_LOG_SECRET_PREFIX).toBe(UPLOAD_LINK_SECRET_PREFIX);
      const secret = 'sbup_' + 'A'.repeat(43);
      expect(redactUploadLinkSecret(`/files/${secret}/raw`)).toBe('/files/[redacted]/raw');
      expect(redactUploadLinkSecret(`/${secret}`)).toBe('/[redacted]');
      expect(redactUploadLinkSecret(`/a/b/${secret}`)).toBe('/a/b/[redacted]');
      // The twin: a segment that merely contains the letters is not a secret.
      expect(redactUploadLinkSecret('/api/sbupfoo/x_sbup_y')).toBe('/api/sbupfoo/x_sbup_y');
    });

    it('the route has one path, the one the log redacts and the mint names — it takes no `path` option', () => {
      // @ts-expect-error -- `path` was removed: a custom mount would match no minted URL, and escape the redaction.
      mountUploadLinkRedeem(new Hono(), { host: () => host, node: () => node, path: '/elsewhere/:entityType/:entityId/:secret' });
    });
  });
});

describe('the media type decision', () => {
  it('prefers a specific Content-Type, then the extension, then the bytes, then octet-stream', () => {
    expect(resolveUploadMediaType('text/plain; charset=utf-8', 'a.bin', bytes('x'))).toBe('text/plain');
    expect(resolveUploadMediaType(undefined, 'a.csv', bytes('x'))).toBe('text/csv');
    expect(resolveUploadMediaType('application/octet-stream', 'a.csv', bytes('x'))).toBe('text/csv');
    expect(resolveUploadMediaType(undefined, 'upload', PDF)).toBe('application/pdf');
    expect(resolveUploadMediaType(undefined, 'upload', bytes('plain'))).toBe('application/octet-stream');
    expect(resolveUploadMediaType('image/jpg', 'a.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });

  it('refuses a claim the bytes contradict, in both directions', () => {
    expect(resolveUploadMediaType('application/pdf', 'a.pdf', PNG)).toBeNull();
    expect(resolveUploadMediaType('text/plain', 'a.txt', PDF)).toBeNull();
    expect(resolveUploadMediaType(undefined, 'a.pdf', bytes('not a pdf'))).toBeNull();
    expect(sniffMediaType(PNG)).toBe('image/png');
    expect(sniffMediaType(bytes('hello'))).toBeNull();
  });
});
