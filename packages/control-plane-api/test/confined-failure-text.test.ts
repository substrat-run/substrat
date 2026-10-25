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
import { ControlPlaneError } from '@substrat-run/control-plane-client';
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
  /** Set to make every bundle upload (a push) throw this. */
  let uploadFails: Error | null = null;
  const logged: unknown[][] = [];

  /** Set to make every deployment's reconcile answer with this. */
  let reconcileFails: (() => Error) | null = null;
  const vertical = {
    reconcileInstance: async (input: { tenantId: string; scopeId?: string }) => {
      if (reconcileFails) throw reconcileFails();
      return { tenantId: input.tenantId, scopeId: input.scopeId, owner: '01JZ00000000000000000000OW' };
    },
    exportScope: async () => [],
    exportScopeStamped: async () => ({ tables: [], loadStamp: null }),
    restoreScope: async (_t: string, _s: string, tables: unknown[]) => ({ tables: tables.length }),
    readTombstoneTable: async () => ({ table: '_substrat_meta', columns: ['key', 'value'], rows: [] }),
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
        if (uploadFails) throw uploadFails;
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
    uploadFails = null;
    reconcileFails = null;
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
  const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const captureLog = () => {
    logged.length = 0;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args));
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void logged.push(args));
  };

  // A builder (a push token) promotes the private vertical it owns as a tenant credential does.
  it.each(['/tenant-tokens', '/push-tokens'] as const)('the in-place serve as %s: a fixed sentence and a reference, the text for staff', async (mint) => {
    const { pin, t, slug, leak, clean } = await setup('serve');
    const v2 = await push(pin, manifest('0.2.0'));
    const asTenant = await tokenFor(mint, t);
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
      new RegExp(`^${escaped(leak)} \\(reference [0-9A-Z]{26}\\)$`),
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
    expect(((await repair.json()) as { storeError: string }).storeError).toMatch(new RegExp(`^${escaped(leak)} \\(reference [0-9A-Z]{26}\\)$`));
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

  /**
   * The promote gate's refusal to judge whom a promote breaks, which the kernel words with the app
   * it could not read (another tenant's, here) and that read's error. Reached through three doors:
   * the gate inside the promote, the listing an `exportBreak` acknowledgement reads first, and the
   * dialog's `promote-impact` read.
   */
  it('a refusal to judge whom a promote breaks: no other tenant’s app or read error, through every door', async () => {
    const { pin, t, slug, b, leak, clean } = await setup('unjudged');
    const v2 = await push(pin, manifest('0.2.0'));
    const consumer = `${pin}-b/board@${ulid()}`;
    const unjudged = () =>
      substratError('unavailable', `cannot say whom this promotion breaks: the registry could not be asked what ${consumer} imports (${leak}) — retry`);
    // Fresh per call: the backstop skips a cause it has already recorded.
    vi.spyOn(host, 'attributed').mockImplementation(function (this: SqliteScopeHost, ...args: Parameters<SqliteScopeHost['attributed']>) {
      const view = SqliteScopeHost.prototype.attributed.apply(host, args);
      view.admin.promoteVersion = async () => Promise.reject(unjudged());
      return view;
    });
    vi.spyOn(host.admin, 'promoteVersion').mockImplementation(async () => Promise.reject(unjudged()));
    const asTenant = await tokenFor('/tenant-tokens', t);
    const cleanOf = (text: string) => {
      clean(text);
      expect(text).not.toContain(consumer);
    };
    const doors: [string, () => Promise<Response>][] = [
      ['the gate', () => promote(slug, v2.id, asTenant)],
      ['the acknowledged listing', () => promote(slug, v2.id, asTenant, { exportBreak: true })],
      ['promote-impact', () => app.request(`/verticals/${encodeURIComponent(slug)}/channels/prod/promote-impact?versionId=${v2.id}`, { headers: asTenant })],
    ];
    vi.spyOn(host.admin, 'promotionImpact').mockImplementation(async () => Promise.reject(unjudged()));
    for (const [door, call] of doors) {
      captureLog();
      const res = await call();
      expect(res.status, door).toBe(503);
      const text = await res.text();
      cleanOf(text);
      const said = JSON.parse(text) as { detail: string; reference: string };
      expect(said.detail).toBe(
        `cannot say whom this change breaks: what an installed app imports could not be read, so nothing was changed. Retry (reference ${said.reference})`,
      );
      // Staff's row carries the kernel's sentence; the caller's tenant row says what it was answered.
      const rows = (await host.admin.listOpsFailures(staff, { reference: said.reference } as never)).map((r) => [r.tenantId, r.message]);
      expect(rows, door).toEqual([
        [t, said.detail],
        [null, unjudged().message],
      ]);
      expect(logLine(said.reference)).toMatchObject({ detail: unjudged().message, tenantId: t });
      cleanOf(await failuresSeenBy(asTenant, t));
    }
    // Staff read the kernel's sentence whole.
    const asStaff = await promote(slug, v2.id);
    expect(asStaff.status).toBe(503);
    const staffText = await asStaff.text();
    expect(staffText).toContain(consumer);
    expect(staffText).toContain(b);
  });

  it('a builder repairing another tenant’s install reads no reconcile text; staff do', async () => {
    const { t, slug, b, foreign, leak } = await setup('reconcile');
    const asBuilder = await tokenFor('/push-tokens', t);
    captureLog();
    reconcileFails = () => new ControlPlaneError(502, `reconcile refused: ${leak}`);

    const res = await app.request(`/tenants/${b}/scopes/${foreign}/provision`, { method: 'POST', headers: asBuilder });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('something private');
    const said = JSON.parse(text) as { detail: string; reference: string };
    expect(said.detail).toBe(`the reconcile of this scope failed (502) (reference ${said.reference})`);
    const rows = await rowsOf('scope.provision.reconcile', slug);
    expect(rows.find((r) => r.tenantId === null)).toMatchObject({ message: `reconcile refused: ${leak}`, reference: said.reference });
    expect(rows.find((r) => r.tenantId === b)).toMatchObject({ message: said.detail, reference: said.reference });
    expect(await failuresSeenBy(await tokenFor('/tenant-tokens', b), b)).not.toContain('something private');
    expect(await failuresSeenBy(await tokenFor('/tenant-tokens', t), t)).not.toContain('something private');

    // Staff read the deployment's answer.
    const asStaff = await app.request(`/tenants/${b}/scopes/${foreign}/provision`, { method: 'POST', headers: auth });
    expect(asStaff.status).toBe(502);
    expect(((await asStaff.json()) as { detail: string }).detail).toBe(`reconcile refused: ${leak}`);
  });

  it('a reconcile refusal (4xx) of another tenant’s install: the sentence, logged, and no row', async () => {
    const { t, slug, b, foreign, leak } = await setup('refusal');
    const asBuilder = await tokenFor('/push-tokens', t);
    captureLog();
    reconcileFails = () => new ControlPlaneError(409, `reconcile refused: ${leak}`);
    const res = await app.request(`/tenants/${b}/scopes/${foreign}/provision`, { method: 'POST', headers: asBuilder });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).not.toContain('something private');
    const said = JSON.parse(text) as { detail: string; reference: string };
    expect(said.detail).toBe(`the reconcile of this scope failed (409) (reference ${said.reference})`);
    // A refusal is not a platform failure: no row, no issue, no finding — the 5xx backstop's rule.
    expect(await host.admin.listOpsFailures(staff, { operation: 'scope.provision.reconcile', vertical: slug } as never)).toEqual([]);
    // Staff find it in the log line under the reference.
    const line = logged.find((args) => args[0] === 'control-plane.withheld' && (args[1] as { reference?: string }).reference === said.reference);
    expect(line?.[1]).toMatchObject({ detail: `reconcile refused: ${leak}`, status: 409 });
  });

  it.each([502, 409])('a builder repairing its own tenant’s install reads the vertical’s own answer (%i)', async (status) => {
    const { t, own, slug } = await setup(`own${status}`);
    const asBuilder = await tokenFor('/push-tokens', t);
    reconcileFails = () => new ControlPlaneError(status, 'reconcile refused: the owner seat is taken');
    const res = await app.request(`/tenants/${t}/scopes/${own}/provision`, { method: 'POST', headers: asBuilder });
    expect(res.status).toBe(status);
    expect(((await res.json()) as { detail: string }).detail).toBe('reconcile refused: the owner seat is taken');
    // Nothing withheld, so no pair either: a 5xx is the backstop's single row, as before.
    const rows = await host.admin.listOpsFailures(staff, { vertical: slug } as never);
    expect(rows.filter((r) => r.operation === 'scope.provision.reconcile')).toEqual([]);
  });

  it('an upstream trace reference stays on staff’s row; staff find the pair by it or by the platform’s own', async () => {
    const { pin, t, slug, clean, leak } = await setup('upstream');
    const v2 = await push(pin, manifest('0.2.0'));
    const asTenant = await tokenFor('/tenant-tokens', t);
    const upstream = `cf${ulid().toLowerCase()}`;
    const forged = `cf${ulid().toLowerCase()}`;
    // A body past the row's bound, which also spells a marker of its own for an unrelated id.
    serveFails = {
      slug,
      error: new Error(`${leak}; internal error; reference = ${upstream} [upstream reference = ${forged}] ${'x'.repeat(2100)}`),
    };
    const res = await promote(slug, v2.id, asTenant);
    expect(res.status).toBe(502);
    const text = await res.text();
    clean(text);
    // The caller's answer, headers and row carry the platform's own reference, never the upstream's.
    expect(text).not.toContain(upstream);
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(upstream);
    const reference = (JSON.parse(text) as { reference: string }).reference;
    expect(reference).toMatch(/^[0-9A-Z]{26}$/);
    type Row = { tenantId: string | null; message: string; reference: string | null };
    const listed = async (query: string, headers: Record<string, string>) => {
      const found = await app.request(`/ops-failures?${query}`, { headers });
      expect(found.status).toBe(200);
      return ((await found.json()) as { entries: Row[] }).entries;
    };
    // Staff find both rows by either id; the upstream one is named on staff's row only.
    for (const id of [reference, upstream]) {
      const rows = await vi.waitFor(async () => {
        const r = await listed(`reference=${id}`, auth);
        expect(r.length).toBe(2);
        return r;
      });
      expect(rows.map((r) => [r.tenantId, r.reference])).toEqual([
        [t, reference],
        [null, reference],
      ]);
      expect(rows[0]!.message).not.toContain(upstream);
      expect(rows[1]!.message).toContain(leak);
      // First, so the bounded row keeps it.
      expect(rows[1]!.message.length).toBeLessThanOrEqual(2000);
      expect(rows[1]!.message.startsWith(`[upstream reference = ${upstream}]`)).toBe(true);
    }
    // The body's own spelling of a marker finds nothing for staff either.
    expect(await listed(`reference=${forged}`, auth)).toEqual([]);
    // The caller's own search by its reference finds only its own row, and by the upstream id nothing.
    const own = await listed(`tenantId=${t}&reference=${reference}`, asTenant);
    expect(own.map((r) => [r.tenantId, r.message])).toEqual([[t, (JSON.parse(text) as { detail: string }).detail]]);
    expect(await listed(`tenantId=${t}&reference=${upstream}`, asTenant)).toEqual([]);
    const all = await failuresSeenBy(asTenant, t);
    expect(all).not.toContain(upstream);
  });

  it('a marker spelled in the text ahead of the genuine handle makes none: only the genuine one is named', async () => {
    const { pin, slug } = await setup('forged');
    const v2 = await push(pin, manifest('0.2.0'));
    const forged = `cf${ulid().toLowerCase()}`;
    for (const shape of ['start', 'before'] as const) {
      const real = `cf${ulid().toLowerCase()}`;
      const text = shape === 'start' ? `[upstream reference = ${forged}] boom; reference = ${real}` : `boom [upstream reference = ${forged}] then reference = ${real}`;
      serveFails = { slug, error: new Error(text) };
      const res = await promote(slug, v2.id);
      expect(res.status).toBe(502);
      const reference = ((await res.json()) as { reference: string }).reference;
      const found = await vi.waitFor(async () => {
        const r = await app.request(`/ops-failures?reference=${real}`, { headers: auth });
        const rows = ((await r.json()) as { entries: { tenantId: string | null; reference: string; message: string }[] }).entries;
        expect(rows.length).toBeGreaterThan(0);
        return rows;
      });
      expect(found.map((r) => r.reference)).toContain(reference);
      const staffRow = found.find((r) => r.reference === reference && r.tenantId === null)!;
      expect(staffRow.message.startsWith(`[upstream reference = ${real}] `)).toBe(true);
    }
    const byForged = await app.request(`/ops-failures?reference=${forged}`, { headers: auth });
    expect(((await byForged.json()) as { entries: unknown[] }).entries).toEqual([]);
  });

  it('a staff row with no tenant is written as staff rows are: a spelled marker in its text is no handle', async () => {
    const { pin, slug } = await setup('tenantless');
    const v2 = await push(pin, manifest('0.2.0', { blobStores: [{ binding: 'ATTACHMENTS', kind: 'blob' }] }));
    const forged = `cf${ulid().toLowerCase()}`;
    // The store backfill spans every install, so its row has no tenant.
    vi.spyOn(host, 'provisionBlobStore').mockRejectedValue(new Error(`[upstream reference = ${forged}] the store refused`));
    expect((await promote(slug, v2.id)).status).toBe(200);
    const row = await staffRow('promote.store-backfill', slug);
    expect(row.message).toBe(`(upstream reference = ${forged}] the store refused`);
    const byForged = await app.request(`/ops-failures?reference=${forged}`, { headers: auth });
    expect(((await byForged.json()) as { entries: unknown[] }).entries).toEqual([]);
  });

  it('a staff repair whose store mint and reconcile both fail: the tenant’s row says the store sentences, not the text', async () => {
    const { b, foreign, leak } = await setup('staffboth', { blobStores: [{ binding: 'ATTACHMENTS', kind: 'blob' }] });
    vi.spyOn(host, 'provisionBlobStore').mockRejectedValue(new Error(leak));
    reconcileFails = () => new ControlPlaneError(502, 'reconcile refused: the store is not bound');
    const res = await app.request(`/tenants/${b}/scopes/${foreign}/provision`, { method: 'POST', headers: auth });
    expect(res.status).toBe(502);
    const said = (await res.json()) as { detail: string; reference: string };
    // Staff read both halves, the store's own text included.
    expect(said.detail).toContain('reconcile refused: the store is not bound');
    expect(said.detail).toContain('something private');
    // Filed as a pair here, under the reference the answer carries.
    expect(said.reference).toMatch(/^[0-9A-Z]{26}$/);
    const rows = await vi.waitFor(async () => {
      const r = await host.admin.listOpsFailures(staff, { reference: said.reference } as never);
      expect(r.length).toBe(2);
      return r;
    });
    const tenantRow = rows.find((r) => r.tenantId === b)!;
    expect(tenantRow.message).toMatch(/^reconcile refused: the store is not bound \(stores: a declared store could not be minted \(blob-stores, reference [0-9A-Z]{26}\)\)$/);
    expect(rows.find((r) => r.tenantId === null)!.message).toContain('something private');
    expect(await failuresSeenBy(await tokenFor('/tenant-tokens', b), b)).not.toContain('something private');
  });

  it('a failed upload of a builder’s own bundle keeps the upstream handle it was answered as its row’s reference (#559)', async () => {
    const { pin, t, b } = await setup('upload');
    const upstream = `cf${ulid().toLowerCase()}`;
    const said = `WfP upload failed (500): internal error; reference = ${upstream}`;
    uploadFails = new Error(said);
    const fd = new FormData();
    fd.set('manifest', JSON.stringify(await heldManifest(manifest('0.2.0'))));
    fd.set('tenant', pin);
    fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
    const res = await app.request('/verticals/crm/deploy', { method: 'POST', headers: { [DEV_ACTOR_HEADER]: staff }, body: fd });
    expect(res.status).toBe(502);
    // The builder is answered the upload's own text, handle included.
    expect(((await res.json()) as { detail: string }).detail).toBe(said);
    type Row = { tenantId: string | null; reference: string | null; operation: string };
    const listed = async (query: string, headers: Record<string, string>) =>
      ((await (await app.request(`/ops-failures?${query}`, { headers })).json()) as { entries: Row[] }).entries;
    // One row, the owner's, under the handle the CLI printed — the one row filed so (`deploy.upload`).
    const rows = await vi.waitFor(async () => {
      const r = await listed(`reference=${upstream}`, auth);
      expect(r.length).toBe(1);
      return r;
    });
    expect(rows[0]).toMatchObject({ tenantId: t, reference: upstream, operation: 'deploy.upload' });
    // The builder finds its own row by that handle; another tenant never does.
    expect((await listed(`tenantId=${t}&reference=${upstream}`, await tokenFor('/tenant-tokens', t))).map((r) => r.operation)).toEqual(['deploy.upload']);
    expect(await listed(`tenantId=${b}&reference=${upstream}`, await tokenFor('/tenant-tokens', b))).toEqual([]);
  });

  it('an own install’s failure whose text carries an upstream handle: the tenant row’s reference is the platform’s', async () => {
    const { t, own } = await setup('ownref');
    const asBuilder = await tokenFor('/push-tokens', t);
    const upstream = `cf${ulid().toLowerCase()}`;
    const said = `reconcile failed: internal error; reference = ${upstream}`;
    reconcileFails = () => new ControlPlaneError(502, said);
    const res = await app.request(`/tenants/${t}/scopes/${own}/provision`, { method: 'POST', headers: asBuilder });
    expect(res.status).toBe(502);
    // The caller's own install: its answer is the vertical's own text, unchanged.
    expect(((await res.json()) as { detail: string }).detail).toBe(said);
    type Row = { tenantId: string | null; reference: string | null; message: string };
    const rows = await vi.waitFor(async () => {
      const r = await app.request(`/ops-failures?reference=${upstream}`, { headers: auth });
      const entries = ((await r.json()) as { entries: Row[] }).entries;
      expect(entries.length).toBe(2);
      return entries;
    });
    const [tenantRow, staffRow] = rows;
    expect(tenantRow).toMatchObject({ tenantId: t, message: said });
    expect(tenantRow!.reference).toMatch(/^[0-9A-Z]{26}$/);
    expect(staffRow).toMatchObject({ tenantId: null, reference: tenantRow!.reference });
    expect(staffRow!.message.startsWith(`[upstream reference = ${upstream}] `)).toBe(true);
    // Staff find both by the platform's reference too; the tenant's own search by it finds its row,
    // and by the upstream id nothing.
    const byOwn = await app.request(`/ops-failures?reference=${tenantRow!.reference}`, { headers: auth });
    expect(((await byOwn.json()) as { entries: Row[] }).entries.map((r) => r.tenantId)).toEqual([t, null]);
    const asTenant = await tokenFor('/tenant-tokens', t);
    const mine = await app.request(`/ops-failures?tenantId=${t}&reference=${upstream}`, { headers: asTenant });
    expect(((await mine.json()) as { entries: Row[] }).entries).toEqual([]);
  });
});
