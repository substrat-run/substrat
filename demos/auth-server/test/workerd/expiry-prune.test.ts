/**
 * The prune's wiring in the real `AuthServerDO` (K-71, `src/expiry-prune.ts`): a request arms
 * the alarm only when the switch is on, the alarm deletes what is past its grace and keeps the
 * rest, and re-arms for the next row to expire. What is deleted, row by row, is the node suite's
 * (`test/expiry-prune.test.ts`); this holds what only workerd has, the alarm.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const stubOf = (name: string) => env.AUTH.get(env.AUTH.idFromName(name));
const HOUR = 3_600_000;

describe('expired-row prune in the Durable Object', () => {
  it('stays unarmed while off, and when on deletes the expired, keeps the live, and re-arms for it', async () => {
    const off = stubOf('prune-off');
    await off.fetch('https://auth-server.test/__session');
    expect(await runInDurableObject(off, (_i, state) => state.storage.getAlarm())).toBeNull();

    const stub = stubOf('prune-on');
    const live = Date.now() + 2 * HOUR;
    await runInDurableObject(stub, (_i, state) => {
      const now = Date.now();
      const sql = state.storage.sql;
      sql.exec("INSERT INTO config (key, value) VALUES ('cfg:PRUNE_EXPIRED', 'on'), ('cfg:PRUNE_GRACE_HOURS', '1')");
      sql.exec("INSERT INTO user (id, name, email) VALUES ('u1', 'Ada', 'ada@example.com')");
      sql.exec("INSERT INTO session (id, expires_at, token, updated_at, user_id) VALUES ('gone', ?, 't1', 0, 'u1'), ('kept', ?, 't2', 0, 'u1')", now - 2 * HOUR, live);
      sql.exec("INSERT INTO verification (id, identifier, value, expires_at) VALUES ('v-gone', 'k', 'v', ?)", now - 2 * HOUR);
    });
    await stub.fetch('https://auth-server.test/__session');
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).not.toBeNull();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const after = await runInDurableObject(stub, async (_i, state) => ({
      sessions: [...state.storage.sql.exec('SELECT id FROM session')].map((r) => r.id),
      verifications: [...state.storage.sql.exec('SELECT id FROM verification')].length,
      alarm: await state.storage.getAlarm(),
    }));
    expect(after).toEqual({ sessions: ['kept'], verifications: 0, alarm: live + HOUR });
  });
});
