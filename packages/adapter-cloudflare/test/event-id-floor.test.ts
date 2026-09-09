/**
 * The event-id floor outlives the DO instance that held it (#1335), Cloudflare half.
 *
 * A scope's Durable Object is evicted and revived constantly, and the floor #956 gave
 * the mint was a field on the instance — so a revived DO started again from the wall
 * clock. A clock that has stepped back (an NTP correction is small, but real) then
 * mints an id UNDERNEATH rows already stored, and `ORDER BY id` never hands them to a
 * reader paging past the last one it saw.
 *
 * The DO reads the wall clock and has no options bag to inject one through, so the
 * rewind cannot be scripted here the way `adapter-sqlite/test/event-id-floor.test.ts`
 * scripts it. The relation under test is the same one either way — "the persisted
 * maximum is above what the clock is about to stamp" — so this reaches it from the
 * other side: it puts a row an hour AHEAD of the wall clock into the outbox, evicts
 * the DO, and emits. Seeded, the new id clears it; unseeded, it sorts underneath.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { createUlid, ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

interface OutboxRow {
  id: string;
}

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

describe('the event-id floor survives an eviction (#1335)', () => {
  it('mints above the outbox maximum after the DO is discarded and revived', async () => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      checker: UNSAFE_allowAllChecker,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    try {
      const staff = platformActorId.parse(ulid());
      const t1 = tenantId.parse(ulid());
      const s1 = scopeId.parse(ulid());
      const anna = principalId.parse(ulid());
      await host.admin.createTenant(staff, {
        id: t1,
        slug: `floor-${ulid().toLowerCase()}`,
        name: 'Floor',
      });
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'floor-vertical' });
      await host.admin.activateScope(staff, t1, s1);

      let stub = await host.getScope(anna, t1, s1);
      await stub.invoke('test/emit-event');
      const before = (await stub.invoke<OutboxRow[]>('test/read-outbox')).map((r) => r.id);
      expect(before.length).toBeGreaterThan(0);

      // The same DO the host addresses (`scopeStub`: `idFromName(scopeId)`), reached
      // raw so the test can write to the spine — harness code, not module code, which
      // is the only kind `ctx.sql`'s `_substrat_*` write guard would let past anyway.
      const raw = env.SCOPE.get(env.SCOPE.idFromName(s1));
      const planted = createUlid()(Date.now() + 3_600_000);
      await runInDurableObject(raw, (_instance, state) => {
        state.storage.sql.exec(
          'UPDATE _substrat_outbox SET id = ? WHERE id = ?',
          planted,
          before[before.length - 1]!,
        );
      });
      // Committed, not just executed — the assertion below is worthless otherwise.
      const stored = await runInDurableObject(raw, (_instance, state) =>
        (state.storage.sql.exec('SELECT MAX(id) AS id FROM _substrat_outbox').toArray() as unknown as {
          id: string;
        }[])[0]!.id,
      );
      expect(stored).toBe(planted);

      // The eviction. `abort()` throws inside the DO by contract — the object is gone
      // and the caller's RPC dies with it; the next call constructs a new instance
      // over the same storage, which is exactly what a revived DO is.
      await runInDurableObject(raw, (_instance, state) => {
        state.abort('evicted for #1335');
      }).catch(() => undefined);

      stub = await host.getScope(anna, t1, s1);
      await stub.invoke('test/emit-event');
      const after = (await stub.invoke<OutboxRow[]>('test/read-outbox')).map((r) => r.id);
      const fresh = after.filter((id) => id !== planted && !before.includes(id));
      expect(fresh).toHaveLength(1);

      // The claim: the revived instance seeded its floor from the row on disk, so the
      // new id clears an instant the wall clock has not reached yet.
      expect(fresh[0]! > planted).toBe(true);
      // And `ORDER BY id` — the outbox's cursor — puts it last, where a reader
      // continuing after `planted` is handed it.
      expect(after[after.length - 1]).toBe(fresh[0]);
    } finally {
      await host.close();
    }
  });
});
