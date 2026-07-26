import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { runPlatformSweep, ulid, UNSAFE_allowAllChecker } from '@substrat-run/kernel';
import type { FetchLike, ModuleRegistration } from '@substrat-run/kernel';
import { brokenMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * A failed migration must leave a record (#32). kernel-design §5.3: failure is
 * per-scope and fails closed — one scope down, not the fleet. Before this, the
 * directory learned nothing from that: `schema_version` was projected only on the
 * success path, so a half-migrated scope kept a stale value and rendered `active`.
 *
 * Its own host: the broken module would fail every scope in a shared fixture.
 */
describe('migration failure is recorded in the directory', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-migfail-'));
    host = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
    host.registerModule(brokenMod);
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    // Entitlements are default-deny (§4.3): without the grant the module never
    // loads, its migration never runs, and this suite would pass vacuously.
    await host.admin.grantEntitlement(staff, t, 'broken');
    // Provisioning applies migrations eagerly, so this is the first failed
    // attempt — expected, and swallowed so the suite can assert on what it left
    // behind. (The scope row exists; it is the migration that failed.)
    await expect(
      host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu' }),
    ).rejects.toThrow(/scope fails closed/);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails the scope closed rather than serving a half-migrated schema', async () => {
    await expect(host.getScope(alice, t, s)).rejects.toThrow(/scope fails closed/);
  });

  it('records which module@version failed, and why', async () => {
    await expect(host.getScope(alice, t, s)).rejects.toThrow();
    const record = await host.admin.getScopeRecord(staff, t, s);
    expect(record?.migrationFailure).not.toBeNull();
    expect(record?.migrationFailure?.version).toBe('@test/broken@0002-broken');
    expect(record?.migrationFailure?.error).toMatch(/./);
    expect(record?.migrationFailure?.lastAttemptAt).toMatch(/^\d{4}-/);
  });

  it('projects the count that actually landed, not the pre-attempt value', async () => {
    // `0001-ok` applied and journaled; `0002-broken` rolled back. A stale '0'
    // here is the exact symptom #32 describes — the scope looking untouched.
    const record = await host.admin.getScopeRecord(staff, t, s);
    expect(record?.schemaVersion).toBe('1');
  });

  it('counts consecutive attempts, so a sweep can back off (#49)', async () => {
    const before = (await host.admin.getScopeRecord(staff, t, s))?.migrationFailure?.attempts ?? 0;
    await expect(host.getScope(alice, t, s)).rejects.toThrow();
    const after = (await host.admin.getScopeRecord(staff, t, s))?.migrationFailure?.attempts ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it('leaves a healthy scope with no failure record', async () => {
    const ok = scopeId.parse(ulid());
    const healthyDir = mkdtempSync(join(tmpdir(), 'substrat-migok-'));
    const healthy = new SqliteScopeHost({ dir: healthyDir, checker: UNSAFE_allowAllChecker });
    try {
      await healthy.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await healthy.provisionScope(staff, { tenantId: t, scopeId: ok, jurisdiction: 'eu' });
      await healthy.admin.activateScope(staff, t, ok);
      await healthy.getScope(alice, t, ok);
      const record = await healthy.admin.getScopeRecord(staff, t, ok);
      expect(record?.migrationFailure).toBeNull();
    } finally {
      await healthy.close();
      rmSync(healthyDir, { recursive: true, force: true });
    }
  });

  // -- the reconciliation sweep's half (#49), on the same broken fixture ------

  it('migrateScope returns a structured failure and advances the attempt counter', async () => {
    const before = (await host.admin.getScopeRecord(staff, t, s))?.migrationFailure?.attempts ?? 0;
    const outcome = await host.migrateScope(t, s);
    expect(outcome).toEqual({
      status: 'failed',
      failure: {
        version: '@test/broken@0002-broken',
        error: expect.any(String),
      },
    });
    const after = (await host.admin.getScopeRecord(staff, t, s))?.migrationFailure;
    expect(after?.attempts).toBe(before + 1);
  });

  it('the frontier names the scope behind: two registered, one landed', async () => {
    expect(host.migrationFrontier()).toEqual({ total: 2 });
    const record = await host.admin.getScopeRecord(staff, t, s);
    expect(Number(record?.schemaVersion)).toBeLessThan(host.migrationFrontier().total);
  });

  it('runPlatformSweep finds, retries and reports the failed scope end to end', async () => {
    const report = await runPlatformSweep(host, {
      actor: staff,
      fetch: (() => Promise.reject(new Error('unused'))) as unknown as FetchLike,
      sweepers: {},
      drainRetries: false,
      migrationBackoff: { baseDelayMs: 0 }, // always due — this is a test, not production cadence
    });
    expect(report.migrations).toMatchObject({
      release: '2',
      total: 1,
      migrated: 0,
      pending: 0,
      failed: 1,
      complete: false,
      attempted: 1,
      repaired: 0,
    });
    expect(report.migrations?.summary).toBe('release 2: 0/1 migrated, 0 pending, 1 failed');
    expect(report.migrations?.stragglers[0]).toMatchObject({
      scopeId: s,
      state: 'failed',
    });
  });

  it('a patched forward release heals the scope through migrateScope (§5.3 recovery)', async () => {
    // The recovery path §5.3 names: per-scope state plus a PATCHED release. A new
    // host over the same directory is exactly what a redeploy is; its fixed
    // migration applies, the journal fills in, and the failure record clears.
    // (The broken 0002 never applied anywhere — patching it is the recovery,
    // not an edit of shipped history.)
    const fixedMod: ModuleRegistration = {
      ...brokenMod,
      migrations: [
        { version: '0001-ok', sql: 'CREATE TABLE broken_ok (id TEXT PRIMARY KEY)' },
        { version: '0002-broken', sql: 'CREATE TABLE broken_t (id TEXT PRIMARY KEY)' },
      ],
    };
    const patched = new SqliteScopeHost({ dir, checker: UNSAFE_allowAllChecker });
    try {
      patched.registerModule(fixedMod);
      const outcome = await patched.migrateScope(t, s);
      expect(outcome).toEqual({ status: 'migrated', schemaVersion: '2' });
      const record = await patched.admin.getScopeRecord(staff, t, s);
      expect(record?.schemaVersion).toBe('2');
      expect(record?.migrationFailure).toBeNull(); // attempts reset — consecutive means consecutive
      // And the fleet view agrees: the skew window is closed.
      const report = await runPlatformSweep(patched, {
        actor: staff,
        fetch: (() => Promise.reject(new Error('unused'))) as unknown as FetchLike,
        sweepers: {},
        drainRetries: false,
      });
      expect(report.migrations).toMatchObject({ total: 1, migrated: 1, failed: 0, complete: true });
    } finally {
      await patched.close();
    }
  });

  it('migrateScope fails closed on a (tenant, scope) mismatch and on non-live scopes', async () => {
    await expect(host.migrateScope(tenantId.parse(ulid()), s)).rejects.toThrow(/unknown scope/);
  });
});
