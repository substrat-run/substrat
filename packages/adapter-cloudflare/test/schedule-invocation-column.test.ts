/**
 * #1525's ALTER on a real Durable Object, run twice — not the #1288 REBUILD the
 * shared schedule contract suite proves through a restore, and not the single ALTER
 * that suite's export/restore trick can reach either: a restore never forces a LIVE
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
import { scheduleMod, ULID_SHAPE } from '@substrat-run/contract-tests';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

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
    try {
      host.registerModule(scheduleMod);
      const staff = platformActorId.parse(ulid());
      const t = tenantId.parse(ulid());
      const s = scopeId.parse(ulid());
      const reader = principalId.parse(ulid());
      await host.admin.createTenant(staff, { id: t, slug: `alter1525-${ulid().toLowerCase()}`, name: 'Alter' });
      await host.admin.grantEntitlement(staff, t, 'sched');
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
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

      // The SECOND eviction: the next construction re-runs the exact same ALTER
      // against a table that already carries the column — the "duplicate column
      // name" branch `applySpineColumnAdditions` exists to swallow. It must not
      // throw, and the row this test just proved must survive it untouched.
      await runInDurableObject(freshStub(), (_instance, state) => {
        state.abort('evicted for #1525 test — second wake');
      }).catch(() => undefined);

      await expect(host.getScope(reader, t, s)).resolves.toBeDefined();
      expect((await readFiredRow())?.invocation_id).toBe(firedRow?.invocation_id);

      // Archive before closing: `CONTROL_PLANE` is shared across every test FILE in
      // this worker (#1591), and `runPlatformSweep` enumerates every ACTIVE scope in
      // it regardless of which host provisioned one. Left active, this scope's live
      // `sched:tick` grant would be due again on the next sweep any OTHER suite
      // runs, inflating counts that assume a closed world — exactly the fired/skipped
      // totals `schedule-suite.ts` asserts as exact numbers.
      await host.admin.archiveScope(staff, t, s);
    } finally {
      await host.close();
    }
  });
});
