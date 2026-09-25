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
