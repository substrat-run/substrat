/**
 * #2066's ALTER on a real Durable Object: a scope whose journal predates `sql_digest` gains the
 * column on its next wake, its rows get the legacy mark — accepted, never backfilled — and a
 * second wake tolerates the repeat ALTER. The contract suite covers the digest rule itself; only
 * a test holding the raw DO stub can force the eviction a second wake needs.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { listMod } from '@substrat-run/contract-tests';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

it('adds sql_digest to a legacy journal on wake, marks its rows legacy, and tolerates a second wake (#2066)', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    checker: UNSAFE_allowAllChecker,
  });
  host.registerModule(listMod);
  const staff = platformActorId.parse(ulid());
  const who = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: `digest-up-${ulid().toLowerCase()}`, name: 'Digest upgrade' });
  await host.admin.grantEntitlement(staff, t, 'list');
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'list-vertical' });
  try {
    await host.admin.activateScope(staff, t, s);
    const add = async () =>
      (await host.getScope(who, t, s)).invoke('list/add', { id: ulid(), number: ulid(), status: 'open', kind: 'a' });
    await add();
    const fresh = () => env.SCOPE.get(env.SCOPE.idFromName(s));
    const digests = () =>
      runInDurableObject(fresh(), (_instance, state) =>
        state.storage.sql
          .exec("SELECT sql_digest FROM _substrat_migrations WHERE module_id = '@test/list'")
          .toArray()
          .map((r) => r.sql_digest));
    expect((await digests()).every((d) => typeof d === 'string' && /^[0-9a-f]{64}$/.test(d))).toBe(true);
    // The drop commits in a call of its own, before the eviction (see job-run-subject-upgrade).
    await runInDurableObject(fresh(), (_instance, state) => {
      // The journal as every scope had it before #2066: no fence, no column.
      state.storage.sql.exec('DROP TRIGGER _substrat_migrations_digest_required');
      state.storage.sql.exec('DROP TRIGGER _substrat_migrations_digest_kept');
      state.storage.sql.exec('ALTER TABLE _substrat_migrations DROP COLUMN sql_digest');
    });
    await runInDurableObject(fresh(), (_instance, state) => {
      state.abort('evicted for the sql_digest upgrade');
    }).catch(() => undefined);
    await expect(add()).resolves.toBeDefined();
    const legacy = await digests();
    expect(legacy.length).toBeGreaterThan(0);
    // Marked, not backfilled: the rows present when the column arrived say so.
    expect(legacy.every((d) => d === 'legacy')).toBe(true);
    await runInDurableObject(fresh(), (_instance, state) => {
      state.abort('evicted to check the repeat sql_digest ALTER');
    }).catch(() => undefined);
    await expect(add()).resolves.toBeDefined();
    expect(await digests()).toEqual(legacy);

    // An instance still on the previous release writes its journal row without the column: the
    // fence aborts it, so it fails its own migration loudly rather than recording NULL. The rows
    // already there are untouched, and the scope keeps serving the new code.
    const OLD_INSERT =
      'INSERT INTO _substrat_migrations (module_id, version, applied_at, duration_ms, rows_changed) VALUES (?, ?, ?, ?, ?)';
    const oldWrite = await runInDurableObject(fresh(), (_instance, state) => {
      try {
        state.storage.sql.exec(OLD_INSERT, '@test/list', '9999-old', 'x', 0, 0);
        return 'written';
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(oldWrite).toContain('a migration journal row must carry its sql_digest (#2066)');
    // Nor can a row's digest be cleared afterwards.
    const cleared = await runInDurableObject(fresh(), (_instance, state) => {
      try {
        state.storage.sql.exec("UPDATE _substrat_migrations SET sql_digest = NULL WHERE module_id = '@test/list'");
        return 'cleared';
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(cleared).toContain('a migration journal row must carry its sql_digest (#2066)');
    // The twin: with its digest, the same row goes in.
    await runInDurableObject(fresh(), (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO _substrat_migrations (module_id, version, applied_at, duration_ms, rows_changed, sql_digest) VALUES (?, ?, ?, ?, ?, ?)',
        '@test/probe', '9999-new', 'x', 0, 0, 'f'.repeat(64),
      );
      state.storage.sql.exec("DELETE FROM _substrat_migrations WHERE module_id = '@test/probe'");
    });
    expect(await digests()).toEqual(legacy);
    await expect(add()).resolves.toBeDefined();
  } finally {
    await host.admin.archiveScope(staff, t, s);
  }
});

describe('a migration that reaches for the journal is refused before any of it runs, on DO SQLite (#2066)', () => {
  const staff = platformActorId.parse(ulid());
  const hosts: CloudflareScopeHost[] = [];
  afterAll(async () => {
    for (const h of hosts) await h.close();
  });

  for (const [what, ns, version] of [
    ['drops the digest fence', () => env.JOURNAL_FENCE_DROP_SCOPE, '@test/journal-fence-drop@0001-init'],
    ['writes the journal', () => env.JOURNAL_WRITE_SCOPE, '@test/journal-write@0001-init'],
  ] as const) {
    it(`one that ${what}`, async () => {
      const host = new CloudflareScopeHost({ scope: ns(), controlPlane: env.CONTROL_PLANE, checker: UNSAFE_allowAllChecker });
      hosts.push(host);
      const t = tenantId.parse(ulid());
      const s = scopeId.parse(ulid());
      await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
      await host.admin.grantEntitlement(staff, t, 'notes');
      await expect(host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu' })).rejects.toThrow(
        `migration failed for ${version} — scope fails closed: migration ${version} cannot name the migration journal`,
      );
      const objects = await runInDurableObject(ns().get(ns().idFromName(s)), async (_i, state) =>
        state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')`).toArray().map((r) => r.name as string),
      );
      // None of it ran: not the harmless first statement, and the fence is where it was.
      expect(objects).not.toContain('jt');
      expect(objects).toEqual(expect.arrayContaining(['_substrat_migrations_digest_required', '_substrat_migrations_digest_kept']));
    });
  }
});
