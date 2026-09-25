/**
 * How large a deploy manifest the control plane can actually store (#1677), on workerd.
 *
 * A version's manifest is one row in the control-plane Durable Object, and a DO's SQLite
 * refuses a string or row over 2 MB. Node's SQLite allows about a gigabyte, so the SQLite
 * adapter can never show this (the #1655 class). `substrat push` leaves the SQL migrations off
 * a manifest that would pass `DEPLOY_MANIFEST_BYTES_SAFE`; these pin that the bound stores,
 * and that what the first cap (2 MiB of SQL) let through would not have.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DECLARED_MIGRATIONS_SQL_BYTES_MAX,
  DEPLOY_MANIFEST_BYTES_SAFE,
  deployManifest,
  platformActorId,
  sqlBytes,
} from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import type { ScopeDumpTable } from '@substrat-run/contracts';
import { ControlPlaneDO } from '../src/control-plane-do.js';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

describe('the stored manifest size bound (#1677)', () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    checker: UNSAFE_allowAllChecker,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  const staff = platformActorId.parse(ulid());
  const vertical = `manifest-size-${ulid().toLowerCase()}`;
  afterAll(() => host.close());

  const manifestWithSql = (sql: string) =>
    JSON.stringify({
      version: '1.0.0',
      entry: 'index.js',
      compatibilityDate: '2026-07-01',
      registry: { permissions: [], roles: [], entityGrants: [] },
      digests: { manifest: 'm', permission: 'p', migration: 'g' },
      migrations: [{ moduleId: 'helpdesk', version: '0001', sql }],
    });
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  const publish = async (manifestJson: string) => {
    const id = ulid();
    await host.admin.publishVersion(staff, {
      id, verticalSlug: vertical, version: `1.0.${id.slice(-6).toLowerCase()}`, manifestDigest: 'm',
      permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null, manifestJson,
    });
    return id;
  };

  beforeAll(async () => {
    await host.admin.registerVertical(staff, { slug: vertical, name: 'Manifest size', source: 'builtin' });
  });

  it('stores a manifest exactly at the bound; its SQL goes to its own row, the manifest without it (#1764)', async () => {
    const empty = bytes(manifestWithSql(''));
    const sql = 'x'.repeat(DEPLOY_MANIFEST_BYTES_SAFE - empty);
    const json = manifestWithSql(sql);
    expect(bytes(json)).toBe(DEPLOY_MANIFEST_BYTES_SAFE);
    // Over the SQL cap, so this is the push leaving it off: the version stores, with no SQL.
    expect(sqlBytes([{ sql }])).toBeGreaterThan(DECLARED_MIGRATIONS_SQL_BYTES_MAX);
    const id = await publish(json);
    const { migrations: _dropped, ...rest } = JSON.parse(json) as Record<string, unknown>;
    expect(JSON.parse((await host.admin.versionManifest(staff, vertical, id))!)).toEqual(rest);
    expect(await host.admin.versionMigrations(staff, vertical, id)).toBeNull();
  });

  it('stores a migration exactly at the SQL cap as its own row, and reads it back whole (#1764)', async () => {
    // Quoted identifiers and newlines, which JSON escapes to two bytes each: the row holds
    // the SQL raw now, so the cap is what bounds it.
    const statement = 'CREATE TABLE "t" ("id" TEXT);\n';
    const body = statement.repeat(Math.floor(DECLARED_MIGRATIONS_SQL_BYTES_MAX / statement.length));
    const sql = body + 'x'.repeat(DECLARED_MIGRATIONS_SQL_BYTES_MAX - bytes(body));
    expect(sqlBytes([{ sql }])).toBe(DECLARED_MIGRATIONS_SQL_BYTES_MAX);
    const id = await publish(manifestWithSql(sql));
    expect(await host.admin.versionMigrations(staff, vertical, id)).toEqual([
      { moduleId: 'helpdesk', version: '0001', sql },
    ]);
    const stored = (await host.admin.versionManifest(staff, vertical, id))!;
    expect(JSON.parse(stored)).not.toHaveProperty('migrations');
    expect(bytes(stored)).toBeLessThan(1024);
  });

  it('what the first caps admitted, and the DO refused as one row, now publishes as SQL not available', async () => {
    const statement = 'CREATE TABLE "t" ("id" TEXT);\n';
    const sql = statement.repeat(Math.floor((2 * 1024 * 1024) / statement.length));
    const json = manifestWithSql(sql);
    expect(bytes(json)).toBeGreaterThan(2 * 1024 * 1024);
    // Before #1764 this whole manifest was one row, and `publishVersion` failed on SQLITE_TOOBIG
    // after the script had been uploaded. The SQL is over the push's cap, so it is dropped.
    const id = await publish(json);
    expect(await host.admin.versionMigrations(staff, vertical, id)).toBeNull();
    expect(JSON.parse((await host.admin.versionManifest(staff, vertical, id))!)).not.toHaveProperty('migrations');
  });

  it('a migration row over the DO limit is refused, which is why the cap bounds every row', async () => {
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane'));
    await runInDurableObject(stub, (_instance, state) => {
      const insert = (versionId: string, sql: string) =>
        state.storage.sql.exec(
          'INSERT INTO vertical_version_migrations (version_id, ordinal, module_id, version, sql) VALUES (?, 0, ?, ?, ?)',
          versionId, 'helpdesk', '0001', sql,
        );
      expect(() => insert(ulid(), 'x'.repeat(DECLARED_MIGRATIONS_SQL_BYTES_MAX))).not.toThrow();
      expect(() => insert(ulid(), 'x'.repeat(2.2 * 1024 * 1024))).toThrow(/too big|TOOBIG/);
    });
  });

  it('`[]` reads as no migrations, an absent field as not available, and never the other way round', async () => {
    const none = await publish(JSON.stringify({ ...JSON.parse(manifestWithSql('')), migrations: [] }));
    const { migrations: _absent, ...older } = JSON.parse(manifestWithSql('')) as Record<string, unknown>;
    const absent = await publish(JSON.stringify(older));
    expect(await host.admin.versionMigrations(staff, vertical, none)).toEqual([]);
    expect(await host.admin.versionMigrations(staff, vertical, absent)).toBeNull();
    // An older manifest is stored exactly as it came: there was nothing to take out.
    expect(await host.admin.versionManifest(staff, vertical, absent)).toBe(JSON.stringify(older));
  });

  it('refuses a version of another vertical, like `versionManifest`', async () => {
    const id = await publish(manifestWithSql('SELECT 1;'));
    const other = `manifest-other-${ulid().toLowerCase()}`;
    await host.admin.registerVertical(staff, { slug: other, name: 'Other', source: 'builtin' });
    await expect(host.admin.versionMigrations(staff, other, id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(host.admin.versionMigrations(staff, vertical, ulid())).rejects.toMatchObject({ code: 'not_found' });
  });

  it('and the push boundary no longer admits that much SQL at all', () => {
    const sql = 'x'.repeat(DECLARED_MIGRATIONS_SQL_BYTES_MAX + 1);
    expect(deployManifest.safeParse(JSON.parse(manifestWithSql(sql))).success).toBe(false);
  });
});

/**
 * The version LIST does not carry manifests (#1677). A manifest holds the version's whole SQL
 * migration set, so listing `SELECT *` moved every version's SQL across the DO RPC for a page
 * that shows none of it. The list lifts `outbound` and `calls`, the two manifest fields a
 * version record carries, and nothing else.
 */
describe('the version list reads no manifest (#1677)', () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    checker: UNSAFE_allowAllChecker,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  const staff = platformActorId.parse(ulid());
  const vertical = `version-list-${ulid().toLowerCase()}`;
  const stub = () =>
    env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as {
      listVersions(slug: string): Promise<Record<string, unknown>[]>;
    };
  afterAll(() => host.close());

  const big = 'x'.repeat(1024 * 1024);
  const ids = { big: ulid(), legacy: ulid(), junk: ulid() };

  beforeAll(async () => {
    await host.admin.registerVertical(staff, { slug: vertical, name: 'Version list', source: 'builtin' });
    const publish = (id: string, version: string, manifestJson?: string) =>
      host.admin.publishVersion(staff, {
        id, verticalSlug: vertical, version, manifestDigest: 'm', permissionDigest: 'p',
        migrationDigest: 'g', deploymentRef: null, ...(manifestJson ? { manifestJson } : {}),
      });
    await publish(
      ids.big,
      '1.0.0',
      JSON.stringify({
        version: '1.0.0',
        outbound: ['api.example.com', 7],
        calls: ['acme/crm'],
        migrations: [{ moduleId: 'helpdesk', version: '0001', sql: big }],
      }),
    );
    await publish(ids.legacy, '0.9.0'); // no manifest retained
    await publish(ids.junk, '0.8.0', 'not json'); // a stored manifest that never parsed
  });

  it('hands back a page a few hundred bytes a row, though one version carries a megabyte of SQL', async () => {
    const rows = await stub().listVersions(vertical);
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows).length).toBeLessThan(4096);
    for (const row of rows) expect(row).not.toHaveProperty('manifest_json');
  });

  it('and the records still carry outbound and calls, on the manifest reader’s own terms', async () => {
    const byId = new Map((await host.admin.listVersions(staff, vertical)).map((v) => [v.id, v]));
    // A non-string entry is dropped, exactly as `outboundOfManifestJson` drops it.
    expect(byId.get(ids.big)).toMatchObject({ outbound: ['api.example.com'], calls: ['acme/crm'] });
    // No manifest, or one that is not JSON: null, never a failed page.
    expect(byId.get(ids.legacy)).toMatchObject({ outbound: null, calls: null });
    expect(byId.get(ids.junk)).toMatchObject({ outbound: null, calls: null });
    // The single-version read still agrees with the list.
    expect(await host.admin.getVersion(staff, ids.big)).toMatchObject({ outbound: ['api.example.com'], calls: ['acme/crm'] });
  });
});

/**
 * The backfill that moves SQL out of versions stored before #1764, on workerd.
 *
 * The directory DO is the whole control plane: if it cannot construct, nothing answers. So the
 * constructor only probes and arms an alarm, and each alarm moves a bounded batch. These start
 * from new code over OLD storage, which is what a deploy is: a directory whose versions carry
 * megabytes of SQL in their manifests, then a second `ControlPlaneDO` constructed over it.
 */
describe('the #1764 backfill: bounded, resumable, and right before, during and after', () => {
  type Directory = ControlPlaneDO & {
    readVersionMigrations(id: string): { verticalSlug: string; migrations: unknown[] | null } | undefined;
    exportDump(): ScopeDumpTable[];
    importDump(tables: ScopeDumpTable[]): Promise<void>;
  };
  const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`version-backfill-${ulid()}`));
  const inDirectory = <R>(fn: (d: Directory, state: DurableObjectState) => R | Promise<R>) =>
    runInDurableObject(stub, (instance, state) => fn(instance as unknown as Directory, state));
  const sqlOf = (n: number) => `-- ${n}\n` + 'CREATE TABLE "t" ("id" TEXT);\n'.repeat(1000); // ~30 KB, escape-heavy
  const migrationsOf = (i: number) =>
    [0, 1, 2].map((m) => ({ moduleId: 'helpdesk', version: `000${m}`, sql: sqlOf(i * 10 + m) }));
  const CARRIED = 60;
  // 60 versions with ~90 KB of SQL each, plus the four shapes history also holds.
  const ids = Array.from({ length: CARRIED + 4 }, () => ulid()).sort();
  const expected = (i: number) =>
    i < CARRIED ? migrationsOf(i) : i === CARRIED ? [] : null; // [], then older, bare, junk
  const manifestOf = (i: number): string | null => {
    const base = { version: `1.0.${i}`, entry: 'index.js', outbound: ['api.example.com'] };
    if (i < CARRIED) return JSON.stringify({ ...base, migrations: migrationsOf(i) });
    if (i === CARRIED) return JSON.stringify({ ...base, migrations: [] });
    if (i === CARRIED + 1) return JSON.stringify(base); // pushed before #1677
    if (i === CARRIED + 2) return null; // pushed before #286
    return 'not json';
  };
  const unsplit = (state: DurableObjectState) =>
    (state.storage.sql.exec('SELECT COUNT(*) AS n FROM vertical_versions WHERE migrations_split IS NULL').one() as { n: number }).n;
  const reads = (d: Directory) => ids.map((id) => d.readVersionMigrations(id)?.migrations);
  const want = ids.map((_, i) => expected(i));
  let before: ScopeDumpTable[] = [];

  beforeAll(async () => {
    await inDirectory((instance, state) => {
      ids.forEach((id, i) =>
        state.storage.sql.exec(
          `INSERT INTO vertical_versions (id, vertical_slug, version, manifest_digest, permission_digest,
             migration_digest, admission, manifest_json, created_at)
           VALUES (?, 'acme', ?, 'm', 'p', 'g', 'admitted', ?, '2026-09-01T00:00:00.000Z')`,
          id, `1.0.${i}`, manifestOf(i),
        ),
      );
      before = instance.exportDump();
    });
  });

  it('constructs over them without moving a single version, and arms the alarm', async () => {
    await inDirectory(async (_instance, state) => {
      await state.storage.deleteAlarm();
      expect(unsplit(state)).toBe(ids.length);
      const deployed = new ControlPlaneDO(state, env) as Directory;
      // The constructor's whole cost is one probe of the partial index: nothing moved.
      expect(unsplit(state)).toBe(ids.length);
      expect(await state.storage.getAlarm()).not.toBeNull();
      // And before the backfill reaches them, every version reads from its manifest.
      expect(reads(deployed)).toEqual(want);
    });
  });

  it('one alarm moves one batch, and every read is right while the rest wait', async () => {
    await inDirectory(async (instance, state) => {
      await instance.alarm();
      expect(unsplit(state)).toBe(ids.length - 25);
      expect(await state.storage.getAlarm()).not.toBeNull(); // more to do, so it re-armed
      expect(reads(instance)).toEqual(want);
    });
  });

  it('the alarms run it to the end, and then stop arming', async () => {
    for (let i = 0; i < 10 && (await runDurableObjectAlarm(stub)); i++);
    await inDirectory(async (instance, state) => {
      expect(unsplit(state)).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
      expect(reads(instance)).toEqual(want);
      const manifests = state.storage.sql
        .exec("SELECT manifest_json FROM vertical_versions WHERE vertical_slug = 'acme'")
        .toArray() as { manifest_json: string | null }[];
      // No manifest carries SQL any more; the ones with nothing to take are as they came.
      for (const m of manifests) expect(m.manifest_json ?? '').not.toContain('CREATE TABLE');
      expect(manifests.map((m) => m.manifest_json)).toContain('not json');
      // The next construction finds nothing to do and arms nothing.
      new ControlPlaneDO(state, env);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('a restore of a dump taken before the backfill comes back unsplit, and is moved again', async () => {
    await inDirectory(async (instance, state) => {
      await instance.importDump(before);
      expect(unsplit(state)).toBe(ids.length);
      expect(await state.storage.getAlarm()).not.toBeNull();
      expect(reads(instance)).toEqual(want);
    });
    for (let i = 0; i < 10 && (await runDurableObjectAlarm(stub)); i++);
    await inDirectory(async (instance, state) => {
      expect(unsplit(state)).toBe(0);
      expect(reads(instance)).toEqual(want);
      // A dump taken AFTER carries the rows, and restores to the same answers with nothing to move.
      const after = instance.exportDump();
      expect(after.map((t) => t.name)).toContain('vertical_version_migrations');
      await instance.importDump(after);
      expect(unsplit(state)).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
      expect(reads(instance)).toEqual(want);
    });
  });
});
