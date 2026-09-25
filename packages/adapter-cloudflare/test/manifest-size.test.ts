/**
 * How large a deploy manifest the control plane can actually store (#1677), on workerd.
 *
 * A version's manifest is one row in the control-plane Durable Object, and a DO's SQLite
 * refuses a string or row over 2 MB. Node's SQLite allows about a gigabyte, so the SQLite
 * adapter can never show this (the #1655 class). `substrat push` leaves the SQL migrations off
 * a manifest that would pass `DEPLOY_MANIFEST_BYTES_SAFE`; these pin that the bound stores,
 * and that what the first cap (2 MiB of SQL) let through would not have.
 */
import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DECLARED_MIGRATIONS_SQL_BYTES_MAX,
  DEPLOY_MANIFEST_BYTES_SAFE,
  deployManifest,
  platformActorId,
  sqlBytes,
} from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
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

  it('stores a manifest exactly at the bound, and reads it back whole', async () => {
    const empty = bytes(manifestWithSql(''));
    const json = manifestWithSql('x'.repeat(DEPLOY_MANIFEST_BYTES_SAFE - empty));
    expect(bytes(json)).toBe(DEPLOY_MANIFEST_BYTES_SAFE);
    const id = await publish(json);
    expect(await host.admin.versionManifest(staff, vertical, id)).toBe(json);
  });

  it('refuses one the first caps admitted: under 2 MiB of SQL, grown past the row by escaping', async () => {
    // Quoted identifiers and newlines, as emitted SQL is full of: each `"` and each newline
    // escapes to two bytes in JSON.
    const statement = 'CREATE TABLE "t" ("id" TEXT);\n';
    const sql = statement.repeat(Math.floor((2 * 1024 * 1024) / statement.length));
    const json = manifestWithSql(sql);
    // What those caps said yes to — the refine counted the SQL, never the manifest.
    expect(sqlBytes([{ sql }])).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(bytes(json)).toBeGreaterThan(2 * 1024 * 1024);
    const refused = await publish(json).then(() => null, (e: Error) => e);
    expect(refused?.message).toMatch(/too big|TOOBIG/);
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
