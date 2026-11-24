import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, tenantId } from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth } from '../src/index.js';
import { versionBuiltFrom } from '../src/built-version.js';

/**
 * `GET /verticals/:slug/builds/:revision`: the recent version already built from a source
 * revision, which the studio's Run binds instead of building the same commit again. What it
 * answers is bound without a deploy, so the claims are that the match is the platform's own
 * `manifest.build` stamp, and that the tenant pin the studio sends is held to the vertical's owner.
 * (Builder and tenant credentials never reach it: it is in neither allowlist.)
 */
describe('version built from a revision', () => {
  const tA = tenantId.parse(ulid());
  const tB = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const R = 'a'.repeat(40);
  const OLD = 'b'.repeat(40);
  const ORIGIN_ONLY = 'c'.repeat(40);
  const REJECTED = 'd'.repeat(40);

  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const v = { old: ulid(), first: ulid(), second: ulid(), origin: ulid(), rejected: ulid() };

  const manifest = (revision?: string) =>
    JSON.stringify({
      version: '1.0.0',
      entry: 'index.js',
      compatibilityDate: '2026-07-01',
      registry: { permissions: [], roles: [], entityGrants: [] },
      digests: { manifest: 'm', permission: 'p', migration: 'g' },
      ...(revision ? { build: { id: 'bld_1', projectId: 'prj_1', revision, toolchain: 't' } } : {}),
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-built-version-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
    await host.admin.createTenant(staff, { id: tA, slug: 'acme', name: 'Acme' });
    await host.admin.createTenant(staff, { id: tB, slug: 'rival', name: 'Rival' });
    await host.admin.registerVertical(staff, { slug: 'acme/app', name: 'Acme App', source: 'cli', ownerTenant: tA });
    const publish = (id: string, manifestJson: string, origin?: { source: 'git'; gitCommit: string }, verticalSlug = 'acme/app') =>
      host.admin.publishVersion(staff, {
        id, verticalSlug, version: id.toLowerCase(),
        manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g', deploymentRef: `ref-${id}`, manifestJson,
        ...(origin ? { origin } : {}),
      });
    // Published in id order, so `second` is the newest built from R.
    await publish(v.old, manifest(OLD));
    await publish(v.first, manifest(R));
    await publish(v.second, manifest(R));
    // A version whose origin claims a commit its build stamp does not carry: a snapshot push's
    // origin is the pusher's own, so it never matches.
    await publish(v.origin, manifest(), { source: 'git', gitCommit: ORIGIN_ONLY });
    // Only a listed vertical's push lands pending, so only there can one be rejected.
    await host.admin.registerVertical(staff, { slug: 'acme/listed', name: 'Acme Listed', source: 'cli', ownerTenant: tA });
    await host.admin.setVerticalListed(staff, 'acme/listed', true);
    await publish(v.rejected, manifest(REJECTED), undefined, 'acme/listed');
    await host.admin.rejectVersion(staff, v.rejected, 'turned away');
    await host.admin.promoteVersion(staff, 'acme/app', 'prod', v.old);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ask = async (revision: string, headers: Record<string, string>, tenant?: string) => {
    const res = await app.request(`/verticals/acme%2Fapp/builds/${revision}${tenant ? `?tenant=${tenant}` : ''}`, { headers });
    return { status: res.status, body: (await res.json()) as { id?: string } };
  };

  it('answers the newest version built from the revision, pinned to its owner, and refuses another pin', async () => {
    const staffHeaders = { [DEV_ACTOR_HEADER]: staff };
    expect(await ask(R, staffHeaders, tA)).toMatchObject({ status: 200, body: { id: v.second } });
    expect((await ask(R, staffHeaders, tB)).status).toBe(404);
  });

  it.each([
    ['a revision only an origin claims', ORIGIN_ONLY, 404],
    ['something that is not a commit', 'main', 400],
  ])('finds nothing for %s', async (_name, revision, status) => {
    expect((await ask(revision, { [DEV_ACTOR_HEADER]: staff }, tA)).status).toBe(status);
  });

  it('passes over a rejected version', async () => {
    expect(await versionBuiltFrom(host.admin, staff, 'acme/listed', REJECTED)).toBeUndefined();
  });

  it("searches prod's version when it has fallen out of the newest window", async () => {
    expect(await versionBuiltFrom(host.admin, staff, 'acme/app', OLD, 1)).toMatchObject({ id: v.old });
    expect(await versionBuiltFrom(host.admin, staff, 'acme/app', R, 1)).toBeUndefined();
  });
});
