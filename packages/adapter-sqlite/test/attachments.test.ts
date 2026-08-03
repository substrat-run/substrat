import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  moduleManifest,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * The attachment surface end-to-end on the pure adapter (#473) — `attachmentTargets`
 * consumed at last. The pure adapter runs the WHOLE kernel path in-process (permission
 * gate, metadata fact, spine event, bytes to the per-tenant directory store), so this is
 * where the design is proven; the Cloudflare adapter mirrors it against faked R2.
 */
describe('attachment surface (pure adapter)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const DOC_READ = permissionKey.parse('doc:read');
  const DOC_WRITE = permissionKey.parse('doc:write');

  // A module declaring an attachment target with distinct read/write gates.
  const docMod = {
    manifest: moduleManifest.parse({
      id: '@test/doc',
      version: '1.0.0',
      kernelContract: '^0.0.1',
      permissions: [
        { key: 'doc:read', description: 'read a doc and its attachments' },
        { key: 'doc:write', description: 'attach to / detach from a doc' },
      ],
      events: {
        emits: [
          { type: 'attachment.added', schemaVersion: 1 },
          { type: 'attachment.removed', schemaVersion: 1 },
        ],
        consumes: [],
      },
      migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
      attachmentTargets: [{ entityType: 'doc', readPermission: 'doc:read', writePermission: 'doc:write' }],
      entitlementKey: 'doc',
    }),
  };

  const world = async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-attach-'));
    const host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)),
    });
    host.registerModule(docMod);
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const editor: PrincipalId = principalId.parse(ulid()); // holds doc:read + doc:write
    const reader: PrincipalId = principalId.parse(ulid()); // holds doc:read only
    const stranger: PrincipalId = principalId.parse(ulid()); // holds nothing

    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'doc');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, { key: 'editor', permissions: [DOC_READ, DOC_WRITE], source: 'vertical' });
    await host.admin.defineRole(staff, t, { key: 'viewer', permissions: [DOC_READ], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: editor, roleKey: 'editor', node: { tenantId: t, scopeId: s } });
    await host.admin.assignRole(staff, { principalId: reader, roleKey: 'viewer', node: { tenantId: t, scopeId: s } });
    await host.provisionBlobStore(staff, { tenantId: t, vertical: 'docs', binding: 'ATTACHMENTS' });
    return { host, staff, t, s, editor, reader, stranger };
  };

  const bytes = (s: string) => new TextEncoder().encode(s);

  it('uploads, lists, and opens an attachment with byte fidelity', async () => {
    const { host, t, s, editor } = await world();
    const att = await host.attachments(editor, t, s);
    const rec = await att.upload({
      entity: { entityType: 'doc', entityId: 'd1' },
      filename: 'before.jpg',
      contentType: 'image/jpeg',
      visibility: 'internal',
      body: bytes('the photo bytes'),
    });
    expect(rec.filename).toBe('before.jpg');
    expect(rec.size).toBe(bytes('the photo bytes').byteLength);
    expect(rec.sha256).toMatch(/^[0-9a-f]{64}$/);

    const listed = await att.list({ entityType: 'doc', entityId: 'd1' });
    expect(listed.map((r) => r.id)).toEqual([rec.id]);

    const opened = await att.open(rec.id);
    expect(opened).not.toBeNull();
    expect(new TextDecoder().decode(opened!.body)).toBe('the photo bytes');
    expect(opened!.contentType).toBe('image/jpeg');
  });

  it('gates reads and writes by the declared target permission', async () => {
    const { host, t, s, editor, reader, stranger } = await world();
    const rec = await (await host.attachments(editor, t, s)).upload({
      entity: { entityType: 'doc', entityId: 'd1' },
      filename: 'note.txt',
      contentType: 'text/plain',
      visibility: 'internal',
      body: bytes('hello'),
    });

    // A viewer (doc:read only) may list and open, but not upload or remove.
    const viewer = await host.attachments(reader, t, s);
    await expect(viewer.list({ entityType: 'doc', entityId: 'd1' })).resolves.toHaveLength(1);
    await expect(viewer.open(rec.id)).resolves.not.toBeNull();
    await expect(
      viewer.upload({
        entity: { entityType: 'doc', entityId: 'd1' },
        filename: 'x',
        contentType: 'text/plain',
        visibility: 'internal',
        body: bytes('x'),
      }),
    ).rejects.toThrow();
    await expect(viewer.remove(rec.id)).rejects.toThrow();

    // A stranger (no grant) may not even read.
    const outsider = await host.attachments(stranger, t, s);
    await expect(outsider.list({ entityType: 'doc', entityId: 'd1' })).rejects.toThrow();
    await expect(outsider.open(rec.id)).rejects.toThrow();
  });

  it('rolls the upload back on a refused write — no orphaned object survives', async () => {
    const { host, staff, t, s, reader } = await world();
    const att = await host.attachments(reader, t, s); // doc:read only, so upload is refused
    await expect(
      att.upload({
        entity: { entityType: 'doc', entityId: 'd1' },
        filename: 'x.txt',
        contentType: 'text/plain',
        visibility: 'internal',
        body: bytes('x'),
      }),
    ).rejects.toThrow();
    // The compensating delete ran: the store's backing directory holds no object files for
    // this scope (an empty leftover directory is fine — bytes are what must be gone).
    const [store] = await host.admin.listBlobStores(staff, { vertical: 'docs' });
    const objectsRoot = join(dir!, store!.ref, 'scope', s);
    const files: string[] = [];
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else files.push(e.name);
      }
    };
    walk(objectsRoot);
    expect(files).toEqual([]);
  });

  it('removes an attachment: row gone, bytes gone, list empty', async () => {
    const { host, t, s, editor } = await world();
    const att = await host.attachments(editor, t, s);
    const rec = await att.upload({
      entity: { entityType: 'doc', entityId: 'd1' },
      filename: 'gone.txt',
      contentType: 'text/plain',
      visibility: 'customer',
      body: bytes('remove me'),
    });
    const removed = await att.remove(rec.id);
    expect(removed?.id).toBe(rec.id);
    await expect(att.list({ entityType: 'doc', entityId: 'd1' })).resolves.toEqual([]);
    await expect(att.open(rec.id)).resolves.toBeNull();
  });

  it('refuses an undeclared entity type', async () => {
    const { host, t, s, editor } = await world();
    const att = await host.attachments(editor, t, s);
    await expect(
      att.upload({
        entity: { entityType: 'widget', entityId: 'w1' },
        filename: 'x',
        contentType: 'text/plain',
        visibility: 'internal',
        body: bytes('x'),
      }),
    ).rejects.toThrow(/attachmentTargets/);
  });

  it('carries attachment metadata rows in a scope export (pull/restore/PITR follow)', async () => {
    const { host, staff, t, s, editor } = await world();
    await (await host.attachments(editor, t, s)).upload({
      entity: { entityType: 'doc', entityId: 'd1' },
      filename: 'evidence.jpg',
      contentType: 'image/jpeg',
      visibility: 'internal',
      body: bytes('bytes'),
    });
    const dump = await host.admin.exportScope(staff, t, s);
    const table = dump.tables.find((tbl) => tbl.name === '_substrat_attachments');
    expect(table).toBeDefined();
    expect(table!.rows).toHaveLength(1);
  });

  // -- a connection as the uploader (#476): getConnectorAttachments -----------
  //
  // A signing connector fetches the sealed PDF and must land it into the scope, but
  // it is a connection, not a person. This is the mirror of getConnectorScope for
  // bytes: the same surface, gated on the connection's own grants.

  const withConnection = async (opts: { grantWrite: boolean }) => {
    const world0 = await world();
    const connId = ulid();
    await world0.host.admin.createConnection(world0.staff, {
      id: connId as never,
      tenantId: world0.t,
      vertical: 'docs',
      provider: 'signer',
      label: 'signer',
      secret: { token: 'x' },
    });
    if (opts.grantWrite) {
      // The write key ONLY — mirrors granting a Scrive connection `protocol:attach`
      // and nothing else, so it can land bytes but not browse the scope's attachments.
      await world0.host.admin.grantToConnection(world0.staff, {
        connectionId: connId,
        permission: DOC_WRITE,
        node: { tenantId: world0.t, scopeId: world0.s },
        grantedBy: world0.staff,
      });
    }
    return { ...world0, connId };
  };

  it('lets a granted connection upload as itself, attributed to the connection', async () => {
    const { host, t, s, editor, connId } = await withConnection({ grantWrite: true });
    const att = await host.getConnectorAttachments(connId as never, s);
    const rec = await att.upload({
      entity: { entityType: 'doc', entityId: 'd1' },
      filename: 'sealed.pdf',
      contentType: 'application/pdf',
      visibility: 'customer',
      body: bytes('the sealed bytes'),
    });
    // createdBy is the connection id, not a laundered principal.
    expect(rec.createdBy).toBe(connId);

    // The bytes and row really landed: a principal with read sees them.
    const opened = await (await host.attachments(editor, t, s)).open(rec.id);
    expect(opened).not.toBeNull();
    expect(new TextDecoder().decode(opened!.body)).toBe('the sealed bytes');
  });

  it('refuses a connection that was never granted the write key (fail closed)', async () => {
    const { host, s, connId } = await withConnection({ grantWrite: false });
    const att = await host.getConnectorAttachments(connId as never, s);
    await expect(
      att.upload({
        entity: { entityType: 'doc', entityId: 'd1' },
        filename: 'x.pdf',
        contentType: 'application/pdf',
        visibility: 'internal',
        body: bytes('x'),
      }),
    ).rejects.toThrow();
  });

  it('refuses a scope the connection is not for', async () => {
    const { host, staff, t, connId } = await withConnection({ grantWrite: true });
    const otherScope = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: otherScope, vertical: 'other' });
    await host.admin.activateScope(staff, t, otherScope);
    await expect(host.getConnectorAttachments(connId as never, otherScope)).rejects.toThrow(
      /vertical|unknown scope/,
    );
  });

  it('fails closed when no blob store is provisioned for the vertical', async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-attach-'));
    const host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)),
    });
    host.registerModule(docMod);
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const editor = principalId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'doc');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    // No provisionBlobStore call.
    await expect(host.attachments(editor, t, s)).rejects.toThrow(/no blob store provisioned/);
  });
});
