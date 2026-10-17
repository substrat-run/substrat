/**
 * The integrity check at apply time (#2349), on a real Durable Object: a pass with migrations
 * pending applies nothing unless the migrations the script registers are the ones stored for
 * the version it serves — `env.SUBSTRAT_MIGRATIONS_DIGEST`, which the uploader injects. The
 * class (`SetCheckScopeDO`, test/worker.ts) reads it from a key the test sets, since env is
 * script-wide here. The pure host's half is `adapter-sqlite/test/migration-set-check.test.ts`.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { listMod } from '@substrat-run/contract-tests';
import { isDerivedMigrationVersion, migrationSetDigest, moduleMigrations, ulid, UNSAFE_allowAllChecker } from '@substrat-run/kernel';
import { migrationSetDigestComputations } from '@substrat-run/kernel/testing';
import { CloudflareScopeHost } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';
import { SET_CHECK_DIGEST } from './worker.js';

const MODULE = listMod.manifest.id;
const steps = moduleMigrations(listMod);
/** Its authored steps: the part the check compares. `listMod` also derives a list index. */
const authored = steps.filter((m) => !isDerivedMigrationVersion(m.version));
/** The digest the uploader injects for a version storing `migrations`: the kernel function it calls. */
const digestOf = (migrations: readonly { version: string; sql: string }[]) =>
  migrationSetDigest(migrations.map((m) => ({ moduleId: MODULE, version: m.version, sql: m.sql })));
const setStored = (digest: string | undefined) => {
  (globalThis as Record<symbol, string | undefined>)[SET_CHECK_DIGEST] = digest;
};

describe('the migration set check at apply time, on DO SQLite (#2349)', () => {
  const staff = platformActorId.parse(ulid());
  const who = principalId.parse(ulid());
  const ns = () => env.SET_CHECK_SCOPE;
  let host: CloudflareScopeHost;
  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    host = new CloudflareScopeHost({ scope: ns(), controlPlane: env.CONTROL_PLANE, checker: UNSAFE_allowAllChecker });
    host.registerModule(listMod);
  });
  afterEach(() => setStored(undefined));
  afterAll(async () => host.close());

  const provision = async () => {
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `set-${ulid().toLowerCase()}`, name: 'Set check' });
    await host.admin.grantEntitlement(staff, t, 'list');
    return { t, s, provisioned: host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'list-vertical' }) };
  };
  const journalOf = (s: string) =>
    runInDurableObject(ns().get(ns().idFromName(s)), async (_i, state) =>
      state.storage.sql
        .exec('SELECT version FROM _substrat_migrations WHERE module_id = ? ORDER BY version', MODULE)
        .toArray()
        .map((r) => r.version as string),
    );
  const add = async (t: ReturnType<typeof tenantId.parse>, s: ReturnType<typeof scopeId.parse>) =>
    (await host.getScope(who, t, s)).invoke('list/add', { id: ulid(), number: ulid(), status: 'open', kind: 'a' });

  it('applies when the registered migrations are the stored ones, kernel-derived ones included', async () => {
    setStored(await digestOf(steps));
    const { t, s, provisioned } = await provision();
    await provisioned;
    await host.admin.activateScope(staff, t, s);
    await expect(add(t, s)).resolves.toBeDefined();
    expect(await journalOf(s)).toEqual(steps.map((m) => m.version).sort());
  });

  it('refuses, applying nothing, when the stored migration differs from the SQL the script registers', async () => {
    const stored = await digestOf(steps.map((m, i) => (i === 0 ? { ...m, sql: `${m.sql}\n-- the push declared other SQL` } : m)));
    const registered = await digestOf(steps);
    setStored(stored);
    const { t, s, provisioned } = await provision();
    await expect(provisioned).rejects.toThrow(
      `migration failed for ${MODULE}@${steps[0]!.version} — scope fails closed: the authored migrations this deployment registers are ` +
        `not the ones stored for the version it serves (registered set sha256 ${registered}, stored ${stored}); registered: ` +
        `${authored.map((m) => `${MODULE}@${m.version}`).join(', ')}. Nothing was applied.`,
    );
    const record = await host.admin.getScopeRecord(staff, t, s);
    expect(record?.migrationFailure?.version).toBe(`${MODULE}@${steps[0]!.version}`);
    expect(record?.migrationFailure?.error).toContain(stored);
    expect(await journalOf(s)).toEqual([]);
    const tables = await runInDurableObject(ns().get(ns().idFromName(s)), async (_i, state) =>
      state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table'`).toArray().map((r) => r.name as string),
    );
    expect(tables.filter((n) => !n.startsWith('_'))).toEqual([]);
  });

  for (const [what, stored] of [
    ['without the derived steps (a CLI that did not resolve the kernel)', () => authored],
    ['with a derived step spelled otherwise', () => steps.map((m) => (isDerivedMigrationVersion(m.version) ? { ...m, sql: `${m.sql} ` } : m))],
  ] as const) {
    it(`applies when the stored set differs only in derived steps: ${what}`, async () => {
      expect(steps.length).toBeGreaterThan(authored.length);
      setStored(await digestOf(stored()));
      const { t, s, provisioned } = await provision();
      await provisioned;
      await host.admin.activateScope(staff, t, s);
      await expect(add(t, s)).resolves.toBeDefined();
      expect(await journalOf(s)).toEqual(steps.map((m) => m.version).sort());
    });
  }

  it('compares nothing without the binding: a script uploaded before it, or an unheld version, keeps applying', async () => {
    setStored(undefined);
    const { t, s, provisioned } = await provision();
    await provisioned;
    await host.admin.activateScope(staff, t, s);
    await expect(add(t, s)).resolves.toBeDefined();
    expect(await journalOf(s)).toEqual(steps.map((m) => m.version).sort());
  });

  it('a scope with nothing pending never computes the digest, on a wake under a stored digest that differs', async () => {
    setStored(await digestOf(steps));
    const { t, s, provisioned } = await provision();
    await provisioned;
    await host.admin.activateScope(staff, t, s);
    await add(t, s);
    setStored('0'.repeat(64));
    await runInDurableObject(ns().get(ns().idFromName(s)), (_i, state) => {
      state.abort('evicted for a fresh wake');
    }).catch(() => undefined);
    const before = migrationSetDigestComputations();
    await expect(add(t, s)).resolves.toBeDefined();
    expect(migrationSetDigestComputations()).toBe(before);
  });
});
