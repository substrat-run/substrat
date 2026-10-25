import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectionId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
} from '@substrat-run/contracts';
import {
  ulid,
  webCryptoSecretBox,
  type ByteStream,
  type OpenedAttachmentStream,
  type TenantBlobStore,
} from '@substrat-run/kernel';
import { permMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * A streamed attachment open on the pure adapter (#2514): the read gate is decided before the blob
 * store is touched, and the file is then read 64 KiB at a time as the consumer reads it, checked
 * against the record as it passes. The store is wrapped so every byte it reads from disk is counted,
 * and the consumer is slow (a macrotask per chunk), so a step that collected the file before handing
 * it on would show as a lead of the whole file.
 */
describe('streamed attachment open (pure adapter)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // The baked-in `permMod`'s attachment target on `item` (read=perm:read, write=perm:use).
  const PERM_READ = permissionKey.parse('perm:read');
  const PERM_USE = permissionKey.parse('perm:use');

  const CHUNK = 64 * 1024;
  const whole = (chunks: number): Uint8Array => {
    const bytes = new Uint8Array(chunks * CHUNK);
    for (let i = 0; i < chunks; i++) bytes.fill(i % 251, i * CHUNK, (i + 1) * CHUNK);
    return bytes;
  };

  /** What the store was asked, and how far its reads got ahead of the consumer. */
  const flow = { get: 0, getStream: 0, fromDisk: 0, consumed: 0, maxLead: 0 };
  /** Run once, after the read gate and before the store opens the object: the window a remove can land in. */
  let beforeOpen: (() => void) | undefined;

  const counting = (store: TenantBlobStore): TenantBlobStore => ({
    ...store,
    get: (key) => {
      flow.get++;
      beforeOpen?.();
      beforeOpen = undefined;
      return store.get(key);
    },
    getStream: async (key) => {
      flow.getStream++;
      beforeOpen?.();
      beforeOpen = undefined;
      const obj = await store.getStream!(key);
      if (!obj) return null;
      const source = obj.stream.getReader();
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            const { done, value } = await source.read();
            if (done) return controller.close();
            flow.fromDisk += value!.byteLength;
            flow.maxLead = Math.max(flow.maxLead, flow.fromDisk - flow.consumed);
            controller.enqueue(value!);
          },
          cancel: (reason) => source.cancel(reason),
        },
        { highWaterMark: 0 },
      );
      return { ...obj, stream };
    },
  });

  const world = async () => {
    Object.assign(flow, { get: 0, getStream: 0, fromDisk: 0, consumed: 0, maxLead: 0 });
    dir = mkdtempSync(join(tmpdir(), 'substrat-open-stream-'));
    const host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)),
      wrapBlobStore: counting,
    });
    host.registerModule(permMod);
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const editor: PrincipalId = principalId.parse(ulid());
    const reader: PrincipalId = principalId.parse(ulid());
    const outsider: PrincipalId = principalId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, { key: 'editor', permissions: [PERM_READ, PERM_USE], source: 'vertical' });
    await host.admin.defineRole(staff, t, { key: 'viewer', permissions: [PERM_READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: editor, roleKey: 'editor', node: { tenantId: t, scopeId: s } });
    await host.admin.assignRole(staff, { principalId: reader, roleKey: 'viewer', node: { tenantId: t, scopeId: s } });
    await host.provisionBlobStore(staff, { tenantId: t, vertical: 'docs', binding: 'ATTACHMENTS' });
    const att = await host.attachments(editor, t, s);
    const bytes = whole(64);
    const record = await att.upload({
      entity: { entityType: 'item', entityId: 'i1' },
      filename: 'drawing-set.pdf',
      contentType: 'application/pdf',
      visibility: 'internal',
      body: bytes,
    });
    Object.assign(flow, { get: 0, getStream: 0 });
    return { host, staff, t, s, reader, outsider, record, bytes };
  };

  /** The object file the upload wrote. */
  const objectFile = (): string => {
    const files = (readdirSync(dir!, { recursive: true }) as string[]).filter(
      (f) => f.includes('/att/') && !f.endsWith('.meta'),
    );
    expect(files).toHaveLength(1);
    return join(dir!, files[0]!);
  };

  /** Read slowly, counting into `flow`; the bytes and their digest, or the error. */
  async function readSlowly(stream: ByteStream) {
    const reader = stream.getReader();
    const hash = createHash('sha256');
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return { ok: true as const, size, sha256: hash.digest('hex') };
        size += value!.byteLength;
        hash.update(value!);
        flow.consumed = size;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch (error) {
      return { ok: false as const, size, error: (error as Error).message };
    }
  }

  it('streams a file as it is read, the bytes and digest the record names', async () => {
    const { host, t, s, reader, record, bytes } = await world();
    const opened = await (await host.attachments(reader, t, s)).openStream(record.id);
    expect(opened!.record).toEqual(record);
    expect(opened!.contentType).toBe('application/pdf');
    expect(opened!.body.length).toBe(bytes.byteLength);
    const out = await readSlowly(opened!.body.stream);
    expect(out).toEqual({ ok: true, size: bytes.byteLength, sha256: record.sha256 });
    // A couple of 64 KiB reads ahead of a slow consumer, out of 4 MiB.
    expect(flow.maxLead).toBeLessThanOrEqual(3 * CHUNK);
    expect(flow).toMatchObject({ get: 0, getStream: 1 });
  });

  it('the positive twin: the buffered open of the same file gives the same bytes', async () => {
    const { host, t, s, reader, record, bytes } = await world();
    const opened = await (await host.attachments(reader, t, s)).open(record.id);
    expect(Buffer.from(opened!.body).equals(Buffer.from(bytes))).toBe(true);
  });

  it('a refused read touches the blob store zero times', async () => {
    const { host, t, s, outsider, record } = await world();
    const att = await host.attachments(outsider, t, s);
    await expect(att.openStream(record.id)).rejects.toThrow(/perm:read|denied|forbidden/i);
    expect(flow).toMatchObject({ get: 0, getStream: 0, fromDisk: 0 });
  });

  it('an id the scope does not know is null, and touches the store zero times', async () => {
    const { host, t, s, reader } = await world();
    expect(await (await host.attachments(reader, t, s)).openStream(ulid())).toBeNull();
    expect(flow).toMatchObject({ get: 0, getStream: 0 });
  });

  it('bytes altered on disk at the same size error the stream before its last chunk', async () => {
    const { host, t, s, reader, record, bytes } = await world();
    writeFileSync(objectFile(), new Uint8Array(bytes.byteLength).fill(7));
    const opened = await (await host.attachments(reader, t, s)).openStream(record.id);
    const out = await readSlowly(opened!.body.stream);
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/do not match the recorded sha256/) });
    expect(out.size).toBeLessThan(bytes.byteLength);
  });

  it('a file that is not the recorded size is refused before a byte is handed on', async () => {
    const { host, t, s, reader, record } = await world();
    truncateSync(objectFile(), CHUNK);
    await expect((await host.attachments(reader, t, s)).openStream(record.id)).rejects.toThrow(
      new RegExp(`attachment ${record.id}: the stored object is ${CHUNK} bytes; its record says ${64 * CHUNK}`),
    );
    expect(flow.fromDisk).toBe(0);
  });

  it('a removed object is the integrity error a buffered open throws', async () => {
    const { host, t, s, reader, record } = await world();
    rmSync(objectFile());
    await expect((await host.attachments(reader, t, s)).openStream(record.id)).rejects.toThrow(/bytes missing/);
  });

  it.each(['openStream', 'open'] as const)('an object removed after the read gate, before %s reads it, is that same error, naming no host path', async (verb) => {
    const { host, t, s, reader, record } = await world();
    const file = objectFile();
    beforeOpen = () => rmSync(file);
    const err = await (await host.attachments(reader, t, s))[verb](record.id).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(new RegExp(`attachment ${record.id}: bytes missing from the blob store`));
    expect(err?.message).not.toContain(dir!);
    expect(err?.message).not.toMatch(/ENOENT/);
  });

  // In a dispatch, through `conn.openAttachmentStream`, is in `connector-reads.test.ts`, beside the
  // buffered read, where a real delivery admits it.
  it('a connection with a read grant streams it through its top-level surface; one without is refused first', async () => {
    const { host, staff, t, s, record, bytes } = await world();
    const conn = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: conn,
      tenantId: t,
      vertical: 'docs',
      provider: 'drive',
      label: 'drive',
      externalAccountRef: 'acct-1',
      scopes: [],
      secret: { apiToken: 'tok' },
    });
    await expect((await host.getConnectorAttachments(conn, s)).openStream(record.id)).rejects.toThrow(
      /perm:read|denied|forbidden/i,
    );
    expect(flow).toMatchObject({ get: 0, getStream: 0 });
    await host.admin.grantToConnection(staff, {
      connectionId: conn,
      permission: PERM_READ,
      node: { tenantId: t, scopeId: s },
      grantedBy: staff,
    });
    const opened: OpenedAttachmentStream | null = await (await host.getConnectorAttachments(conn, s)).openStream(record.id);
    expect(opened!.record.id).toBe(record.id);
    expect(await readSlowly(opened!.body.stream)).toEqual({ ok: true, size: bytes.byteLength, sha256: record.sha256 });
  });
});
