import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, tenantId, verticalChanges, type HostedChanges } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  mintPushToken,
  pushActorFor,
  pushTokenBuilderAuth,
  sourceBuildService,
  tenantCredentialPin,
  UNSAFE_devPlatformActorAuth,
  type ControlPlaneApiOptions,
  type GithubChange,
} from '../src/index.js';

/**
 * `GET /verticals/:slug/changes`: one vertical's open changes, whichever provider holds them.
 * GitHub is a stub of the injected reader; the studio is a fake builder behind the real
 * service transport, so the internal wire is the one the control plane parses.
 */
describe('the open changes of a vertical', () => {
  let root: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const staff = platformActorId.parse(ulid());
  const acme = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const secret = 'changes-test';
  const asStaff = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let asBuilder: Record<string, string>;
  const githubChanges = vi.fn<NonNullable<ControlPlaneApiOptions['githubChanges']>>();
  const builderAsked: { tenant: string | null; url: string }[] = [];

  const pr = (number: number): GithubChange => ({
    number, id: `#${number}`, title: `PR ${number}`, branch: `feat-${number}`, url: `https://github.com/acme-org/garden/pull/${number}`,
    author: 'ada', updatedAt: '2026-11-15T10:00:00Z', head: `sha${number}`, checks: { state: 'failure', failing: ['test'] },
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'vertical-changes-'));
    host = new SqliteScopeHost({ dir: root });
    await host.admin.createTenant(staff, { id: acme, slug: 'acme', name: 'Acme' });
    await host.admin.createTenant(staff, { id: other, slug: 'other', name: 'Other' });
    // `acme/foreign` sits under acme's prefix but another team owns it: the owner check, not the slug, decides.
    for (const [slug, ownerTenant] of [['acme/garden', acme], ['acme/hosted', acme], ['acme/bare', acme], ['other/patch', other], ['acme/foreign', other]] as const) {
      await host.admin.registerVertical(staff, { slug, name: slug, source: 'cli', ownerTenant });
    }
    // An older CI push names the repository; the newest, from a terminal, names none.
    const publish = (slug: string, version: string, origin?: { source: 'git' | 'cli'; gitRepo?: string }) =>
      host.admin.publishVersion(staff, {
        id: ulid(), verticalSlug: slug, version, manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null,
        ...(origin ? { origin } : {}),
      });
    await publish('acme/garden', '1.0.0', { source: 'git', gitRepo: 'acme-org/garden' });
    await publish('acme/garden', '1.0.1', { source: 'cli' });
    await publish('other/patch', '1.0.0', { source: 'git', gitRepo: 'other-org/patch' });
    await publish('acme/foreign', '1.0.0', { source: 'git', gitRepo: 'other-org/foreign' });

    githubChanges.mockReset();
    githubChanges.mockResolvedValue({ changes: [pr(13), pr(12)] });
    builderAsked.length = 0;
    const builder = sourceBuildService({
      async fetch(request) {
        const url = new URL(request.url);
        builderAsked.push({ tenant: request.headers.get('x-substrat-tenant'), url: `${url.pathname}${url.search}` });
        const answer: HostedChanges = url.searchParams.get('slug') === 'acme/hosted'
          ? { repository: { kind: 'artifacts', name: 'hosted', branch: 'main' }, changes: [{ id: '01CHAT', title: 'Add beds', branch: 'builder/01chat', updatedAt: '2026-11-15T09:00:00Z', head: 'abc' }] }
          : { repository: null, changes: [] };
        return Response.json(answer);
      },
    }, 'token');
    app = createControlPlaneApi({
      host, authenticate: UNSAFE_devPlatformActorAuth(), authenticateBuilder: pushTokenBuilderAuth(secret),
      platformBaseDomains: ['global.substrat.run'], sourceBuilds: builder, githubChanges,
    });
    const token = await mintPushToken(secret, { actor: await pushActorFor(acme), tenantId: acme, tenantSlug: 'acme' });
    asBuilder = { 'x-service-token': token };
  });
  afterEach(async () => { await host.close(); rmSync(root, { recursive: true, force: true }); });

  const changes = async (slug: string) => {
    const res = await app.request(`/verticals/${encodeURIComponent(slug)}/changes`, { headers: asBuilder });
    return { status: res.status, body: (await res.json()) as unknown };
  };

  it('reads a GitHub vertical’s pull requests with their previews, and a hosted one’s chat branches', async () => {
    const [version] = await host.admin.listVersions(staff, 'acme/garden');
    // #12 has its sticky preview and a per-build one, and the sticky one is its preview; #13 has
    // only per-build ones, and the newest stands in for it — none of them a fork, so none carries
    // a `forkedAt` to order by.
    const previewUrl = async (tag: string) => {
      const preview = await app.request('/verticals/acme%2Fgarden/previews', {
        method: 'POST', headers: asStaff, body: JSON.stringify({ tag, versionId: version!.id, empty: true }),
      });
      expect(preview.status, await preview.clone().text()).toBe(201);
      return ((await preview.json()) as { url: string }).url;
    };
    const sticky = await previewUrl('pr-12');
    await previewUrl('pr-12-555');
    await previewUrl('pr-13-777');
    const build = await previewUrl('pr-13-778');
    const openConnection = vi.spyOn(host.admin, 'openConnection').mockResolvedValue({ secret: { installationId: '42' } } as never);

    const github = await changes('garden');
    expect(github.status).toBe(200);
    const read = verticalChanges.parse(github.body);
    expect(read).toMatchObject({ provider: 'github', repository: 'acme-org/garden' });
    expect(read.changes.map((c) => [c.id, c.checks.state, c.preview])).toEqual([
      ['#13', 'failure', { tag: 'pr-13-778', url: build }],
      ['#12', 'failure', { tag: 'pr-12', url: sticky }],
    ]);
    expect(openConnection).toHaveBeenCalledWith(acme, 'dashboard', 'github', 'acme-org');
    expect(githubChanges).toHaveBeenCalledWith({ tenantId: acme, owner: 'acme-org', repo: 'garden', installationId: '42' });
    // Checks the installation may not read: the pull requests still list, and the reason travels.
    githubChanges.mockResolvedValueOnce({ changes: [], reason: 'the GitHub App cannot read checks for acme-org/garden' });
    expect(verticalChanges.parse((await changes('garden')).body)).toMatchObject({
      provider: 'github', reason: 'the GitHub App cannot read checks for acme-org/garden',
    });

    const hosted = verticalChanges.parse((await changes('hosted')).body);
    expect(hosted).toEqual({
      provider: 'artifacts', repository: 'hosted',
      changes: [{ id: '01CHAT', title: 'Add beds', branch: 'builder/01chat', url: null, author: null, updatedAt: '2026-11-15T09:00:00Z', head: 'abc', checks: { state: 'none', failing: [] }, preview: null }],
    });
    // The studio is asked under the caller's own tenant, for the registry's full slug.
    expect(builderAsked.at(-1)).toEqual({ tenant: acme, url: '/internal/changes?slug=acme%2Fhosted' });
    // The dashboard's tenant credential reaches it the same way, owner-pinned.
    expect(tenantCredentialPin('GET', '/verticals/acme%2Fgarden/changes')).toBe('owner');
  });

  it('another tenant’s vertical is refused, and neither the studio nor GitHub is asked', async () => {
    vi.spyOn(host.admin, 'openConnection').mockResolvedValue({ secret: { installationId: '42' } } as never);
    // A builder's slug is its own team's, so another team's prefix names nothing it can see.
    expect((await changes('other/patch')).status).toBe(404);
    expect((await changes('foreign')).status).toBe(403);
    expect(builderAsked).toEqual([]);
    expect(githubChanges).not.toHaveBeenCalled();
  });

  it('no repository, no connection to its owner, or none that reads it: no provider and the reason, never a 5xx', async () => {
    const bare = await changes('bare');
    expect(bare.status).toBe(200);
    expect(verticalChanges.parse(bare.body)).toEqual({
      provider: null, repository: null, changes: [], reason: expect.stringContaining("no repository is known for 'acme/bare'"),
    });
    const unconnected = await changes('garden');
    expect(unconnected.status).toBe(200);
    expect(verticalChanges.parse(unconnected.body)).toEqual({
      provider: null, repository: 'acme-org/garden', changes: [], reason: expect.stringContaining("no GitHub connection for 'acme-org'"),
    });
    expect(githubChanges).not.toHaveBeenCalled();
    // Connected, but the installation cannot read the repository: the reader's sentence.
    vi.spyOn(host.admin, 'openConnection').mockResolvedValue({ secret: { installationId: '42' } } as never);
    githubChanges.mockResolvedValueOnce({ unavailable: 'the GitHub connection cannot read acme-org/garden' });
    expect(verticalChanges.parse((await changes('garden')).body)).toEqual({
      provider: null, repository: 'acme-org/garden', changes: [], reason: 'the GitHub connection cannot read acme-org/garden',
    });
  });
});
