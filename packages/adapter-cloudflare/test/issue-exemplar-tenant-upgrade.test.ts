import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ulid } from '@substrat-run/kernel';
import { ControlPlaneDO } from '../src/control-plane-do.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1632, Durable Object half: `_substrat_issues.last_tenant_id` arrives on a directory DO
 * that already holds issues — which is production. Erasure rewrites an exemplar only for the
 * tenant this column names, so an issue from before it is backfilled once, from retained
 * ops-failure rows carrying the same text under the same fingerprint, and only when they name
 * exactly one tenant. Staged by constructing a second `ControlPlaneDO` over storage the first
 * one built with the column dropped — new code, old storage, which is what a deploy is.
 */

const T1 = '01JTENANTAAAAAAAAAAAAAAAA1';
const T2 = '01JTENANTAAAAAAAAAAAAAAAA2';
const AT = '2099-01-01T00:00:00.000Z';

const ISSUES = [
  ['fp-one-tenant', 'one tenant said this'],
  ['fp-no-rows', 'nothing retained says this'],
  ['fp-two-tenants', 'two tenants said this'],
  ['fp-tenant-and-platform', 'a tenant and the platform said this'],
  ['fp-other-text', 'the exemplar'],
  ['fp-platform-only', 'only the platform said this'],
] as const;
const FAILURES = [
  ['01JFAILAAAAAAAAAAAAAAAAAA1', 'fp-one-tenant', 'one tenant said this', T1],
  ['01JFAILAAAAAAAAAAAAAAAAAA2', 'fp-two-tenants', 'two tenants said this', T1],
  ['01JFAILAAAAAAAAAAAAAAAAAA3', 'fp-two-tenants', 'two tenants said this', T2],
  ['01JFAILAAAAAAAAAAAAAAAAAA4', 'fp-tenant-and-platform', 'a tenant and the platform said this', T1],
  ['01JFAILAAAAAAAAAAAAAAAAAA5', 'fp-tenant-and-platform', 'a tenant and the platform said this', null],
  ['01JFAILAAAAAAAAAAAAAAAAAA6', 'fp-other-text', 'not the exemplar', T1],
  ['01JFAILAAAAAAAAAAAAAAAAAA7', 'fp-platform-only', 'only the platform said this', null],
  ['01JFAILAAAAAAAAAAAAAAAAAA8', 'fp-platform-only', 'only the platform said this', null],
] as const;
/** (owner kind, tenant) per issue: proven by one origin, or unknown. */
const EXPECTED = {
  'fp-one-tenant': ['tenant', T1],
  'fp-platform-only': ['platform', null],
  'fp-no-rows': [null, null],
  'fp-two-tenants': [null, null],
  'fp-tenant-and-platform': [null, null],
  'fp-other-text': [null, null],
};

describe('#1632: a directory DO whose issues predate exemplar ownership', () => {
  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
  });

  const legacyDirectory = async () => {
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`issue-tenant-${ulid()}`));
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec('ALTER TABLE _substrat_issues DROP COLUMN last_owner_kind');
      sql.exec('ALTER TABLE _substrat_issues DROP COLUMN last_tenant_id');
      for (const [fp, text] of ISSUES) {
        sql.exec(
          `INSERT INTO _substrat_issues (fingerprint, operation, status, seen_count, first_seen, last_seen, last_message)
           VALUES (?, 'op', 'new', 1, ?, ?, ?)`,
          fp, AT, AT, text,
        );
      }
      for (const [id, fp, text, tenant] of FAILURES) {
        sql.exec(
          `INSERT INTO _substrat_ops_failures (id, actor, operation, tenant_id, message, fingerprint, at)
           VALUES (?, 'staff', 'op', ?, ?, ?, ?)`,
          id, tenant, text, fp, AT,
        );
      }
    });
    return stub;
  };

  const hasColumn = (state: DurableObjectState) =>
    state.storage.sql
      .exec("SELECT 1 FROM pragma_table_info('_substrat_issues') WHERE name = 'last_owner_kind'")
      .toArray().length === 1;
  const attribution = (state: DurableObjectState) =>
    Object.fromEntries(
      state.storage.sql
        .exec('SELECT fingerprint, last_owner_kind, last_tenant_id FROM _substrat_issues')
        .toArray()
        .map((r) => [r['fingerprint'], [r['last_owner_kind'], r['last_tenant_id']]]),
    );

  it('adds the column on construction, attributes only what one retained tenant proves, and backfills once', async () => {
    const stub = await legacyDirectory();
    const seen = await runInDurableObject(stub, (_instance, state) => {
      const staged = hasColumn(state);
      new ControlPlaneDO(state, env);
      const upgraded = { column: hasColumn(state), attribution: attribution(state) };
      // After the column exists its writer owns it: a NULL is a fact the writer recorded,
      // and the next construction must not turn it into a tenant's.
      state.storage.sql.exec(
        "UPDATE _substrat_issues SET last_tenant_id = NULL, last_owner_kind = NULL WHERE fingerprint = 'fp-one-tenant'",
      );
      new ControlPlaneDO(state, env);
      return { staged, upgraded, again: attribution(state)['fp-one-tenant'] };
    });
    expect(seen.staged).toBe(false);
    expect(seen.upgraded.column).toBe(true);
    expect(seen.upgraded.attribution).toEqual(EXPECTED);
    expect(seen.again).toEqual([null, null]);
  });

  it('commits the columns only with their backfill — a crash between them is re-run on the next construction', async () => {
    // The backfill's gate is "this construction added the column". Committed separately, a
    // column that landed before a backfill that then failed would read as migrated for good.
    // The crash is a trigger that refuses the backfill's UPDATE, once.
    const stub = await legacyDirectory();
    const seen = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER crash_backfill BEFORE UPDATE ON _substrat_issues BEGIN SELECT RAISE(ABORT, 'crash mid-backfill'); END",
      );
      let crash = '';
      try {
        new ControlPlaneDO(state, env);
      } catch (err) {
        crash = (err as Error).message;
      }
      const afterCrash = hasColumn(state);
      state.storage.sql.exec('DROP TRIGGER crash_backfill');
      new ControlPlaneDO(state, env);
      return { crash, afterCrash, column: hasColumn(state), attribution: attribution(state) };
    });
    expect(seen.crash).toMatch(/crash mid-backfill/);
    // Rolled back whole: neither column survived the failed backfill.
    expect(seen.afterCrash).toBe(false);
    expect(seen.column).toBe(true);
    expect(seen.attribution).toEqual(EXPECTED);
  });
});
