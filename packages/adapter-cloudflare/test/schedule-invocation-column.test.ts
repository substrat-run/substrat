/**
 * #1525's ALTER on a real Durable Object, run twice — not the #1288 REBUILD (the
 * second describe below), and not the single ALTER a restore could once reach
 * either (since #1883 a restore builds the spine from KERNEL_DDL): a restore never forces a LIVE
 * DO to be reconstructed, so it can show the column arriving once but never show the
 * same `ALTER TABLE ... ADD COLUMN invocation_id` meeting a table that already has
 * it. `applySpineColumnAdditions` runs unconditionally in the DO's constructor, on
 * EVERY wake, so a scope that survives two wakes hits that statement twice — the
 * "duplicate column name" branch is what makes the second one a no-op instead of a
 * boot failure. Reaching a second wake needs a real eviction (`state.abort`), which
 * only a test with the raw DO stub can force.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { moduleId, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { scheduleMod } from '@substrat-run/contract-tests';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

// Crockford base32, 26 chars — the shape a minted `ulid()` always has. Declared here
// rather than imported from `@substrat-run/contract-tests`, which keeps this constant
// out of that package's published index for the sake of one shared regex.
const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SCHED = moduleId.parse('@test/sched');

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

describe('#1525: _substrat_schedule_state ALTERs invocation_id in on a DO created before it', () => {
  it('adds the column on the next wake, a fired schedule records the id, and a second wake tolerates the repeat ALTER', async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      checker: UNSAFE_allowAllChecker,
    });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const reader = principalId.parse(ulid());
    // Guards the `finally`'s archive: an assertion above can fail before the scope
    // exists at all, and archiving one that was never provisioned would throw a
    // second, unrelated error over the real one.
    let provisioned = false;
    try {
      host.registerModule(scheduleMod);
      await host.admin.createTenant(staff, { id: t, slug: `alter1525-${ulid().toLowerCase()}`, name: 'Alter' });
      await host.admin.grantEntitlement(staff, t, 'sched');
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
      provisioned = true;
      await host.admin.activateScope(staff, t, s);

      // A fresh `env.SCOPE.get` each time, never a reused reference: `state.abort()`
      // poisons the stub it was called through, and the framework's own retry
      // ("Please retry the DurableObjectStub#fetch() call") is a NEW stub, not the
      // same one tried again.
      const freshStub = () => env.SCOPE.get(env.SCOPE.idFromName(s));
      const readFiredRow = () =>
        runInDurableObject(
          freshStub(),
          (_instance, state) =>
            (
              state.storage.sql
                .exec(
                  "SELECT invocation_id FROM _substrat_schedule_state WHERE kind = 'schedule' AND schedule_op = 'sched/tick'",
                )
                .toArray() as unknown as { invocation_id: string | null }[]
            )[0],
        );

      // Roll `_substrat_schedule_state` back to the shape #1288 left and #1525
      // replaced — `kind` already in the key, no `invocation_id` column at all. The
      // table is empty (no sweep has touched this scope yet), so nothing is lost.
      await runInDurableObject(freshStub(), (_instance, state) => {
        state.storage.sql.exec('DROP TABLE _substrat_schedule_state');
        state.storage.sql.exec(
          'CREATE TABLE _substrat_schedule_state (kind TEXT NOT NULL, schedule_op TEXT NOT NULL, ' +
            'last_run_at TEXT, last_status TEXT, PRIMARY KEY (kind, schedule_op))',
        );
      });

      // The first eviction. `abort()` throws inside the DO by contract — the caller's
      // RPC dies with it — and the NEXT call constructs a fresh instance over the same
      // storage, whose constructor runs `applySpineColumnAdditions`: the first ALTER.
      await runInDurableObject(freshStub(), (_instance, state) => {
        state.abort('evicted for #1525 test — first wake');
      }).catch(() => undefined);

      const shapeAfterFirstWake = await runInDurableObject(
        freshStub(),
        (_instance, state) =>
          (
            state.storage.sql
              .exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '_substrat_schedule_state'")
              .toArray() as unknown as { sql: string }[]
          )[0]!.sql,
      );
      expect(shapeAfterFirstWake).toMatch(/invocation_id/);

      // Fire through the real path: nothing has ever run on this scope, so `sched/tick`
      // and the #1288 collision fixture (`freshness:sched.ticked`, declared as a
      // schedule) are both immediately due.
      const report = await host.runDueSchedules(SCHED, t, s);
      expect(report.fired).toBe(2);

      const firedRow = await readFiredRow();
      expect(firedRow?.invocation_id).toMatch(ULID_SHAPE);

      // Mark the CURRENT instance before evicting it again — proof that what
      // follows is a genuinely NEW construction, not a no-op retry against the
      // same live object. `state.abort()` throwing is not itself that proof: a
      // pool that swallowed it and handed back the same instance would look
      // identical from the outside.
      await runInDurableObject(freshStub(), (instance) => {
        (instance as unknown as { __evictionProbe?: true }).__evictionProbe = true;
      });

      // The SECOND eviction: the next construction re-runs the exact same ALTER
      // against a table that already carries the column — the "duplicate column
      // name" branch `applySpineColumnAdditions` exists to swallow. It must not
      // throw, and the row this test just proved must survive it untouched.
      await runInDurableObject(freshStub(), (_instance, state) => {
        state.abort('evicted for #1525 test — second wake');
      }).catch(() => undefined);

      const survivedEviction = await runInDurableObject(
        freshStub(),
        (instance) => (instance as unknown as { __evictionProbe?: true }).__evictionProbe,
      );
      expect(survivedEviction).toBeUndefined();

      await expect(host.getScope(reader, t, s)).resolves.toBeDefined();
      expect((await readFiredRow())?.invocation_id).toBe(firedRow?.invocation_id);
    } finally {
      // Archive before closing, in `finally` so a failed assertion above still
      // cleans up: `CONTROL_PLANE` is shared across every test FILE in this worker
      // (#1591), and `runPlatformSweep` enumerates every ACTIVE scope in it
      // regardless of which host provisioned one. Left active, this scope's live
      // `sched:tick` grant would be due again on the next sweep any OTHER suite
      // runs over `CONTROL_PLANE`. (`schedule-suite.ts`, whose counts are exact, has
      // a directory of its own since #1899.) Guarded by `provisioned`: archiving a scope that was
      // never provisioned throws its own error, masking whatever failed above.
      if (provisioned) await host.admin.archiveScope(staff, t, s);
      await host.close();
    }
  });
});

/**
 * #1288's REBUILD on a real Durable Object, woken over a table that predates `kind`. The shared
 * schedule suite used to reach this through a restore, which replayed a dump's pre-#1288 DDL
 * into a live store. Since #1883 a restore builds every spine table from KERNEL_DDL and derives
 * `kind` for the dump's rows itself, so the only way left to hold the old table is to have held
 * it at wake — which is what this stages: put the old table back, evict, and read what the next
 * construction left.
 */
describe('#1288: a DO woken over a pre-kind _substrat_schedule_state rebuilds it, once', () => {
  it('backfills kind from the freshness: prefix, keeps every row, and a second wake is a no-op', async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      checker: UNSAFE_allowAllChecker,
    });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    let provisioned = false;
    try {
      await host.admin.createTenant(staff, { id: t, slug: `rebuild1288-${ulid().toLowerCase()}`, name: 'Rebuild' });
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'rebuild-vertical' });
      provisioned = true;
      const freshStub = () => env.SCOPE.get(env.SCOPE.idFromName(s));
      const evict = (why: string) =>
        runInDurableObject(freshStub(), (_instance, state) => {
          state.abort(why);
        }).catch(() => undefined);
      const read = () =>
        runInDurableObject(freshStub(), (_instance, state) => ({
          ddl: (
            state.storage.sql
              .exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '_substrat_schedule_state'")
              .toArray() as unknown as { sql: string }[]
          )[0]!.sql,
          rows: state.storage.sql
            .exec('SELECT kind, schedule_op, last_status, invocation_id FROM _substrat_schedule_state ORDER BY schedule_op')
            .toArray(),
          scratch: state.storage.sql
            .exec("SELECT name FROM sqlite_master WHERE name = '_substrat_schedule_state_new'")
            .toArray().length,
        }));

      // The pre-#1288 table, one row of each family — the statuses differ, so a rebuild that
      // dropped the rows and let a sweep recreate them could not pass.
      await runInDurableObject(freshStub(), (_instance, state) => {
        state.storage.sql.exec('DROP TABLE _substrat_schedule_state');
        state.storage.sql.exec(
          'CREATE TABLE _substrat_schedule_state (schedule_op TEXT PRIMARY KEY, last_run_at TEXT, last_status TEXT)',
        );
        state.storage.sql.exec(
          `INSERT INTO _substrat_schedule_state VALUES
             ('freshness:sched.ticked', '2026-09-01T00:00:00.000Z', 'failed'),
             ('sched/tick', '2026-09-01T00:00:00.000Z', 'ok')`,
        );
      });
      await evict('evicted for #1288 test — first wake');

      const want = [
        { kind: 'freshness', schedule_op: 'freshness:sched.ticked', last_status: 'failed', invocation_id: null },
        { kind: 'schedule', schedule_op: 'sched/tick', last_status: 'ok', invocation_id: null },
      ];
      const first = await read();
      expect(first.ddl).toMatch(/PRIMARY KEY \(kind, schedule_op\)/);
      expect(first.rows).toEqual(want);
      expect(first.scratch).toBe(0);

      await evict('evicted for #1288 test — second wake');
      expect(await read()).toEqual(first);
    } finally {
      if (provisioned) await host.admin.archiveScope(staff, t, s);
      await host.close();
    }
  });
});

/**
 * #1883 on a real Durable Object: a restore keeps a spine column a newer kernel's dump carried,
 * as a plain untyped column spelled as the dump spelled it. When a later kernel adds that
 * column for real, its additive ALTER meets it on the next wake and must tolerate it as a
 * duplicate; otherwise the DO cannot construct. Staged on the one additive column the kernel
 * still ALTERs in, `_substrat_deliveries.invocation_id`, untyped and lowercased as a restore adds it.
 */
describe('#1883: a DO woken over a column a restore added untyped', () => {
  it('constructs, keeps the value, and does not add the column twice', async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      checker: UNSAFE_allowAllChecker,
    });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    let provisioned = false;
    try {
      await host.admin.createTenant(staff, { id: t, slug: `untyped1883-${ulid().toLowerCase()}`, name: 'Untyped' });
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'untyped-vertical' });
      provisioned = true;
      const freshStub = () => env.SCOPE.get(env.SCOPE.idFromName(s));
      await runInDurableObject(freshStub(), (_instance, state) => {
        state.storage.sql.exec('DROP TABLE _substrat_deliveries');
        state.storage.sql.exec(
          'CREATE TABLE _substrat_deliveries (event_id TEXT NOT NULL, consumer_module TEXT NOT NULL, ' +
            'delivered_at TEXT NOT NULL, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, ' +
            'PRIMARY KEY (event_id, consumer_module))',
        );
        state.storage.sql.exec('ALTER TABLE _substrat_deliveries ADD COLUMN "invocation_id"');
        state.storage.sql.exec(
          `INSERT INTO _substrat_deliveries (event_id, consumer_module, delivered_at, invocation_id)
           VALUES ('e1', 'm1', '2026-09-01T00:00:00.000Z', 'inv-1')`,
        );
      });
      await runInDurableObject(freshStub(), (_instance, state) => {
        state.abort('evicted for #1883 test');
      }).catch(() => undefined);

      const after = await runInDurableObject(freshStub(), (_instance, state) => {
        const cursor = state.storage.sql.exec('SELECT * FROM _substrat_deliveries');
        return { columns: cursor.columnNames, rows: Array.from(cursor.raw(), (r) => [...r]) };
      });
      expect(after.columns.filter((c) => c.toLowerCase() === 'invocation_id')).toEqual(['invocation_id']);
      expect(after.rows).toEqual([['e1', 'm1', '2026-09-01T00:00:00.000Z', null, 0, null, 'inv-1']]);
      // And the scope serves: the constructor's column pass did not throw.
      await expect(host.admin.exportScope(staff, t, s)).resolves.toBeDefined();
    } finally {
      if (provisioned) await host.admin.archiveScope(staff, t, s);
      await host.close();
    }
  });
});
