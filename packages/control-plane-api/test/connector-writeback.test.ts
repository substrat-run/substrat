import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { mountPlatformSurface, type VerticalScopeHost } from '@substrat-run/vertical-host';
import {
  connectionId as connectionIdOf,
  permissionKey,
  scopeId as scopeIdOf,
  tenantId as tenantIdOf,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { VerticalClient, ControlPlaneError } from '../src/index.js';

/**
 * The connector write-back seam END TO END (#574): the real `VerticalClient` verbs
 * against the real `mountPlatformSurface` routes — the exact wire the shared control
 * plane and a hosted vertical speak. A hand-rolled fetch on either side would let the
 * two drift (a renamed multipart field, a changed envelope) without any test noticing;
 * this one fails on the mismatch.
 */

type Env = { PLATFORM_SECRET: string };
const SECRET = 'sekret';
const ENV: Env = { PLATFORM_SECRET: SECRET };

const t = tenantIdOf.parse(ulid());
const s = scopeIdOf.parse(ulid());
const conn = connectionIdOf.parse(ulid());
const USE = permissionKey.parse('protocol:record-signature');

function world(overrides: Partial<VerticalScopeHost> = {}) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  const host: VerticalScopeHost = {
    provisionScopeLocal: async () => undefined,
    restoreScopeLocal: async () => ({ tables: 0 }),
    projectRolesLocal: async () => undefined,
    exportScopeLocal: async () => [],
    snapshotScopeLocal: async () => ({ tables: 0 }),
    deleteScopeLocal: async () => undefined,
    migrationBookmarksLocal: async () => [],
    rewindScopeLocal: async () => ({ rewindingTo: 'bm' }),
    introspectScopeTables: async () => [],
    introspectScopeTable: async () => ({}),
    introspectScopeQuery: async () => ({ columns: [], rows: [] }) as never,
    listPlatformRequests: async () => [],
    settlePlatformRequest: async () => undefined,
    connectorInvokeLocal: async (...args) => {
      record('invoke', args);
      return { recorded: 2, complete: true };
    },
    connectorAttachmentUploadLocal: async (...args) => {
      record('upload', args);
      const upload = args[3] as { filename: string; body: Uint8Array };
      return { id: 'att1', filename: upload.filename, size: upload.body.byteLength, createdBy: args[0] };
    },
    connectorGrantLocal: async (...args) => {
      record('grant', args);
    },
    ...overrides,
  };
  const app = new Hono<{ Bindings: Env }>();
  mountPlatformSurface<Env>(app, {
    platformSecret: (env) => env.PLATFORM_SECRET,
    hostFor: () => host,
    roles: [],
    ownerRoleKey: 'admin',
  });
  const client = new VerticalClient({
    fetch: ((input: RequestInfo, init?: RequestInit) => app.request(input, init, ENV)) as typeof fetch,
    platformSecret: SECRET,
  });
  return { client, calls };
}

describe('VerticalClient ↔ mountPlatformSurface — connector write-back round trip (#574)', () => {
  it('connectorInvoke: the result crosses the wire unwrapped, args arrive parsed', async () => {
    const { client, calls } = world();
    const out = await client.connectorInvoke({
      connectionId: conn,
      tenantId: t,
      scopeId: s,
      operation: 'protocol/record-signature',
      input: { requestId: 'r1', kind: 'customer' },
    });
    expect(out).toEqual({ recorded: 2, complete: true });
    expect(calls.invoke).toEqual([
      [conn, t, s, 'protocol/record-signature', { requestId: 'r1', kind: 'customer' }],
    ]);
  });

  it("connectorInvoke: the far scope's permission denial comes back as a 403 ControlPlaneError", async () => {
    const { client } = world({
      connectorInvokeLocal: async () => {
        throw new Error('permission denied: protocol:record-signature for connection');
      },
    });
    const err = await client
      .connectorInvoke({ connectionId: conn, tenantId: t, scopeId: s, operation: 'x/y' })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).status).toBe(403);
    expect((err as ControlPlaneError).message).toMatch(/permission denied/);
  });

  it('connectorUploadAttachment: bytes survive the multipart hop intact', async () => {
    const { client, calls } = world();
    const body = new TextEncoder().encode('the sealed pdf bytes');
    const rec = await client.connectorUploadAttachment({
      connectionId: conn,
      tenantId: t,
      scopeId: s,
      entity: { entityType: 'protocol', entityId: 'p1' },
      filename: 'sealed.pdf',
      contentType: 'application/pdf',
      visibility: 'customer',
      body,
    });
    expect((rec as { id: string }).id).toBe('att1');
    const [connArg, tArg, sArg, upload] = calls.upload![0] as [
      string,
      string,
      string,
      { entity: unknown; filename: string; contentType: string; visibility: string; body: Uint8Array },
    ];
    expect([connArg, tArg, sArg]).toEqual([conn, t, s]);
    expect(upload.entity).toEqual({ entityType: 'protocol', entityId: 'p1' });
    expect(upload.contentType).toBe('application/pdf');
    expect(upload.visibility).toBe('customer');
    expect(new TextDecoder().decode(upload.body)).toBe('the sealed pdf bytes');
  });

  it('connectorGrant: the tuple delivery arrives parsed, expiry included', async () => {
    const { client, calls } = world();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await client.connectorGrant({ connectionId: conn, scopeId: s, permission: USE, expiresAt });
    expect(calls.grant).toEqual([[conn, s, USE, expiresAt]]);
  });

  it('a wrong platform secret refuses the verb before any host method runs', async () => {
    const { calls } = world({
      connectorInvokeLocal: async () => {
        throw new Error('must never run');
      },
    });
    const app = new Hono<{ Bindings: Env }>();
    mountPlatformSurface<Env>(app, {
      platformSecret: (env) => env.PLATFORM_SECRET,
      hostFor: () => {
        throw new Error('host must never be reached');
      },
      roles: [],
      ownerRoleKey: 'admin',
    });
    const wrong = new VerticalClient({
      fetch: ((input: RequestInfo, init?: RequestInit) => app.request(input, init, ENV)) as typeof fetch,
      platformSecret: 'not-the-secret',
    });
    await expect(
      wrong.connectorInvoke({ connectionId: conn, tenantId: t, scopeId: s, operation: 'x/y' }),
    ).rejects.toThrow(ControlPlaneError);
    expect(calls.invoke).toBeUndefined();
  });
});
