import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, substratError, tenantId, type TenantId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  SERVICE_TOKEN_HEADER,
  firstBuilderAuth,
  pushTokenBuilderAuth,
  tenantTokenAuth,
  stableDeploymentRefFor,
  type VerticalClient,
} from '../src/index.js';
import { heldManifest } from './held-manifest.js';

/**
 * #2540: a failure whose text came from an upstream or a store, met while the request reached
 * installs that are not the caller's, is answered to a confined caller as a fixed sentence and a
 * reference, never as that text; staff keep the text. The text goes to an ops-failure row with no
 * tenant on it, which a confined read of the failure list never returns, and to the log line under
 * the same reference. Every case runs two tenants: the caller's, and a foreign one whose store or
 * deployment "fails" with text naming its scope and something private.
 */
describe('a confined caller reads no upstream failure text (#2540)', () => {
  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  const TENANT_SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  /** Set to make the serving upload (the in-place serve) of `slug` throw `error`. */
  let serveFails: { slug: string; error: Error } | null = null;
  const logged: unknown[][] = [];

  const vertical = {
    reconcileInstance: async (input: { tenantId: string; scopeId?: string }) => ({
      tenantId: input.tenantId,
      scopeId: input.scopeId,
      owner: '01JZ00000000000000000000OW',
    }),
    exportScope: async () => [],
    exportScopeStamped: async () => ({ tables: [], loadStamp: null }),
    restoreScope: async (_t: string, _s: string, tables: unknown[]) => ({ tables: tables.length }),
    readScopeTable: async () => ({ table: '_substrat_meta', columns: ['key', 'value'], rows: [] }),
    wipeCarriedCopy: async () => 'unfenced',
    loadMarker: async () => 'unfenced',
    keptCopy: async () => null,
    roleState: async () => ({ roles: [], seated: [] }),
  } as unknown as VerticalClient;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-confined-text-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
      pushTokenSecret: PUSH_SECRET,
      authenticateTenantService: tenantTokenAuth(TENANT_SECRET, platformActorId.parse('01JZ00000000000000000000SV')),
      tenantTokenSecret: TENANT_SECRET,
      deployVertical: async (ref: string) => {
        if (serveFails && ref === stableDeploymentRefFor(serveFails.slug)) throw serveFails.error;
      },
      fetchVerticalModules: async () => [
        { name: 'worker.js', content: new Uint8Array([1]), contentType: 'application/javascript+module' },
      ],
      resolveVertical: async () => vertical,
      resolveVerticalRef: async () => vertical,
      resolveVerticalVersion: async () => vertical,
      patchScriptBindings: async () => undefined,
    });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    serveFails = null;
    vi.restoreAllMocks();
  });

  const manifest = (version: string, over: Record<string, unknown> = {}) => ({
    version,
    entry: 'worker.js',
    compatibilityDate: '2025-01-01',
    doClasses: ['ScopeDO'],
    bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
    digests: { manifest: `m-${version}`, permission: 'p1', migration: 'g1' },
    registry: { permissions: [], roles: [], entityGrants: [] },
    ...over,
  });
  const push = async (pin: string, m: Record<string, unknown>): Promise<{ id: string; verticalSlug: string }> => {
    const fd = new FormData();
    fd.set('manifest', JSON.stringify(await heldManifest(m)));
    fd.set('tenant', pin);
    fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
    const res = await app.request('/verticals/crm/deploy', { method: 'POST', headers: { [DEV_ACTOR_HEADER]: staff }, body: fd });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    return (await res.json()) as { id: string; verticalSlug: string };
  };
  const promote = (slug: string, versionId: string, headers: Record<string, string> = auth, acknowledge: object = {}) =>
    app.request(`/verticals/${encodeURIComponent(slug)}/channels/prod/promote`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ versionId, acknowledge }),
    });
  const tokenFor = async (path: '/tenant-tokens' | '/push-tokens', t: TenantId) => {
    const res = await app.request(path, { method: 'POST', headers: auth, body: JSON.stringify({ tenantId: t }) });
    expect(res.status).toBe(201);
    return { [SERVICE_TOKEN_HEADER]: ((await res.json()) as { token: string }).token, 'content-type': 'application/json' };
  };

  /**
   * The owner's private vertical, with an install of the owner's and one of a foreign tenant's,
   * both live. `leak` is what a failing foreign store or deployment says.
   */
  const setup = async (prefix: string, over: Record<string, unknown> = {}) => {
    const pin = `${prefix}-${ulid().slice(-6).toLowerCase()}`;
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: pin, name: pin });
    const v1 = await push(pin, manifest('0.1.0', over));
    const slug = v1.verticalSlug;
    expect((await promote(slug, v1.id)).status).toBe(200);
    const own = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: own, vertical: slug });
    await host.admin.activateScope(staff, t, own);
    const b = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: b, slug: `${pin}-b`, name: 'b' });
    const foreign = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: b, scopeId: foreign, vertical: slug });
    await host.admin.activateScope(staff, b, foreign);
    await host.admin.setScopeServingRef(staff, b, foreign, stableDeploymentRefFor(slug));
    const leak = `store ${foreign} of tenant ${b} refused: something private`;
    const clean = (text: string) => {
      expect(text).not.toContain(foreign);
      expect(text).not.toContain(b);
      expect(text).not.toContain('something private');
    };
    return { pin, t, slug, own, b, foreign, leak, clean };
  };

  /** What a confined caller reads back of its failures, and staff's raw row for `operation`. */
  const failuresSeenBy = async (headers: Record<string, string>, t: TenantId) => {
    const res = await app.request(`/ops-failures?tenantId=${t}&limit=200`, { headers });
    expect(res.status).toBe(200);
    return res.text();
  };
  /** The rows staff read for `operation`, once one has landed (rows are written beside the answer). */
  const rowsOf = (operation: string, vertical: string) =>
    vi.waitFor(async () => {
      const res = await app.request(`/ops-failures?operation=${encodeURIComponent(operation)}&vertical=${encodeURIComponent(vertical)}`, { headers: auth });
      expect(res.status).toBe(200);
      const rows = ((await res.json()) as { entries: Record<string, unknown>[] }).entries;
      expect(rows.some((r) => r.tenantId === null)).toBe(true);
      return rows;
    });
  /** Staff's own row for `operation`: the one with no tenant, which carries the text. */
  const staffRow = async (operation: string, vertical: string) => (await rowsOf(operation, vertical)).find((r) => r.tenantId === null)!;

  /** The `control-plane.unhandled` log line carrying `reference`. */
  const logLine = (reference: string) =>
    logged.find((args) => args[0] === 'control-plane.unhandled' && (args[1] as { reference?: string })?.reference === reference)?.[1] as
      | Record<string, unknown>
      | undefined;
  const captureLog = () => {
    logged.length = 0;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args));
  };

  it('the in-place serve: a fixed sentence and a reference for a confined caller, the text for staff', async () => {
    const { pin, t, slug, leak, clean } = await setup('serve');
    const v2 = await push(pin, manifest('0.2.0'));
    const asTenant = await tokenFor('/tenant-tokens', t);
    captureLog();
    serveFails = { slug, error: new Error(leak) };

    const res = await promote(slug, v2.id, asTenant);
    expect(res.status).toBe(502);
    const text = await res.text();
    clean(text);
    const said = JSON.parse(text) as { detail: string; reference: string };
    expect(said.detail).toBe(
      `promoted, but the in-place serve failed — scopes still run the previous code; promote again to retry (reference ${said.reference})`,
    );
    // The headers carry nothing of it either.
    clean(JSON.stringify([...res.headers.entries()]));

    // The row is staff's, and says it whole; none the confined caller can read back says it; the
    // log line under the same reference does.
    const rows = await rowsOf('promote.serve', slug);
    expect(rows.find((r) => r.tenantId === null)).toMatchObject({ message: leak, reference: said.reference, version: v2.id });
    // The tenant's own row says what it was answered, under the same reference.
    expect(rows.find((r) => r.tenantId === t)).toMatchObject({ message: said.detail, reference: said.reference });
    clean(await failuresSeenBy(asTenant, t));
    expect(logLine(said.reference)).toMatchObject({ operation: 'promote.serve', vertical: slug, detail: leak });

    // Staff keep the text.
    const asStaff = await promote(slug, v2.id);
    expect(asStaff.status).toBe(502);
    expect(((await asStaff.json()) as { detail: string }).detail).toBe(leak);
  });

  it('the store backfill: a confined caller reads that it failed and the reference, staff read why', async () => {
    const { pin, t, slug, leak, clean } = await setup('backfill');
    const v2 = await push(pin, manifest('0.2.0', { blobStores: [{ binding: 'ATTACHMENTS', kind: 'blob' }] }));
    const asTenant = await tokenFor('/tenant-tokens', t);
    captureLog();
    vi.spyOn(host, 'provisionBlobStore').mockRejectedValue(new Error(leak));

    const res = await promote(slug, v2.id, asTenant);
    expect(res.status).toBe(200);
    const text = await res.text();
    clean(text);
    const backfill = (JSON.parse(text) as { storeBackfill: { minted: unknown[]; error: string } }).storeBackfill;
    const reference = /\(reference ([0-9A-Z]{26})\)$/.exec(backfill.error)?.[1];
    expect(backfill.error).toBe(`the stores this version declares could not be minted for every install (reference ${reference})`);
    expect(await staffRow('promote.store-backfill', slug)).toMatchObject({ tenantId: null, message: leak, reference });
    clean(await failuresSeenBy(asTenant, t));
    expect(logLine(reference!)).toMatchObject({ operation: 'promote.store-backfill', detail: leak });

    const asStaff = await promote(slug, v2.id);
    expect(((await asStaff.json()) as { storeBackfill: { error: string } }).storeBackfill.error).toMatch(
      new RegExp(`^${leak.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(reference [0-9A-Z]{26}\\)$`),
    );
  });

  it('the export-break listing: a confined caller reads that it could not be read, staff read why', async () => {
    const { pin, t, slug, leak, clean } = await setup('breaks');
    const v2 = await push(pin, manifest('0.2.0'));
    const asTenant = await tokenFor('/tenant-tokens', t);
    // The gate refuses for a break, and the listing across every install cannot be read. A tenant
    // credential may promote through an attributed view of the host, so its admin refuses too.
    const refusal = substratError('precondition_failed', 'promotion drops or re-versions 1 exported event type(s) that 1 installed app(s) import');
    vi.spyOn(host, 'attributed').mockImplementation(function (this: SqliteScopeHost, ...args: Parameters<SqliteScopeHost['attributed']>) {
      const view = SqliteScopeHost.prototype.attributed.apply(host, args);
      view.admin.promoteVersion = async () => Promise.reject(refusal);
      return view;
    });
    vi.spyOn(host.admin, 'promoteVersion').mockRejectedValue(refusal);
    vi.spyOn(host.admin, 'promotionImpact').mockRejectedValue(new Error(leak));
    captureLog();

    const res = await promote(slug, v2.id, asTenant);
    expect(res.status).toBe(409);
    const text = await res.text();
    clean(text);
    const said = JSON.parse(text) as { exportBreaksUnavailable: string };
    const reference = /\(reference ([0-9A-Z]{26})\)$/.exec(said.exportBreaksUnavailable)?.[1];
    expect(said.exportBreaksUnavailable).toBe(`which apps it breaks could not be read: the platform recorded why (reference ${reference})`);
    expect(await staffRow('promote.export-breaks', slug)).toMatchObject({ tenantId: null, message: leak, reference });
    expect(logLine(reference!)).toMatchObject({ detail: leak });
    clean(await failuresSeenBy(asTenant, t));

    const asStaff = await promote(slug, v2.id);
    expect(((await asStaff.json()) as { exportBreaksUnavailable: string }).exportBreaksUnavailable).toContain(leak);
  });

  it('a builder repairing another tenant’s install of its vertical reads no store text; staff do', async () => {
    const { t, slug, b, foreign, leak, clean } = await setup('repair', { blobStores: [{ binding: 'ATTACHMENTS', kind: 'blob' }] });
    const asBuilder = await tokenFor('/push-tokens', t);
    captureLog();
    vi.spyOn(host, 'provisionBlobStore').mockRejectedValue(new Error(leak));

    const res = await app.request(`/tenants/${b}/scopes/${foreign}/provision`, { method: 'POST', headers: asBuilder });
    expect(res.status).toBe(200);
    const said = (await res.json()) as { storeError: string };
    // The path named the install, so it is no secret here; what the store said is.
    expect(said.storeError).toMatch(/^a declared store could not be minted \(blob-stores, reference [0-9A-Z]{26}\)$/);
    expect(said.storeError).not.toContain('something private');
    const reference = /reference ([0-9A-Z]{26})/.exec(said.storeError)![1]!;
    const rows = await rowsOf('scope.provision.stores', slug);
    expect(rows.find((r) => r.tenantId === null)).toMatchObject({ message: leak, stage: 'blob-stores', reference });
    // The install's tenant reads that a store could not be minted, and the reference, nothing more.
    expect(rows.find((r) => r.tenantId === b)).toMatchObject({ message: said.storeError, reference });
    const asForeign = await tokenFor('/tenant-tokens', b);
    expect(await failuresSeenBy(asForeign, b)).not.toContain('something private');
    clean(await failuresSeenBy(await tokenFor('/tenant-tokens', t), t));
  });

  /**
   * A staff request still files its failure under the tenant it acted on, and that tenant reads the
   * row back. So the tenant's row says what the request was answered and the reference, and staff
   * read the text on the row with no tenant under that reference.
   */
  it('a staff-initiated request: the tenant reads only the answered message and the reference; staff find the text by it', async () => {
    const { pin, t, slug, b, foreign, leak, clean } = await setup('staffside', { blobStores: [{ binding: 'ATTACHMENTS', kind: 'blob' }] });
    captureLog();

    // A store mint fails during staff's repair of the foreign tenant's install.
    vi.spyOn(host, 'provisionBlobStore').mockRejectedValue(new Error(leak));
    const repair = await app.request(`/tenants/${b}/scopes/${foreign}/provision`, { method: 'POST', headers: auth });
    expect(repair.status).toBe(200);
    expect(((await repair.json()) as { storeError: string }).storeError).toBe(leak);
    const minted = await rowsOf('scope.provision.stores', slug);
    const own = minted.find((r) => r.tenantId === b)!;
    expect(own.message).toMatch(/^a declared store could not be minted \(blob-stores, reference [0-9A-Z]{26}\)$/);
    expect(minted.find((r) => r.tenantId === null)).toMatchObject({ message: leak, reference: own.reference });
    // Its own row names its own scope, which is no secret to it; what the store said is.
    expect(await failuresSeenBy(await tokenFor('/tenant-tokens', b), b)).not.toContain('something private');
    vi.restoreAllMocks();
    captureLog();

    // An unhandled throw on staff's promote of the owner's vertical: the owner's row.
    const v2 = await push(pin, manifest('0.2.0'));
    vi.spyOn(host.admin, 'listChannels').mockImplementation(async () => Promise.reject(new Error(leak)));
    const res = await promote(slug, v2.id);
    expect(res.status).toBe(500);
    const promoted = await rowsOf('POST /verticals/:slug/channels/:channel/promote', slug);
    const tenantRow = promoted.find((r) => r.tenantId === t)!;
    expect(tenantRow.message).toBe('internal error');
    expect(promoted.find((r) => r.tenantId === null)).toMatchObject({ message: leak, reference: tenantRow.reference });
    expect(logLine(tenantRow.reference as string)).toMatchObject({ detail: leak });
    clean(await failuresSeenBy(await tokenFor('/tenant-tokens', t), t));
  });

  it('an unhandled throw: a confined caller’s failure row says what it was answered, staff’s the throw', async () => {
    const { pin, t, slug, leak, clean } = await setup('unhandled');
    const asTenant = await tokenFor('/tenant-tokens', t);
    const v2 = await push(pin, manifest('0.2.0'));
    captureLog();
    // A fresh throw per call: the backstop skips a cause it has already recorded.
    vi.spyOn(host.admin, 'listChannels').mockImplementation(async () => Promise.reject(new Error(leak)));

    // The promote's last read throws something nobody reviewed: the generic 500.
    const res = await promote(slug, v2.id, asTenant);
    expect(res.status).toBe(500);
    clean(await res.text());
    const row = await vi.waitFor(async () => {
      const text = await failuresSeenBy(asTenant, t);
      clean(text);
      const found = (JSON.parse(text) as { entries: { message: string; reference: string | null; operation: string }[] }).entries.find(
        (e) => e.operation.endsWith('/promote'),
      );
      expect(found).toBeDefined();
      return found!;
    });
    expect(row.message).toBe('internal error');
    // The log line under the row's reference carries the throw, and so does staff's row under it.
    expect(logLine(row.reference!)).toMatchObject({ detail: leak });
    const rows = await rowsOf('POST /verticals/:slug/channels/:channel/promote', slug);
    expect(rows.find((r) => r.tenantId === null)).toMatchObject({ message: leak, reference: row.reference });
  });
});
