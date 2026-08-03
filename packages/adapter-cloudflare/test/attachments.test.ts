import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { permissionKey, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import type { R2BlobStores } from '../src/r2.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * The attachment surface on the Cloudflare host (#473): the ledger + permission gate live
 * in the real ControlPlaneDO / ScopeDO (this suite runs in workerd against them), the R2
 * bucket-management client is faked at its interface (the REST client is d1/r2 unit-level),
 * and the per-tenant bucket is an in-memory Map behind the same `R2Bucket` slice the worker
 * uses. What this proves is the coordinator lifecycle: mint-once, the permission-gated
 * upload/list/open/remove through the DO, byte fidelity, and fail-closed configuration.
 *
 * Rides the baked-in `permMod` (contract-tests) attachmentTarget on `item`
 * (read=perm:read, write=perm:use) — a DO closes over a code-time module set, so the
 * target must be one the ScopeDO already carries.
 */
describe('attachment surface (cloudflare host)', () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const staff = platformActorId.parse(ulid());
  const PERM_READ = permissionKey.parse('perm:read');
  const PERM_USE = permissionKey.parse('perm:use');

  /** An in-memory `R2Bucket` — the minimal slice `r2TenantBlobStore` reaches through. */
  const fakeBucket = () => {
    const objs = new Map<string, { body: Uint8Array; contentType?: string }>();
    return {
      objs,
      bucket: {
        put: async (key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) => {
          objs.set(key, { body: new Uint8Array(value), contentType: options?.httpMetadata?.contentType });
        },
        get: async (key: string) => {
          const o = objs.get(key);
          if (!o) return null;
          return {
            arrayBuffer: async () => o.body.buffer.slice(o.body.byteOffset, o.body.byteOffset + o.body.byteLength),
            httpMetadata: o.contentType ? { contentType: o.contentType } : undefined,
          };
        },
        delete: async (key: string) => {
          objs.delete(key);
        },
        list: async (options?: { prefix?: string }) => ({
          objects: [...objs.keys()].filter((k) => !options?.prefix || k.startsWith(options.prefix)).map((key) => ({ key })),
          truncated: false as const,
        }),
      },
    };
  };

  const fakeR2 = () => {
    const created: string[] = [];
    let n = 0;
    const r2: R2BlobStores = {
      create: async (name) => {
        created.push(name);
        n += 1;
        return name;
      },
      remove: async () => {},
    };
    return { r2, created, get n() { return n; } };
  };

  const world = async () => {
    const fake = fakeR2();
    const bucket = fakeBucket();
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      blobStores: fake.r2,
      attachmentBuckets: () => bucket.bucket,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const editor = principalId.parse(ulid()); // perm:use + perm:read
    const reader = principalId.parse(ulid()); // perm:read only
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, { key: 'editor', permissions: [PERM_READ, PERM_USE], source: 'vertical' });
    await host.admin.defineRole(staff, t, { key: 'viewer', permissions: [PERM_READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: editor, roleKey: 'editor', node: { tenantId: t, scopeId: s } });
    await host.admin.assignRole(staff, { principalId: reader, roleKey: 'viewer', node: { tenantId: t, scopeId: s } });
    await host.provisionBlobStore(staff, { tenantId: t, vertical: 'docs', binding: 'ATTACHMENTS' });
    return { host, t, s, editor, reader, ...fake, bucket };
  };

  const bytes = (v: string) => new TextEncoder().encode(v);

  it('mints one bucket per (tenant, vertical, binding), idempotently, through the ledger', async () => {
    const { host, t, created } = await world();
    expect(created).toHaveLength(1); // provisioned once in world()
    const again = await host.provisionBlobStore(staff, { tenantId: t, vertical: 'docs', binding: 'ATTACHMENTS' });
    expect(again.kind).toBe('blob');
    expect(created).toHaveLength(1); // ledger short-circuits — no second bucket
    const ledger = await host.admin.listBlobStores(staff, { tenantId: t });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.binding).toBe('ATTACHMENTS');
  });

  it('uploads → lists → opens with byte fidelity, bytes landing in R2 not the DO', async () => {
    const { host, t, s, editor, bucket } = await world();
    const att = await host.attachments(editor, t, s);
    const rec = await att.upload({
      entity: { entityType: 'item', entityId: 'i1' },
      filename: 'before.jpg',
      contentType: 'image/jpeg',
      visibility: 'internal',
      body: bytes('the photo bytes'),
    });
    // The object is in the per-tenant bucket under the scope-prefixed key.
    expect([...bucket.objs.keys()]).toEqual([`scope/${s}/att/${rec.id}`]);

    const listed = await att.list({ entityType: 'item', entityId: 'i1' });
    expect(listed.map((r) => r.id)).toEqual([rec.id]);
    const opened = await att.open(rec.id);
    expect(new TextDecoder().decode(opened!.body)).toBe('the photo bytes');
    expect(opened!.contentType).toBe('image/jpeg');
  });

  it('gates by the declared target permission (read=perm:read, write=perm:use)', async () => {
    const { host, t, s, editor, reader } = await world();
    const rec = await (await host.attachments(editor, t, s)).upload({
      entity: { entityType: 'item', entityId: 'i1' },
      filename: 'note.txt',
      contentType: 'text/plain',
      visibility: 'internal',
      body: bytes('hello'),
    });
    const viewer = await host.attachments(reader, t, s);
    await expect(viewer.list({ entityType: 'item', entityId: 'i1' })).resolves.toHaveLength(1);
    await expect(viewer.open(rec.id)).resolves.not.toBeNull();
    await expect(
      viewer.upload({
        entity: { entityType: 'item', entityId: 'i1' },
        filename: 'x',
        contentType: 'text/plain',
        visibility: 'internal',
        body: bytes('x'),
      }),
    ).rejects.toThrow();
    await expect(viewer.remove(rec.id)).rejects.toThrow();
  });

  it('rolls the upload back on a refused write — no orphaned object survives', async () => {
    const { host, t, s, reader, bucket } = await world();
    await expect(
      (await host.attachments(reader, t, s)).upload({
        entity: { entityType: 'item', entityId: 'i1' },
        filename: 'x',
        contentType: 'text/plain',
        visibility: 'internal',
        body: bytes('x'),
      }),
    ).rejects.toThrow();
    expect([...bucket.objs.keys()]).toEqual([]); // compensating delete ran
  });

  it('removes: row gone, bytes gone, list empty', async () => {
    const { host, t, s, editor, bucket } = await world();
    const att = await host.attachments(editor, t, s);
    const rec = await att.upload({
      entity: { entityType: 'item', entityId: 'i1' },
      filename: 'gone.txt',
      contentType: 'text/plain',
      visibility: 'customer',
      body: bytes('remove me'),
    });
    await att.remove(rec.id);
    expect([...bucket.objs.keys()]).toEqual([]);
    await expect(att.list({ entityType: 'item', entityId: 'i1' })).resolves.toEqual([]);
    await expect(att.open(rec.id)).resolves.toBeNull();
  });

  // -- a connection as the uploader (#476): getConnectorAttachments -----------

  const withConnection = async (opts: { grantWrite: boolean }) => {
    const w = await world();
    const connId = ulid();
    await w.host.admin.createConnection(staff, {
      id: connId as never,
      tenantId: w.t,
      vertical: 'docs',
      provider: 'signer',
      label: 'signer',
      secret: { accessToken: 'x' },
    });
    if (opts.grantWrite) {
      await w.host.admin.grantToConnection(staff, {
        connectionId: connId,
        permission: PERM_USE, // the target's write key; the connection gets nothing else
        node: { tenantId: w.t, scopeId: w.s },
        grantedBy: staff,
      });
    }
    return { ...w, connId };
  };

  it('lets a granted connection upload as itself, bytes in R2, attributed to the connection', async () => {
    const { host, t, s, editor, bucket, connId } = await withConnection({ grantWrite: true });
    const att = await host.getConnectorAttachments(connId as never, s);
    const rec = await att.upload({
      entity: { entityType: 'item', entityId: 'i1' },
      filename: 'sealed.pdf',
      contentType: 'application/pdf',
      visibility: 'customer',
      body: bytes('the sealed bytes'),
    });
    expect(rec.createdBy).toBe(connId);
    expect([...bucket.objs.keys()]).toEqual([`scope/${s}/att/${rec.id}`]);
    // A principal with read sees the landed row + bytes.
    const opened = await (await host.attachments(editor, t, s)).open(rec.id);
    expect(new TextDecoder().decode(opened!.body)).toBe('the sealed bytes');
  });

  it('refuses a connection that was never granted the write key (fail closed)', async () => {
    const { host, s, bucket, connId } = await withConnection({ grantWrite: false });
    const att = await host.getConnectorAttachments(connId as never, s);
    await expect(
      att.upload({
        entity: { entityType: 'item', entityId: 'i1' },
        filename: 'x.pdf',
        contentType: 'application/pdf',
        visibility: 'internal',
        body: bytes('x'),
      }),
    ).rejects.toThrow();
    expect([...bucket.objs.keys()]).toEqual([]); // compensating delete ran
  });

  it('refuses loudly when no R2 client / bucket resolver is configured', async () => {
    const bare = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    const t = tenantId.parse(ulid());
    await bare.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await expect(
      bare.provisionBlobStore(staff, { tenantId: t, vertical: 'docs', binding: 'ATTACHMENTS' }),
    ).rejects.toThrow(/not configured/);
  });
});
