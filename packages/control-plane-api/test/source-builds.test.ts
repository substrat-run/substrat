import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { migrationDigestOf, platformActorId, tenantId, type SourceBuildService } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { createControlPlaneApi, DEV_ACTOR_HEADER, mintPushToken, pushActorFor, pushTokenBuilderAuth, sourceBuildService, UNSAFE_devPlatformActorAuth } from '../src/index.js';

describe('platform source releases', () => {
  let root: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const staff = platformActorId.parse(ulid());
  const tenant = tenantId.parse(ulid());
  const secret = 'source-build-test';
  const build = vi.fn<SourceBuildService['build']>();
  const projects = vi.fn<SourceBuildService['projects']>();
  const deploy = vi.fn(async () => {});
  const revision = 'a'.repeat(40);
  let builderHeaders: Record<string, string>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'source-release-'));
    host = new SqliteScopeHost({ dir: root });
    await host.admin.createTenant(staff, { id: tenant, slug: 'acme', name: 'Acme' });
    build.mockReset(); projects.mockReset(); deploy.mockClear();
    build.mockImplementation(async (_tenant, _slug, input) => {
      const form = new FormData();
      form.set('manifest', JSON.stringify({
        version: input.version, entry: 'worker.js', compatibilityDate: '2026-06-01',
        doClasses: [], bindings: [], migrations: [],
        registry: { permissions: [], roles: [], entityGrants: [] },
        digests: { manifest: 'manifest', permission: 'permission', migration: await migrationDigestOf({ doClasses: [], migrations: [] }) },
        build: { id: 'build-1', projectId: 'project-1', revision, toolchain: 'pinned-toolchain' },
      }));
      form.set('worker.js', new Blob(['export default {fetch(){return new Response("built")}}'], { type: 'application/javascript+module' }), 'worker.js');
      return { form, projectId: 'project-1', revision, dataLoss: { status: 'passed', authored: 0 } };
    });
    app = createControlPlaneApi({
      host, authenticate: UNSAFE_devPlatformActorAuth(), authenticateBuilder: pushTokenBuilderAuth(secret),
      sourceBuilds: { build, projects }, deployVertical: deploy,
    });
    const token = await mintPushToken(secret, { actor: await pushActorFor(tenant), tenantId: tenant, tenantSlug: 'acme' });
    builderHeaders = { 'x-service-token': token, 'content-type': 'application/json' };
  });
  afterEach(async () => { await host.close(); rmSync(root, { recursive: true, force: true }); });
  const push = (input: unknown, headers = builderHeaders) => app.request('/verticals/demo/deploy', { method: 'POST', headers, body: JSON.stringify(input) });

  it('advertises the source-only protocol to authenticated clients', async () => {
    const response = await app.request('/verticals?limit=1', { headers: builderHeaders });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-substrat-platform-features')?.split(',')).toContain('source-builds');
  });

  it('builds for the authenticated owner and publishes the resulting release through the existing admission path', async () => {
    const response = await push({ version: '1.0.0', revision });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(build).toHaveBeenCalledWith(tenant, 'acme/demo', expect.objectContaining({ revision }));
    expect(deploy).toHaveBeenCalledOnce();
    const result = await response.json();
    expect(result).toMatchObject({ verticalSlug: 'acme/demo', admission: 'admitted', revision, projectId: 'project-1', dataLoss: { status: 'passed' } });
    const stored = await host.admin.versionManifest(staff, 'acme/demo', result.id);
    expect(JSON.parse(stored!).build).toEqual({ id: 'build-1', projectId: 'project-1', revision, toolchain: 'pinned-toolchain' });
  });

  it('rejects old module uploads and malformed source before invoking a build', async () => {
    const old = await app.request('/verticals/demo/deploy', { method: 'POST', headers: { 'x-service-token': builderHeaders['x-service-token']! }, body: new FormData() });
    expect(old.status).toBe(415);
    expect((await push({ version: '1.0.0', revision: 'main' })).status).toBe(400);
    expect(build).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
  });

  it('refuses a foreign tenant pin before any source or build side effect', async () => {
    expect((await push({ version: '1.0.0', revision, tenant: 'another-team' })).status).toBe(403);
    expect(build).not.toHaveBeenCalled();
    expect(deploy).not.toHaveBeenCalled();
  });

  it('keeps a fully qualified tenant slug intact for the builder service’s staff call', async () => {
    const response = await app.request('/verticals/acme%2Fdemo/deploy', {
      method: 'POST', headers: { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' },
      body: JSON.stringify({ version: '1.0.0', revision, tenant }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(build).toHaveBeenCalledWith(tenant, 'acme/demo', expect.anything());
    expect((await response.json()).verticalSlug).toBe('acme/demo');
  });

  it('sends the whole request to the build service once and refuses a release built from another revision', async () => {
    const sent: Array<{ url: string; tenant: string | null; body: unknown }> = [];
    const service = sourceBuildService({
      async fetch(request) {
        sent.push({ url: request.url, tenant: request.headers.get('x-substrat-tenant'), body: await request.json() });
        const form = new FormData();
        form.set('buildResult', JSON.stringify({ projectId: 'project-1', revision: 'b'.repeat(40), dataLoss: { status: 'skipped', why: 'test' } }));
        return new Response(form);
      },
    }, 'token');
    const input = { version: '1.0.0', revision, allowFork: false, allowUnservedUi: false, allowUnsweptSchedules: false, requireDataLossCheck: false };
    await expect(service.build(tenant, 'acme/demo', input)).rejects.toThrow(/did not build the requested source revision/);
    expect(sent).toEqual([{ url: 'https://builder/internal/build', tenant, body: { slug: 'acme/demo', request: input } }]);
  });

  it('answers 502 with a plain sentence when the build service drops the connection, and logs why', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = sourceBuildService({ fetch: async () => { throw new Error('Network connection lost.'); } }, 'token');
    app = createControlPlaneApi({
      host, authenticate: UNSAFE_devPlatformActorAuth(), authenticateBuilder: pushTokenBuilderAuth(secret),
      sourceBuilds: service, deployVertical: deploy,
    });
    const response = await push({ version: '1.0.0', revision });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ detail: 'the build service connection failed before it answered' });
    expect(log).toHaveBeenCalledWith('source-build.connection-failed', { tenantId: tenant, detail: 'Network connection lost.' });
    log.mockRestore();
  });

  it('gives builders only their own project catalogue', async () => {
    projects.mockResolvedValue(Response.json({ projects: [] }));
    const response = await app.request('/projects?tenant=foreign', { headers: builderHeaders });
    expect(response.status).toBe(200);
    expect(projects).toHaveBeenCalledWith(tenant, expect.any(Request));
  });
});
