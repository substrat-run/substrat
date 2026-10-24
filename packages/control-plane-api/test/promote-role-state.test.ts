import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, type RoleState } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId, type ScopeDumpTable, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  SERVICE_TOKEN_HEADER,
  tenantTokenAuth,
  deploymentRefFor,
  stableDeploymentRefFor,
  type VerticalClient,
} from '../src/index.js';
import { ROLE_STATE_UNREAD_NOTE } from '../src/api.js';
import { heldManifest, heldVersion } from './held-manifest.js';

/**
 * #2446: a prod promote judges the incoming version's role set against every scope it moves, with
 * the reconcile's own rule (`releaseRoleSetRefusal`), before anything moves. A pushed vertical's
 * reconcile defines that set in each scope, and refuses it where the scope's stored roles and seats
 * forbid it (#2525), which held that scope's whole reconcile while it served the new code. Each fake
 * deployment answers `roleState` from a per-scope table the test sets, and counts the reads.
 */
describe('a promote judges its roles against the scopes it moves (#2446)', () => {
  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  let capped: ReturnType<typeof createControlPlaneApi>;
  let embedded: ReturnType<typeof createControlPlaneApi>;
  const scripts = new Map<string, Map<string, ScopeDumpTable[]>>();
  const ensure = (ref: string) => {
    if (!scripts.has(ref)) scripts.set(ref, new Map());
    return scripts.get(ref)!;
  };
  /** What each scope answers its role-state read with. */
  const answers = new Map<string, RoleState | 'predates' | Error>();
  const reads: string[] = [];
  const deploys: string[] = [];
  const clientFor = (ref: string) =>
    ({
      exportScope: async (sc: string) => ensure(ref).get(sc) ?? [],
      exportScopeStamped: async (sc: string) => ({ tables: ensure(ref).get(sc) ?? [], loadStamp: null }),
      wipeCarriedCopy: async () => 'unfenced',
      loadMarker: async () => 'unfenced',
      keptCopy: async () => null,
      readScopeTable: async (sid: string) => {
        const m = ensure(ref).get(sid)?.find((tb) => tb.name === '_substrat_meta');
        return { table: '_substrat_meta', columns: m?.columns ?? ['key', 'value'], rows: m?.rows ?? [] };
      },
      restoreScope: async (_t: string, sc: string, tables: ScopeDumpTable[]) => {
        ensure(ref).set(sc, tables);
        return { tables: tables.length };
      },
      roleState: async (input: { tenantId: TenantId; scopeId: ScopeId }) => {
        reads.push(input.scopeId);
        const a = answers.get(input.scopeId) ?? { roles: [], seated: [] };
        if (a instanceof Error) throw a;
        return a;
      },
    }) as unknown as VerticalClient;
  const TENANT_SECRET = 'test-tenant-token-secret';
  const options = {
    authenticate: UNSAFE_devPlatformActorAuth(),
    authenticateTenantService: tenantTokenAuth(TENANT_SECRET, platformActorId.parse('01JZ00000000000000000000SV')),
    tenantTokenSecret: TENANT_SECRET,
    deployVertical: async (ref: string) => {
      deploys.push(ref);
      ensure(ref);
    },
    fetchVerticalModules: async () => [
      { name: 'worker.js', content: new Uint8Array([1]), contentType: 'application/javascript+module' },
    ],
    resolveVerticalRef: async (ref: string) => clientFor(ref),
    resolveVerticalVersion: async (slug: string, versionId: string) => clientFor(deploymentRefFor(slug, versionId)),
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-promote-role-state-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({ host, ...options });
    capped = createControlPlaneApi({ host, ...options, roleStateScopeCap: 0 });
    // A control plane that serves nothing in place: an embedded vertical's.
    embedded = createControlPlaneApi({ host, authenticate: options.authenticate, resolveVerticalRef: options.resolveVerticalRef });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const PERSON = [{ key: 'runner', permissions: ['a:use'], source: 'vertical' }];
  const SYSTEM = [{ key: 'runner', permissions: ['a:run'], source: 'vertical', holder: 'system' }];
  const manifest = (version: string, roles: object[]) => ({
    version,
    entry: 'worker.js',
    compatibilityDate: '2025-01-01',
    doClasses: ['ScopeDO'],
    bindings: [{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }],
    digests: { manifest: `m-${version}`, permission: `p-${version}`, migration: 'g1' },
    registry: {
      permissions: [
        { key: 'a:use', description: 'use', declaredBy: ['@test/a'] },
        { key: 'a:run', description: 'run', declaredBy: ['@test/a'], holder: 'system' },
      ],
      roles,
      entityGrants: [],
    },
  });
  const push = async (pin: string, m: object): Promise<{ id: string; verticalSlug: string }> => {
    const fd = new FormData();
    fd.set('manifest', JSON.stringify(await heldManifest(m as Record<string, unknown>)));
    fd.set('tenant', pin);
    fd.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js');
    const res = await app.request('/verticals/crm/deploy', { method: 'POST', headers: { [DEV_ACTOR_HEADER]: staff }, body: fd });
    expect(res.status).toBeLessThan(300);
    return (await res.json()) as { id: string; verticalSlug: string };
  };
  const promote = (slug: string, versionId: string, via = app, extra: object = {}, headers: Record<string, string> = auth) =>
    via.request(`/verticals/${encodeURIComponent(slug)}/channels/prod/promote`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ versionId, acknowledge: { permissionChange: true, ...extra } }),
    });
  const prodOf = async (slug: string) => (await host.admin.listChannels(staff, slug)).find((c) => c.channel === 'prod')?.versionId;
  const servedOf = async (slug: string) => (await host.admin.verticalServing(staff, slug))?.versionId;

  /** A private vertical with one install bound to its first version, which declares a person's role. */
  const setup = async (prefix: string) => {
    const pin = `${prefix}-${ulid().slice(-6).toLowerCase()}`;
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: pin, name: pin });
    const v1 = await push(pin, manifest('0.1.0', PERSON));
    const slug = v1.verticalSlug;
    const sc = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: sc, vertical: slug });
    await host.admin.activateScope(staff, t, sc);
    await host.admin.bindScopeVersion(staff, t, sc, v1.id);
    return { pin, t, slug, sc, v1 };
  };
  const seatedPerson: RoleState = { roles: [{ key: 'runner', permissions: ['a:use'], holder: 'person' }], seated: ['runner'] };

  it('refuses a promote whose adopt would move a seated scope onto a role made holder: system, before the serve or the channel move', async () => {
    const { pin, t, slug, sc } = await setup('adopt');
    // The install is still on its own version: the first prod promote's adopt is what moves it.
    answers.set(sc, seatedPerson);
    const v2 = await push(pin, manifest('0.2.0', SYSTEM));
    deploys.length = 0;
    reads.length = 0;
    const res = await promote(slug, v2.id);
    expect(res.status).toBe(409);
    const said = (await res.json()) as { error: string; roleRefusals: { affected: { scopeId: string; refusal: string }[] } };
    expect(said.error).toMatch(/^promotion refused: this version's roles cannot be defined in 1 of the scopes it would move/);
    expect(said.error).toMatch(/role 'runner' is held by a principal \(stored as a person's role\), so it cannot be declared holder: 'system'/);
    expect(said.error).toMatch(/Nothing was promoted$/);
    expect(said.roleRefusals.affected.map((a) => a.scopeId)).toEqual([sc]);
    expect(reads).toEqual([sc]);
    // Nothing moved: no serve, no channel, no adopt.
    expect(deploys).toEqual([]);
    expect(await prodOf(slug)).toBeUndefined();
    expect(await servedOf(slug)).toBeUndefined();
    expect((await host.admin.getScopeRecord(staff, t, sc))?.servingRef ?? null).toBeNull();

    // Twin: the seat taken back, the same promote serves and adopts.
    answers.set(sc, { ...seatedPerson, seated: [] });
    const ok = await promote(slug, v2.id);
    expect(ok.status).toBe(200);
    expect(await prodOf(slug)).toBe(v2.id);
    expect(await servedOf(slug)).toBe(v2.id);
    expect((await host.admin.getScopeRecord(staff, t, sc))?.servingRef).toBe(stableDeploymentRefFor(slug));
  });

  it('judges an install already on the serving script, and its unseated twin passes', async () => {
    const { pin, slug, sc, v1 } = await setup('served');
    answers.set(sc, seatedPerson);
    // A release with no system-held role asks no scope, seated or not: zero reads.
    reads.length = 0;
    expect((await promote(slug, v1.id)).status).toBe(200);
    expect(reads).toEqual([]);
    const v2 = await push(pin, manifest('0.2.0', SYSTEM));
    expect((await promote(slug, v2.id)).status).toBe(409);
    expect(reads).toEqual([sc]);
    expect(await servedOf(slug)).toBe(v1.id);
    expect(await prodOf(slug)).toBe(v1.id);
    answers.set(sc, { roles: [{ key: 'runner', permissions: ['a:run'], holder: 'system' }], seated: ['runner'] });
    expect((await promote(slug, v2.id)).status).toBe(200);
  });

  it('a deployment that predates the read (404) is moved unjudged, counted in the answer', async () => {
    const { pin, slug, sc, v1 } = await setup('predates');
    expect((await promote(slug, v1.id)).status).toBe(200);
    const v2 = await push(pin, manifest('0.2.0', SYSTEM));
    answers.set(sc, 'predates');
    const res = await promote(slug, v2.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { roleStateUnread?: unknown }).roleStateUnread).toEqual({ scopes: 1, note: ROLE_STATE_UNREAD_NOTE });
    expect(await prodOf(slug)).toBe(v2.id);
  });

  it('any other failed read refuses the promote with nothing moved: a 501 from the deployment, or a throw', async () => {
    const { pin, slug, sc, v1 } = await setup('closed');
    expect((await promote(slug, v1.id)).status).toBe(200);
    const v2 = await push(pin, manifest('0.2.0', SYSTEM));
    for (const failure of [new ControlPlaneError(501, 'this deployment cannot report its role state'), new Error('connection reset')]) {
      answers.set(sc, failure);
      deploys.length = 0;
      const res = await promote(slug, v2.id);
      expect(res.status).toBe(failure instanceof ControlPlaneError ? 501 : 502);
      expect(((await res.json()) as { error: string }).error).toMatch(
        new RegExp(`^the roles of scope ${sc} could not be read \\(.+\\), and this version's roles are judged against them before it moves the scope\\. Nothing was promoted; retry the promote$`),
      );
      expect(deploys).toEqual([]);
      expect(await prodOf(slug)).toBe(v1.id);
    }
  });

  it('above the cap the promote is refused, naming the ways through, rather than judged in part', async () => {
    const { pin, t, slug, v1 } = await setup('cap');
    expect((await promote(slug, v1.id)).status).toBe(200);
    const v2 = await push(pin, manifest('0.2.0', SYSTEM));
    reads.length = 0;
    const res = await promote(slug, v2.id, capped);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /it would move 1, more than the 0 one promote reads\. Nothing was promoted\. Raise the control plane's `roleStateScopeCap`, or, as staff, promote with `acknowledge\.roleStateUnjudged`/,
    );
    expect(reads).toEqual([]);
    expect(await prodOf(slug)).toBe(v1.id);

    // A caller confined to the tenant may not skip the read.
    const minted = await app.request('/tenant-tokens', { method: 'POST', headers: auth, body: JSON.stringify({ tenantId: t }) });
    expect(minted.status).toBe(201);
    const asTenant = { [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token, 'content-type': 'application/json' };
    const confined = await promote(slug, v2.id, capped, { roleStateUnjudged: true }, asTenant);
    expect(confined.status).toBe(403);
    expect(await prodOf(slug)).toBe(v1.id);

    // Staff's override skips the read, and the promote's audit row records it.
    const skipped = await promote(slug, v2.id, capped, { roleStateUnjudged: true });
    expect(skipped.status).toBe(200);
    expect(reads).toEqual([]);
    expect(await prodOf(slug)).toBe(v2.id);
    const rows = await host.admin.auditLog(staff, { action: 'promoteVersion' });
    const row = rows.find((r) => (r.after as { versionId?: string } | null)?.versionId === v2.id);
    expect((row?.after as { acknowledged?: object }).acknowledged).toMatchObject({ roleStateUnjudged: true });
  });

  it('an embedded vertical (no per-version script) is asked nothing: its roles are its host’s, not the registry’s', async () => {
    const slug = `embedded-${ulid().slice(-6).toLowerCase()}`;
    await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli' });
    const publish = async (roles: object[]) => {
      const id = ulid();
      await host.admin.publishVersion(staff, await heldVersion({
        id, verticalSlug: slug, version: `1.0.${id.toLowerCase()}`, manifestDigest: `m-${id}`, permissionDigest: `p-${id}`,
        migrationDigest: 'g', deploymentRef: null,
        manifestJson: JSON.stringify(manifest('x', roles)),
      }));
      await host.admin.admitVersion(staff, id);
      return id;
    };
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug, name: slug });
    const sc = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: sc, vertical: slug });
    await host.admin.activateScope(staff, t, sc);
    answers.set(sc, seatedPerson);
    expect((await promote(slug, await publish(PERSON), embedded)).status).toBe(200);
    reads.length = 0;
    const flipped = await publish(SYSTEM);
    const second = await promote(slug, flipped, embedded);
    expect(second.status, await second.clone().text()).toBe(200);
    expect(reads).toEqual([]);
    expect(await prodOf(slug)).toBe(flipped);
  });
});
