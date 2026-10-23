import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { isSizedByteStream, ulid, webCryptoSecretBox, type SizedByteStream, type TenantBlobStore } from '@substrat-run/kernel';
import { permMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * A streamed attachment upload on the pure adapter (#2498): the body reaches the per-tenant
 * directory as it is read, hashed and counted on the way, and the row is written after the
 * object, as for a buffer. The producer measures its own lead over what the store has read each
 * time it is asked for a chunk, and the store reads slowly, as a disk or a network does, so a
 * step that collected the body first would show as a lead of the whole body.
 */
describe('streamed attachment upload (pure adapter)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // The baked-in `permMod`'s attachment target on `item` (read=perm:read, write=perm:use).
  const PERM_READ = permissionKey.parse('perm:read');
  const PERM_USE = permissionKey.parse('perm:use');

  const CHUNK = 64 * 1024;
  const chunkOf = (i: number): Uint8Array => new Uint8Array(CHUNK).fill(i % 251);
  const flow = { produced: 0, consumed: 0, maxLead: 0 };

  /** `chunks` chunks, each made only when asked for. */
  const producer = (chunks: number): ReadableStream<Uint8Array> => {
    let i = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (i === chunks) return controller.close();
          const chunk = chunkOf(i++);
          flow.produced += chunk.byteLength;
          flow.maxLead = Math.max(flow.maxLead, flow.produced - flow.consumed);
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
  };

  /** Every chunk a streamed put reads passes through here first, one macrotask apart. */
  const slowReader = (store: TenantBlobStore): TenantBlobStore => ({
    ...store,
    put: (key, body, opts) => {
      if (!isSizedByteStream(body)) return store.put(key, body, opts);
      const source = body.stream.getReader();
      const stream = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            const { done, value } = await source.read();
            if (done) return controller.close();
            flow.consumed += value!.byteLength;
            await new Promise((resolve) => setTimeout(resolve, 0));
            controller.enqueue(value!);
          },
        },
        { highWaterMark: 0 },
      );
      const relayed: SizedByteStream = { stream, length: body.length };
      return store.put(key, relayed, opts);
    },
  });

  const world = async () => {
    Object.assign(flow, { produced: 0, consumed: 0, maxLead: 0 });
    dir = mkdtempSync(join(tmpdir(), 'substrat-attach-stream-'));
    const host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)),
      wrapBlobStore: slowReader,
    });
    host.registerModule(permMod);
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const editor: PrincipalId = principalId.parse(ulid());
    const reader: PrincipalId = principalId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, { key: 'editor', permissions: [PERM_READ, PERM_USE], source: 'vertical' });
    await host.admin.defineRole(staff, t, { key: 'viewer', permissions: [PERM_READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: editor, roleKey: 'editor', node: { tenantId: t, scopeId: s } });
    await host.admin.assignRole(staff, { principalId: reader, roleKey: 'viewer', node: { tenantId: t, scopeId: s } });
    await host.provisionBlobStore(staff, { tenantId: t, vertical: 'docs', binding: 'ATTACHMENTS' });
    return { host, t, s, editor, reader };
  };

  /** Every object file under the store directory (not the `.meta` sidecars). */
  const objectFiles = (): string[] =>
    (readdirSync(dir!, { recursive: true }) as string[]).filter((f) => f.includes('/att/') && !f.endsWith('.meta'));

  const item = { entityType: 'item', entityId: 'i1' };
  const upload = (body: Uint8Array | SizedByteStream) => ({
    entity: item,
    filename: 'drawing-set.pdf',
    contentType: 'application/pdf',
    visibility: 'internal' as const,
    body,
  });

  it('lands a stream as it is read, with the witness a buffer of the same bytes gets', async () => {
    const { host, t, s, editor } = await world();
    const att = await host.attachments(editor, t, s);
    const streamed = await att.upload(upload({ stream: producer(64), length: 64 * CHUNK }));
    // Read slowly, one chunk in flight: collecting the 4 MiB first would lead by all of it.
    expect(flow.maxLead).toBeLessThanOrEqual(2 * CHUNK);

    const whole = new Uint8Array(64 * CHUNK);
    for (let i = 0; i < 64; i++) whole.set(chunkOf(i), i * CHUNK);
    const buffered = await att.upload(upload(whole));
    expect(streamed.size).toBe(64 * CHUNK);
    expect(streamed.sha256).toBe(createHash('sha256').update(whole).digest('hex'));
    expect(streamed.sha256).toBe(buffered.sha256);

    const opened = await att.open(streamed.id);
    expect(Buffer.from(opened!.body).equals(Buffer.from(whole))).toBe(true);
    expect((await att.list(item)).map((r) => r.id).sort()).toEqual([streamed.id, buffered.id].sort());
  });

  it('a stream carrying more than it declared lands no object and no row', async () => {
    const { host, t, s, editor } = await world();
    const att = await host.attachments(editor, t, s);
    await expect(att.upload(upload({ stream: producer(3), length: 2 * CHUNK }))).rejects.toThrow(/more than/);
    expect(await att.list(item)).toEqual([]);
    expect(objectFiles()).toEqual([]);
  });

  it('a stream ending short of what it declared lands no object and no row', async () => {
    const { host, t, s, editor } = await world();
    const att = await host.attachments(editor, t, s);
    await expect(att.upload(upload({ stream: producer(2), length: 3 * CHUNK }))).rejects.toThrow(/ended after/);
    expect(await att.list(item)).toEqual([]);
    expect(objectFiles()).toEqual([]);
  });

  it('a refused write still lands the object first, then deletes it', async () => {
    const { host, t, s, reader } = await world();
    const att = await host.attachments(reader, t, s);
    await expect(att.upload(upload({ stream: producer(4), length: 4 * CHUNK }))).rejects.toThrow();
    // The bytes were read (object first), then compensated away when the gate refused.
    expect(flow.consumed).toBe(4 * CHUNK);
    expect(objectFiles()).toEqual([]);
  });
});
