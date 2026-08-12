import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { PLATFORM_SECRET_HEADER } from '@substrat-run/kernel';
import { mountPlatformSurface, type VerticalScopeHost } from '../src/index.js';

const SECRET = 'sekret';
// Valid 26-char ULIDs (Crockford base32 — no I/L/O/U).
const SCOPE = '01JZ0000000000000000SCP001';
const TENANT = '01JZ0000000000000000TEN001';
const OWNER = '01JZ0000000000000000PRN001';

type Env = { PLATFORM_SECRET: string };

/** A host whose methods all record their call and return a benign value — except the ones a
 *  test overrides to throw, exercising the error envelope. */
function fakeHost(overrides: Partial<VerticalScopeHost> = {}): VerticalScopeHost & { calls: string[] } {
  const calls: string[] = [];
  const note = <T>(name: string, v: T) => {
    calls.push(name);
    return v;
  };
  const base: VerticalScopeHost = {
    provisionScopeLocal: async () => note('provisionScopeLocal', undefined),
    restoreScopeLocal: async () => note('restoreScopeLocal', { tables: 3 }),
    projectRolesLocal: async () => note('projectRolesLocal', undefined),
    exportScopeLocal: async () => note('exportScopeLocal', []),
    snapshotScopeLocal: async () => note('snapshotScopeLocal', { tables: 3 }),
    deleteScopeLocal: async () => note('deleteScopeLocal', undefined),
    migrationBookmarksLocal: async () => note('migrationBookmarksLocal', []),
    rewindScopeLocal: async () => note('rewindScopeLocal', { rewindingTo: 'bm' }),
    introspectScopeTables: async () => note('introspectScopeTables', []),
    introspectScopeTable: async () => note('introspectScopeTable', { rows: [] }),
    introspectScopeQuery: async () => note('introspectScopeQuery', { columns: [], rows: [] }) as never,
    listPlatformRequests: async () => note('listPlatformRequests', []),
    listPlatformRequestHistory: async (_t: unknown, _s: unknown, filter?: unknown) =>
      note('listPlatformRequestHistory', [filter]) as never,
    settlePlatformRequest: async () => note('settlePlatformRequest', undefined),
    connectorInvokeLocal: async () => note('connectorInvokeLocal', { ok: true }),
    connectorAttachmentUploadLocal: async () => note('connectorAttachmentUploadLocal', { id: 'att1' }),
    connectorGrantLocal: async () => note('connectorGrantLocal', undefined),
  };
  return Object.assign(base, overrides, { calls }) as VerticalScopeHost & { calls: string[] };
}

function appWith(
  host: VerticalScopeHost,
  deps: Partial<Parameters<typeof mountPlatformSurface<Env>>[1]> = {},
) {
  const app = new Hono<{ Bindings: Env }>();
  mountPlatformSurface<Env>(app, {
    platformSecret: (env) => env.PLATFORM_SECRET,
    hostFor: () => host,
    roles: [],
    ownerRoleKey: 'admin',
    ...deps,
  });
  return app;
}

const ENV: Env = { PLATFORM_SECRET: SECRET };
const authed = (extra: Record<string, string> = {}) => ({ [PLATFORM_SECRET_HEADER]: SECRET, ...extra });

describe('mountPlatformSurface — the platform-secret gate', () => {
  it('403s an /internal call with no platform secret', async () => {
    const res = await appWith(fakeHost()).request('/internal/export?scopeId=' + SCOPE, {}, ENV);
    expect(res.status).toBe(403);
  });

  it('403s an /internal call with the wrong secret', async () => {
    const res = await appWith(fakeHost()).request(
      '/internal/export?scopeId=' + SCOPE,
      { headers: { [PLATFORM_SECRET_HEADER]: 'nope' } },
      ENV,
    );
    expect(res.status).toBe(403);
  });

  it('admits a correctly-signed call', async () => {
    const res = await appWith(fakeHost()).request(
      '/internal/export?scopeId=' + SCOPE,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(200);
  });
});

describe('mountPlatformSurface — the error envelope (#510 regression)', () => {
  it('renders a thrown route as { error: <real message> }, never bare "Internal Server Error"', async () => {
    const host = fakeHost({
      restoreScopeLocal: async () => {
        throw new Error('FOREIGN KEY constraint failed');
      },
    });
    const res = await appWith(host).request(
      '/internal/restore',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ scopeId: SCOPE, tables: [] }),
      },
      ENV,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('FOREIGN KEY constraint failed');
    expect(await new Response(JSON.stringify(body)).text()).not.toBe('Internal Server Error');
  });

  it('maps an "invalid transition" throw to 409', async () => {
    const host = fakeHost({
      exportScopeLocal: async () => {
        throw new Error('invalid transition from draft to closed');
      },
    });
    const res = await appWith(host).request('/internal/export?scopeId=' + SCOPE, { headers: authed() }, ENV);
    expect(res.status).toBe(409);
  });

  it('answers a DO SQLite redacted fault ("internal error; reference = …") with 502, message intact (#559)', async () => {
    const host = fakeHost({
      restoreScopeLocal: async () => {
        throw new Error('internal error; reference = 242sg7l0st8ldln5uqu8ei58');
      },
    });
    const res = await appWith(host).request(
      '/internal/restore',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ scopeId: SCOPE, tables: [] }),
      },
      ENV,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('internal error; reference = 242sg7l0st8ldln5uqu8ei58');
  });

  it('answers a workerd-flagged transient (retryable) with 502 regardless of message', async () => {
    const host = fakeHost({
      exportScopeLocal: async () => {
        throw Object.assign(new Error('Durable Object reset because its code was updated.'), {
          retryable: true,
        });
      },
    });
    const res = await appWith(host).request('/internal/export?scopeId=' + SCOPE, { headers: authed() }, ENV);
    expect(res.status).toBe(502);
  });

  it('leaves an APP error that merely mentions "internal error" mid-sentence as 400', async () => {
    const host = fakeHost({
      exportScopeLocal: async () => {
        throw new Error('column check failed: expected no internal error marker');
      },
    });
    const res = await appWith(host).request('/internal/export?scopeId=' + SCOPE, { headers: authed() }, ENV);
    expect(res.status).toBe(400);
  });

  it('maps a "permission denied" throw to 403', async () => {
    const host = fakeHost({
      exportScopeLocal: async () => {
        throw new Error('permission denied for scope');
      },
    });
    const res = await appWith(host).request(
      '/internal/export?scopeId=' + SCOPE,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(403);
  });

  it('honours a vertical-supplied mapError before the default', async () => {
    const host = fakeHost({
      exportScopeLocal: async () => {
        throw new Error('teapot');
      },
    });
    const res = await appWith(host, {
      mapError: (e) => (e instanceof Error && e.message === 'teapot' ? { status: 418, message: 'short and stout' } : undefined),
    }).request('/internal/export?scopeId=' + SCOPE, { headers: authed() }, ENV);
    expect(res.status).toBe(418);
    expect(((await res.json()) as { error: string }).error).toBe('short and stout');
  });
});

describe('mountPlatformSurface — the full route set is mounted', () => {
  const cases: [string, RequestInit][] = [
    ['/internal/export?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/bookmarks?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/tables?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/tables/some_table?scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/platform-requests?tenantId=' + TENANT + '&scopeId=' + SCOPE, { headers: authed() }],
    ['/internal/platform-requests/history?tenantId=' + TENANT + '&scopeId=' + SCOPE, { headers: authed() }],
  ];
  it.each(cases)('GET %s is served (not 404)', async (path, init) => {
    const res = await appWith(fakeHost()).request(path, init, ENV);
    expect(res.status).not.toBe(404);
    expect(res.status).toBeLessThan(500);
  });

  // #618: the journal read is the platform's door to a settled intent's full `last_error`,
  // which lives in THIS deployment's DO. The query string is the filter — parsed here, not
  // trusted onward — so a console can ask for one provider's traffic.
  it('passes the history filter through to the host', async () => {
    const host = fakeHost();
    const res = await appWith(host).request(
      `/internal/platform-requests/history?tenantId=${TENANT}&scopeId=${SCOPE}&kind=connector:scrive&status=failed&limit=5`,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ kind: 'connector:scrive', status: 'failed', limit: 5 }]);
  });

  it('refuses a malformed history filter rather than widening it', async () => {
    const res = await appWith(fakeHost()).request(
      `/internal/platform-requests/history?tenantId=${TENANT}&scopeId=${SCOPE}&status=nonsense`,
      { headers: authed() },
      ENV,
    );
    expect(res.status).toBe(400);
  });

  it('restore re-projects roles when a tenantId is present', async () => {
    const host = fakeHost();
    await appWith(host).request(
      '/internal/restore',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, tables: [] }),
      },
      ENV,
    );
    expect(host.calls).toContain('restoreScopeLocal');
    expect(host.calls).toContain('projectRolesLocal');
  });

  it('restore skips the role re-projection when no tenantId is given', async () => {
    const host = fakeHost();
    await appWith(host).request(
      '/internal/restore',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ scopeId: SCOPE, tables: [] }),
      },
      ENV,
    );
    expect(host.calls).toContain('restoreScopeLocal');
    expect(host.calls).not.toContain('projectRolesLocal');
  });
});

describe('mountPlatformSurface — flavored routes and their hooks', () => {
  it('provision runs the host then the onProvision hook, 201', async () => {
    const host = fakeHost();
    let hooked: string | null = null;
    const res = await appWith(host, {
      onProvision: async (_env, b) => {
        hooked = b.owner;
      },
    }).request(
      '/internal/provision',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, owner: OWNER }),
      },
      ENV,
    );
    expect(res.status).toBe(201);
    expect(host.calls).toContain('provisionScopeLocal');
    expect(hooked).toBe(OWNER);
  });

  it('provision and reconcile hand the delivered connection grants to the host (#592)', async () => {
    const seen: unknown[] = [];
    const host = fakeHost({
      provisionScopeLocal: async (input) => {
        seen.push(input.connectionGrants);
      },
    });
    const grants = [{ connectionId: '01JZ0000000000000000CON001', permission: 'protocol:record-signature' }];
    const provision = await appWith(host).request(
      '/internal/provision',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, owner: OWNER, connectionGrants: grants }),
      },
      ENV,
    );
    expect(provision.status).toBe(201);
    const reconcile = await appWith(host, { resolveOwner: async () => OWNER as never }).request(
      '/internal/reconcile',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, connectionGrants: grants }),
      },
      ENV,
    );
    expect(reconcile.status).toBe(200);
    expect(seen).toEqual([grants, grants]);
  });

  it('reconcile 501s when no resolveOwner is supplied', async () => {
    const res = await appWith(fakeHost()).request(
      '/internal/reconcile',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE }),
      },
      ENV,
    );
    expect(res.status).toBe(501);
  });

  it('reconcile 409s when the owner-of-record is missing', async () => {
    const res = await appWith(fakeHost(), { resolveOwner: async () => null }).request(
      '/internal/reconcile',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE }),
      },
      ENV,
    );
    expect(res.status).toBe(409);
  });

  it('reconcile re-provisions with the resolved owner', async () => {
    const host = fakeHost();
    const res = await appWith(host, { resolveOwner: async () => OWNER as never }).request(
      '/internal/reconcile',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(host.calls).toContain('provisionScopeLocal');
  });

  it('delete-scope runs the host then the onDeleteScope hook', async () => {
    const host = fakeHost();
    let forgotten: string | null = null;
    const res = await appWith(host, {
      onDeleteScope: async (_env, s) => {
        forgotten = s;
      },
    }).request(
      '/internal/delete-scope',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ scopeId: SCOPE }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(host.calls).toContain('deleteScopeLocal');
    expect(forgotten).toBe(SCOPE);
  });

  it('configure 501s when no onConfigure is supplied', async () => {
    const res = await appWith(fakeHost()).request(
      '/internal/configure',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, entries: [{ key: 'a', value: 'b' }] }),
      },
      ENV,
    );
    expect(res.status).toBe(501);
  });

  it('configure runs the onConfigure hook when supplied', async () => {
    let got: number | null = null;
    const res = await appWith(fakeHost(), {
      onConfigure: async (_env, b) => {
        got = b.entries.length;
      },
    }).request(
      '/internal/configure',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tenantId: TENANT, scopeId: SCOPE, entries: [{ key: 'a', value: 'b' }] }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(got).toBe(1);
  });
});

describe('mountPlatformSurface — the connector write-back verbs (#574)', () => {
  const CONN = '01JZ0000000000000000CNN001';

  it('connector-invoke: parses, delegates, and envelopes the result', async () => {
    let got: unknown[] = [];
    const host = fakeHost({
      connectorInvokeLocal: async (...args: unknown[]) => {
        got = args;
        return { recorded: 2 };
      },
    });
    const res = await appWith(host).request(
      '/internal/connector-invoke',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          connectionId: CONN,
          tenantId: TENANT,
          scopeId: SCOPE,
          operation: 'protocol/record-signature',
          input: { requestId: 'r1' },
        }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { recorded: 2 } });
    expect(got).toEqual([CONN, TENANT, SCOPE, 'protocol/record-signature', { requestId: 'r1' }]);
  });

  it('connector-invoke: an undefined result still answers valid JSON ({ result: null })', async () => {
    const host = fakeHost({ connectorInvokeLocal: async () => undefined });
    const res = await appWith(host).request(
      '/internal/connector-invoke',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ connectionId: CONN, tenantId: TENANT, scopeId: SCOPE, operation: 'x/y' }),
      },
      ENV,
    );
    expect(await res.json()).toEqual({ result: null });
  });

  it("connector-invoke: the scope DO's permission denial surfaces as 403, not 400", async () => {
    const host = fakeHost({
      connectorInvokeLocal: async () => {
        throw new Error('permission denied: protocol:record-signature');
      },
    });
    const res = await appWith(host).request(
      '/internal/connector-invoke',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ connectionId: CONN, tenantId: TENANT, scopeId: SCOPE, operation: 'x/y' }),
      },
      ENV,
    );
    expect(res.status).toBe(403);
  });

  it('connector-attachment: multipart meta + bytes reach the host intact', async () => {
    let seen: { upload?: { filename: string; contentType: string; body: Uint8Array } } = {};
    const host = fakeHost({
      connectorAttachmentUploadLocal: async (_c, _t, _s, upload) => {
        seen = { upload };
        return { id: 'att1', filename: upload.filename };
      },
    });
    const form = new FormData();
    form.append(
      'meta',
      JSON.stringify({
        connectionId: CONN,
        tenantId: TENANT,
        scopeId: SCOPE,
        entity: { entityType: 'item', entityId: 'i1' },
        filename: 'sealed.pdf',
        contentType: 'application/pdf',
        visibility: 'customer',
      }),
    );
    form.append('body', new Blob([new TextEncoder().encode('pdf bytes')]), 'sealed.pdf');
    const res = await appWith(host).request(
      '/internal/connector-attachment',
      { method: 'POST', headers: authed(), body: form },
      ENV,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { id: string }).id).toBe('att1');
    expect(seen.upload!.filename).toBe('sealed.pdf');
    expect(seen.upload!.contentType).toBe('application/pdf');
    expect(new TextDecoder().decode(seen.upload!.body)).toBe('pdf bytes');
  });

  it('connector-attachment: a body-less form is a 400 naming the field', async () => {
    const form = new FormData();
    form.append('meta', JSON.stringify({}));
    const res = await appWith(fakeHost()).request(
      '/internal/connector-attachment',
      { method: 'POST', headers: authed(), body: form },
      ENV,
    );
    expect(res.status).toBe(400);
  });

  it('connector-grant: parses and delivers the tuple write', async () => {
    let got: unknown[] = [];
    const host = fakeHost({
      connectorGrantLocal: async (...args: unknown[]) => {
        got = args;
      },
    });
    const res = await appWith(host).request(
      '/internal/connector-grant',
      {
        method: 'POST',
        headers: authed({ 'content-type': 'application/json' }),
        body: JSON.stringify({ connectionId: CONN, scopeId: SCOPE, permission: 'protocol:record-signature' }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ granted: 'protocol:record-signature', scopeId: SCOPE });
    expect(got).toEqual([CONN, SCOPE, 'protocol:record-signature', undefined]);
  });

  it('connector verbs sit behind the platform-secret gate like the rest of the surface', async () => {
    const res = await appWith(fakeHost()).request(
      '/internal/connector-invoke',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: CONN, tenantId: TENANT, scopeId: SCOPE, operation: 'x/y' }),
      },
      ENV,
    );
    expect(res.status).toBe(403);
  });
});
