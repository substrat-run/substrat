import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  connectionId as connectionIdOf,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
} from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost, type ConnectorDelegation } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * The connector write-back seam (#574), both halves, against the real DOs in workerd.
 *
 * FAR END — a CP-less host (the hosted-vertical shape): `connectorGrantLocal` delivers
 * the scope-local `connection:<id>` tuple, `connectorInvokeLocal` invokes as the
 * connection and is gated by exactly that tuple (fail closed without it), and the
 * emitted event's actor is the connection — not a laundered principal.
 *
 * PLATFORM END — a CP-full host with `connectorDelegation` (the shared control plane
 * shape): the directory gates still run here, then `getConnectorScope().invoke`,
 * `getConnectorAttachments().upload`, and scope-level `grantToConnection` ride the
 * delegation instead of touching this host's own (module-less) scope namespace;
 * tenant-level grants stay directory-side.
 */
describe('connector write-back (#574)', () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const staff = platformActorId.parse(ulid());
  const USE = permissionKey.parse('perm:use');
  const READ = permissionKey.parse('perm:read');
  const box = () => webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));

  describe('the far end — a CP-less host serving delegated connector calls', () => {
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const owner = principalId.parse(ulid());
    const conn = connectionIdOf.parse(ulid());

    /** An in-memory bucket, the minimal slice `r2TenantBlobStore` reaches through. */
    const objs = new Map<string, { body: Uint8Array; contentType?: string }>();
    const bucket = {
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
      list: async () => ({ objects: [...objs.keys()].map((key) => ({ key })), truncated: false as const }),
    };

    const hostFor = () =>
      new CloudflareScopeHost({
        scope: env.SCOPE,
        secretBox: box(),
        attachmentBuckets: () => bucket,
      });

    beforeAll(async () => {
      await hostFor().provisionScopeLocal({
        tenantId: t,
        scopeId: s,
        owner,
        roles: [{ key: 'office-admin', permissions: [USE, READ], source: 'vertical' }],
        ownerRoleKey: 'office-admin',
      });
    });

    it('fails closed before the grant is delivered — no tuple, no invoke', async () => {
      await expect(
        hostFor().connectorInvokeLocal(conn, t, s, 'perm/authorized-emit', { permission: USE }),
      ).rejects.toThrow(/denied/i);
    });

    it('invokes as the connection once the grant tuple is delivered, actor = the connection', async () => {
      const host = hostFor();
      await host.connectorGrantLocal(conn, s, USE);
      await host.connectorInvokeLocal(conn, t, s, 'perm/authorized-emit', { permission: USE });
      const q = await host.introspectScopeQuery(s, {
        sql: "SELECT actor FROM _substrat_outbox WHERE type = 'perm.acted'",
      });
      expect(q.rows).toHaveLength(1);
      expect(JSON.parse(String(q.rows[0]![0]))).toEqual({ connection: conn });
    });

    it('delivers grants WITH provisioning (#592) — a scope provisioned after the grant invokes at once', async () => {
      // The acceptance property: no `connectorGrantLocal` hand-write for this scope —
      // the grant rides `provisionScopeLocal` exactly as entitlements/identity links do,
      // so an install provisioned AFTER `grantToConnection` holds the return path too.
      const s2 = scopeId.parse(ulid());
      const host = hostFor();
      await host.provisionScopeLocal({
        tenantId: t,
        scopeId: s2,
        owner,
        roles: [{ key: 'office-admin', permissions: [USE, READ], source: 'vertical' }],
        ownerRoleKey: 'office-admin',
        connectionGrants: [{ connectionId: conn, permission: USE }],
      });
      await host.connectorInvokeLocal(conn, t, s2, 'perm/authorized-emit', { permission: USE });
      const q = await host.introspectScopeQuery(s2, {
        sql: "SELECT actor FROM _substrat_outbox WHERE type = 'perm.acted'",
      });
      expect(q.rows).toHaveLength(1);
      expect(JSON.parse(String(q.rows[0]![0]))).toEqual({ connection: conn });
    });

    it('an expired tuple enforces nothing (fail closed on expiry)', async () => {
      const expiredConn = connectionIdOf.parse(ulid());
      const host = hostFor();
      await host.connectorGrantLocal(expiredConn, s, USE, new Date(Date.now() - 60_000).toISOString());
      await expect(
        host.connectorInvokeLocal(expiredConn, t, s, 'perm/authorized-emit', { permission: USE }),
      ).rejects.toThrow(/denied/i);
    });

    it('lands connector bytes gated by the same tuple, createdBy = the connection', async () => {
      const host = hostFor();
      const rec = await host.connectorAttachmentUploadLocal(conn, t, s, {
        entity: { entityType: 'item', entityId: 'i1' },
        filename: 'sealed.pdf',
        contentType: 'application/pdf',
        visibility: 'customer',
        body: new TextEncoder().encode('the sealed bytes'),
      });
      expect(rec.createdBy).toBe(conn);
      expect([...objs.keys()]).toEqual([`scope/${s}/att/${rec.id}`]);
    });

    it('refuses the bytes of a connection that holds no grant', async () => {
      const stranger = connectionIdOf.parse(ulid());
      await expect(
        hostFor().connectorAttachmentUploadLocal(stranger, t, s, {
          entity: { entityType: 'item', entityId: 'i1' },
          filename: 'x.pdf',
          contentType: 'application/pdf',
          visibility: 'internal',
          body: new TextEncoder().encode('x'),
        }),
      ).rejects.toThrow();
    });
  });

  describe('the platform end — a delegating CP-full host', () => {
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const connId = ulid();

    type Recorded = { grant: unknown[]; invoke: unknown[]; upload: unknown[]; open: unknown[] };
    const recorded: Recorded = { grant: [], invoke: [], upload: [], open: [] };
    const delegation: ConnectorDelegation = {
      invoke: async (a) => {
        recorded.invoke.push(a);
        return { recorded: 1 };
      },
      uploadAttachment: async (a) => {
        recorded.upload.push(a);
        return {
          id: ulid(),
          entity: a.upload.entity,
          filename: a.upload.filename,
          contentType: a.upload.contentType,
          size: a.upload.body.byteLength,
          sha256: 'x'.repeat(64),
          visibility: a.upload.visibility,
          createdBy: a.connectionId,
          createdAt: new Date().toISOString(),
        } as never;
      },
      // #711: the outbound leg — the vertical's own document, fetched back by id.
      openAttachment: async (a) => {
        recorded.open.push(a);
        if (a.attachmentId === 'missing') return null;
        const body = new TextEncoder().encode('%PDF-1.4 the avtal');
        return {
          record: {
            id: a.attachmentId,
            entity: { entityType: 'protocol', entityId: 'p1' },
            filename: 'avtal.pdf',
            contentType: 'application/pdf',
            size: body.byteLength,
            sha256: 'a'.repeat(64),
            visibility: 'customer',
            createdBy: a.connectionId,
            createdAt: new Date().toISOString(),
          },
          body,
          contentType: 'application/pdf',
        } as never;
      },
      grant: async (a) => {
        recorded.grant.push(a);
      },
    };

    const hostFor = () =>
      new CloudflareScopeHost({
        scope: env.SCOPE,
        controlPlane: env.CONTROL_PLANE,
        secretBox: box(),
        connectorDelegation: delegation,
      });

    beforeAll(async () => {
      const host = hostFor();
      await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await host.admin.grantEntitlement(staff, t, 'perm');
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
      await host.admin.activateScope(staff, t, s);
      await host.admin.createConnection(staff, {
        id: connId as never,
        tenantId: t,
        vertical: 'docs',
        provider: 'signer',
        label: 'signer',
        secret: { accessToken: 'x' },
      });
    });

    it('routes a SCOPE-level grantToConnection through the delegation, after the directory gates', async () => {
      await hostFor().admin.grantToConnection(staff, {
        connectionId: connId,
        permission: USE,
        node: { tenantId: t, scopeId: s },
        grantedBy: staff,
      });
      expect(recorded.grant).toEqual([
        { connectionId: connId, tenantId: t, scopeId: s, vertical: 'docs', permission: USE, expiresAt: undefined },
      ]);
    });

    it('keeps a TENANT-level grantToConnection directory-side — no delegation', async () => {
      const before = recorded.grant.length;
      await hostFor().admin.grantToConnection(staff, {
        connectionId: connId,
        permission: READ,
        node: { tenantId: t, scopeId: null },
        grantedBy: staff,
      });
      expect(recorded.grant.length).toBe(before);
    });

    it('records BOTH grants directory-side (#592) — the gather provision/reconcile read', async () => {
      const rows = await hostFor().admin.listConnectionGrants(staff, t);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => [r.permission, r.scopeId]).sort()).toEqual([
        [READ, null],
        [USE, s],
      ]);
      expect(rows.every((r) => r.vertical === 'docs' && r.revokedAt === null)).toBe(true);
    });

    it('routes getConnectorScope().invoke through the delegation and returns its answer', async () => {
      const scope = await hostFor().getConnectorScope(connId as never, s);
      const out = await scope.invoke('protocol/record-signature', { requestId: 'r1' });
      expect(out).toEqual({ recorded: 1 });
      expect(recorded.invoke).toEqual([
        {
          connectionId: connId,
          tenantId: t,
          scopeId: s,
          vertical: 'docs',
          operation: 'protocol/record-signature',
          input: { requestId: 'r1' },
        },
      ]);
    });

    it('still refuses the directory gates locally — an unknown connection never reaches the seam', async () => {
      await expect(hostFor().getConnectorScope(ulid() as never, s)).rejects.toThrow(/connection not found/);
      expect(recorded.invoke).toHaveLength(1);
    });

    it('routes attachment upload and open through the delegation; the rest fail loudly', async () => {
      const att = await hostFor().getConnectorAttachments(connId as never, s);
      const rec = await att.upload({
        entity: { entityType: 'item', entityId: 'i1' },
        filename: 'sealed.pdf',
        contentType: 'application/pdf',
        visibility: 'customer',
        body: new TextEncoder().encode('bytes'),
      });
      expect(rec.createdBy).toBe(connId);
      expect(recorded.upload).toHaveLength(1);

      // #711: `open` crosses the seam too — the platform runs the vertical's signing
      // connector and must send the document the VERTICAL rendered, whose bytes live
      // in the vertical's own R2 and DO, not here.
      const opened = await att.open('att-1');
      expect(new TextDecoder().decode(opened!.body)).toBe('%PDF-1.4 the avtal');
      expect(recorded.open).toEqual([
        { connectionId: connId, tenantId: t, scopeId: s, vertical: 'docs', attachmentId: 'att-1' },
      ]);
      // An id the vertical does not know is `null`, not a throw — a caller falls back
      // rather than failing a dispatch over a missing file.
      await expect(att.open('missing')).resolves.toBeNull();

      // `list` stays undelegated ON PURPOSE, not for want of plumbing: a connector
      // names the document it sends by id, so a search seam would only reintroduce
      // the ambiguity the id design removes (#711).
      await expect(att.list({ entityType: 'item', entityId: 'i1' })).rejects.toThrow(/not delegated/);
      await expect(att.remove('x')).rejects.toThrow(/not delegated/);
    });
  });
});
