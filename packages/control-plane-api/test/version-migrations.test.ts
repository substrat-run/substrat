import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, tenantId, type MigrationDiff } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  firstBuilderAuth,
  mintPushToken,
  mintTenantToken,
  pushActorFor,
  pushTokenBuilderAuth,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';
import { heldVersion } from './held-manifest.js';

/**
 * `GET /verticals/:slug/versions/:id/migrations` (#1677): the SQL migrations one version
 * adds on top of another, for the promote dialog and `substrat promote`.
 *
 * Migration SQL describes a schema, so the claim that matters is WHO can read it: the
 * vertical's owner, and nobody else. Each refusal is paired with its positive twin on the
 * same route, so deleting the route cannot pass the negative. And a refusal is checked for
 * what it does NOT carry: a 404 whose body still held the SQL would pass on status alone.
 */
describe('version migrations route (#1677)', () => {
  const SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  const tA = tenantId.parse(ulid());
  const tB = tenantId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const staffHeaders = { [DEV_ACTOR_HEADER]: staff };

  const INIT = { moduleId: 'acme-app', version: '0001-init', sql: 'CREATE TABLE secret_ledger (id TEXT PRIMARY KEY);' };
  const ADD = { moduleId: 'acme-app', version: '0002-note', sql: 'ALTER TABLE secret_ledger ADD COLUMN note TEXT;' };
  const RIVAL = { moduleId: 'rival-app', version: '0001-init', sql: 'CREATE TABLE rival_only (id TEXT);' };

  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const v = { base: ulid(), next: ulid(), edited: ulid(), preField: ulid(), bare: ulid(), rival: ulid(), declared: ulid() };
  const as: Record<'tenantA' | 'tenantB' | 'builderA' | 'builderB', Record<string, string>> = {} as never;

  const manifest = (migrations?: unknown[]) =>
    JSON.stringify({
      version: '1.0.0',
      entry: 'index.js',
      compatibilityDate: '2026-07-01',
      registry: { permissions: [], roles: [], entityGrants: [] },
      digests: { manifest: 'm', permission: 'p', migration: 'g' },
      ...(migrations ? { migrations } : {}),
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-version-migrations-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(SECRET, serviceActor),
      authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
      tenantTokenSecret: SECRET,
      pushTokenSecret: PUSH_SECRET,
    });
    await host.admin.createTenant(staff, { id: tA, slug: 'acme', name: 'Acme' });
    await host.admin.createTenant(staff, { id: tB, slug: 'rival', name: 'Rival' });
    await host.admin.registerVertical(staff, { slug: 'acme/app', name: 'Acme App', source: 'cli', ownerTenant: tA });
    await host.admin.registerVertical(staff, { slug: 'rival/app', name: 'Rival App', source: 'cli', ownerTenant: tB });
    const publish = async (id: string, verticalSlug: string, manifestJson?: string) => {
      const input = {
        id, verticalSlug, version: id.toLowerCase(),
        manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g', deploymentRef: `ref-${id}`,
        ...(manifestJson ? { manifestJson } : {}),
      };
      // #2339: a version carrying migrations sends the digest derived from them; preField and
      // bare carry none, and keep doing so.
      await host.admin.publishVersion(staff, manifestJson?.includes('"migrations"') ? await heldVersion(input) : input);
    };
    await publish(v.base, 'acme/app', manifest([INIT]));
    await publish(v.next, 'acme/app', manifest([INIT, ADD]));
    await publish(v.edited, 'acme/app', manifest([{ ...INIT, sql: 'CREATE TABLE secret_ledger (id TEXT PRIMARY KEY, x TEXT);' }]));
    await publish(v.preField, 'acme/app', manifest());
    await publish(v.bare, 'acme/app');
    await publish(v.rival, 'rival/app', manifest([RIVAL]));
    // #2322: the base's SQL, plus a declared loss. (#2339: its digest is derived from both, so it
    // can no longer be sent under the base's.)
    await publish(v.declared, 'acme/app', manifest([INIT, { ...ADD, discards: { 'secret_ledger.note': 'superseded <by> "memo"' } }]));

    const tenant = async (t: string) => ({ [SERVICE_TOKEN_HEADER]: await mintTenantToken(SECRET, { tenantId: t }) });
    const builder = async (t: string, slug: string) => ({
      [SERVICE_TOKEN_HEADER]: await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(t), tenantId: t, tenantSlug: slug }),
    });
    as.tenantA = await tenant(tA);
    as.tenantB = await tenant(tB);
    as.builderA = await builder(tA, 'acme');
    as.builderB = await builder(tB, 'rival');
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const read = async (slug: string, id: string, headers: Record<string, string>, base?: string) => {
    const res = await app.request(
      `/verticals/${encodeURIComponent(slug)}/versions/${id}/migrations${base ? `?base=${base}` : ''}`,
      { headers },
    );
    return { status: res.status, text: await res.text() };
  };
  const diffOf = (text: string) => (JSON.parse(text) as { migrations: MigrationDiff | null }).migrations;

  // -- who can read it ----------------------------------------------------------

  it('the owner’s tenant token reads the migrations a version adds; another tenant’s token is refused', async () => {
    const own = await read('acme/app', v.next, as.tenantA, v.base);
    expect(own.status).toBe(200);
    expect(diffOf(own.text)).toEqual({
      baseline: 'version',
      added: [ADD],
      changed: [],
      total: 1,
      truncated: false,
    });

    const foreign = await read('acme/app', v.next, as.tenantB, v.base);
    expect(foreign.status).toBe(404);
    expect(foreign.text).not.toContain('secret_ledger');
  });

  it('the owner’s builder reads it by the bare slug; another tenant’s builder cannot name it', async () => {
    const own = await read('app', v.next, as.builderA, v.base);
    expect(own.status).toBe(200);
    expect(diffOf(own.text)?.added).toEqual([ADD]);

    // Naming the full id: a builder's slug is always prefixed with ITS tenant, so this is
    // `rival/acme/app`, which is not a vertical at all.
    const byFullId = await read('acme/app', v.next, as.builderB, v.base);
    expect(byFullId.status).not.toBe(200);
    expect(byFullId.text).not.toContain('secret_ledger');
  });

  it('a version id is read only under ITS vertical — neither the path nor `base` crosses to another', async () => {
    // Rival's own vertical works, positive twin first.
    const own = await read('app', v.rival, as.builderB);
    expect(own.status).toBe(200);
    expect(diffOf(own.text)?.added).toEqual([RIVAL]);

    // Acme's version id under rival's own (owned) slug: refused, SQL not leaked.
    const pathed = await read('app', v.next, as.builderB);
    expect(pathed.status).toBe(404);
    expect(pathed.text).not.toContain('secret_ledger');

    // Acme's version as the BASE of rival's own version: refused rather than diffed against.
    const based = await read('app', v.rival, as.builderB, v.base);
    expect(based.status).toBe(404);
    expect(based.text).not.toContain('secret_ledger');
  });

  it('staff read any vertical', async () => {
    const res = await read('acme/app', v.next, staffHeaders, v.base);
    expect(res.status).toBe(200);
    expect(diffOf(res.text)?.added).toEqual([ADD]);
  });

  // -- what it answers -----------------------------------------------------------

  it('lists every migration without a base — a first promote has nothing to subtract', async () => {
    const res = await read('acme/app', v.next, as.tenantA);
    expect(diffOf(res.text)).toMatchObject({ baseline: 'none', added: [INIT, ADD], changed: [] });
  });

  it('lists an edited shipped migration as CHANGED, apart from the added ones', async () => {
    const res = await read('acme/app', v.edited, as.tenantA, v.base);
    expect(diffOf(res.text)).toMatchObject({ baseline: 'version', added: [], changed: [{ moduleId: 'acme-app', version: '0001-init' }] });
  });

  it('answers null — never "no migrations" — for a version whose manifest carries none', async () => {
    for (const id of [v.preField, v.bare]) {
      const res = await read('acme/app', id, as.tenantA, v.base);
      expect(res.status).toBe(200);
      expect(diffOf(res.text)).toBeNull();
    }
  });

  it('shows the declarations the control plane stored, whatever digest the pusher sent (#2322)', async () => {
    // The answer is read from the stored migrations, so the discard is there. (#2339: the
    // pushed digest can no longer disagree with them; the publish refuses one that does.)
    const added = diffOf((await read('acme/app', v.declared, as.tenantA, v.base)).text);
    expect(added?.added).toEqual([{ ...ADD, discards: { 'secret_ledger.note': 'superseded <by> "memo"' } }]);
    // Against a base with the same SQL and no declaration, it is a declarations-only edit.
    const redeclared = diffOf((await read('acme/app', v.declared, as.tenantA, v.next)).text);
    expect(redeclared).toMatchObject({ added: [], changed: [{ ...ADD, edited: 'declarations' }] });
  });

  it('says the baseline is unavailable when the serving version predates the field', async () => {
    const res = await read('acme/app', v.next, as.tenantA, v.preField);
    expect(diffOf(res.text)).toMatchObject({ baseline: 'unavailable', added: [INIT, ADD] });
  });

  // -- the binding a promote acknowledges (#2333) -------------------------------

  describe('the review binding', () => {
    type Binding = { base: string | null; digest: string };
    const bindingOf = (text: string) => (JSON.parse(text) as { review?: Binding }).review;
    /** An embedded vertical (no deployment), so a prod promote here is the gate alone. */
    const SLUG = 'acme/embedded';
    const e = { a: ulid(), b: ulid(), c: ulid() };
    const promote = (versionId: string, acknowledge: object, headers: Record<string, string>) =>
      app.request(`/verticals/${encodeURIComponent(SLUG)}/channels/prod/promote`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ versionId, acknowledge }),
      });
    const prodOf = async () => (await host.admin.listChannels(staff, SLUG)).find((ch) => ch.channel === 'prod')?.versionId;

    beforeAll(async () => {
      await host.admin.registerVertical(staff, { slug: SLUG, name: 'Embedded', source: 'cli', ownerTenant: tA });
      const put = async (id: string, perm: string, mig: string, migrations: unknown[]) => {
        await host.admin.publishVersion(staff, await heldVersion({
          id, verticalSlug: SLUG, version: id.toLowerCase(), manifestDigest: 'm', permissionDigest: perm, migrationDigest: mig,
          deploymentRef: null, manifestJson: manifest(migrations),
        }));
        await host.admin.admitVersion(staff, id);
      };
      await put(e.a, 'pA', 'gA', [INIT]);
      await put(e.b, 'pB', 'gA', [INIT]);
      await put(e.c, 'pA', 'gC', [INIT, { ...ADD, discards: { 'secret_ledger.note': 'superseded' } }]);
      await host.admin.promoteVersion(staff, SLUG, 'prod', e.a);
    });

    it('comes in the same answer as the diff, and is what the host recomputes from its stored rows', async () => {
      const res = await read(SLUG, e.c, as.tenantA, e.a);
      expect(diffOf(res.text)?.added).toEqual([{ ...ADD, discards: { 'secret_ledger.note': 'superseded' } }]);
      const shown = bindingOf(res.text)!;
      expect(shown).toEqual({ base: e.a, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      // Without a base: a first promote's binding names none.
      expect(bindingOf((await read(SLUG, e.c, as.tenantA)).text)?.base).toBeNull();
      // Read twice, the same rows give the same binding.
      expect(bindingOf((await read(SLUG, e.c, as.tenantA, e.a)).text)).toEqual(shown);
    });

    it('a refused read hands out no binding', async () => {
      const foreign = await read(SLUG, e.c, as.tenantB, e.a);
      expect(foreign.status).toBe(404);
      expect(bindingOf(foreign.text)).toBeUndefined();
      expect(foreign.text).not.toMatch(/[0-9a-f]{64}/);
    });

    it('another tenant cannot promote with a binding it was handed; the owner can', async () => {
      const shown = bindingOf((await read(SLUG, e.c, as.tenantA, e.a)).text)!;
      const foreign = await promote(e.c, { migrationChange: true, review: shown }, as.tenantB);
      expect(foreign.status).toBe(403);
      expect(await prodOf()).toBe(e.a);
      // An unbound acknowledgement is refused with its reason; the bound one promotes.
      const unbound = await promote(e.c, { migrationChange: true }, as.tenantA);
      expect(unbound.status).toBe(412);
      expect(await unbound.json()).toEqual(expect.objectContaining({ reason: 'promote_review_unbound', detail: expect.stringContaining('--review') }));
      const own = await promote(e.c, { migrationChange: true, review: shown }, as.tenantA);
      expect(own.status).toBe(200);
      expect(await prodOf()).toBe(e.c);
      // Back to a for the next case (no migration moves back past a, so the permission flag alone).
      await host.admin.promoteVersion(staff, SLUG, 'prod', e.a, { migrationChange: true, review: bindingOf((await read(SLUG, e.a, as.tenantA, e.c)).text)! });
    });

    it('a promote between the read and the acknowledgement refuses it as stale, and a read again passes', async () => {
      const shown = bindingOf((await read(SLUG, e.c, as.tenantA, e.a)).text)!;
      // Someone promotes b meanwhile: prod's permission surface moves under the review.
      await host.admin.promoteVersion(staff, SLUG, 'prod', e.b, { permissionChange: true, review: bindingOf((await read(SLUG, e.b, as.tenantA, e.a)).text)! });
      const stale = await promote(e.c, { permissionChange: true, migrationChange: true, review: shown }, as.tenantA);
      expect(stale.status).toBe(412);
      expect(await stale.json()).toEqual(expect.objectContaining({ reason: 'promote_review_stale' }));
      expect(await prodOf()).toBe(e.b);
      const again = bindingOf((await read(SLUG, e.c, as.tenantA, e.b)).text)!;
      expect(again.base).toBe(e.b);
      const ok = await promote(e.c, { permissionChange: true, migrationChange: true, review: again }, as.tenantA);
      expect(ok.status).toBe(200);
      expect(await prodOf()).toBe(e.c);
    });
  });
});
