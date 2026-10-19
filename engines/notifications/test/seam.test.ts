/**
 * The seam, under drift (#771/#970): when a stored row stops matching the shape this engine
 * publishes, the caller gets a throw, never wrong data. The drift is simulated by moving the
 * table under a running engine, which is what a version skew looks like from inside.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPlatformRequest } from '@substrat-run/contracts';
import { manualClock } from '@substrat-run/kernel';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  NOTIFICATIONS_PERM as PERM,
  notificationsModule,
  notify,
  type NotificationsDigestFailedPayload,
} from '../src/index.js';

const DAY = 24 * 60 * 60_000;

describe('engine-notifications — the seam is parsed, not asserted', () => {
  let h: EngineHarness;
  let clock: ReturnType<typeof manualClock>;
  beforeEach(async () => {
    clock = manualClock('2026-03-02T07:00:00.000Z');
    h = await engineHarness({ modules: [notificationsModule], clock: clock.read });
  });
  afterEach(async () => {
    await h.close();
  });

  const drift = (sql: string) => h.run((ctx) => void ctx.sql.exec(sql));

  it('a delivery whose status left the published enum throws on the list', async () => {
    const admin = await h.as([PERM.read]);
    // A status a later version might add, written as that version would.
    await drift(`ALTER TABLE notifications_deliveries RENAME TO old_deliveries`);
    await drift(`CREATE TABLE notifications_deliveries AS SELECT * FROM old_deliveries`);
    await drift(
      `INSERT INTO notifications_deliveries (id, topic, dedupe_key, principal, channel,
         status, reason, request_id, about_type, about_id, created_at, settled_at)
       VALUES ('01JDRIFT000000000000000000', 't', 'e', '01JPRINCIPAL00000000000000', 'email',
         'bounced', NULL, NULL, NULL, NULL, '2030-01-01T00:00:00.000Z', NULL)`,
    );
    await expect(admin.invoke('notifications/list-deliveries', {})).rejects.toMatchObject({ code: 'internal' });
  });

  it('a preference read throws when the stored address stops being text', async () => {
    const me = await h.as([PERM.self]);
    await me.invoke('notifications/set-my-address', { email: 'me@example.test' });
    await drift(`UPDATE notifications_recipients SET email = X'00'`);
    await expect(me.invoke('notifications/my-preferences', {})).rejects.toMatchObject({ code: 'internal' });
  });

  const assign = (recipients: string[], dedupeKey: string) =>
    h.run((ctx) =>
      notify(ctx, {
        topic: 'order-assigned',
        description: 'A work order was assigned to you',
        dedupeKey,
        recipients,
        template: { subject: 'Assigned', text: 'You have a work order.' },
      }),
    );

  /** A person with an address, and the topic used once so they can choose it. */
  const someone = async () => {
    const p = await h.mintPrincipal([PERM.self]);
    await p.stub.invoke('notifications/set-my-address', { email: 'me@example.test' });
    await assign([], `seed-${p.principal}`);
    return p;
  };

  it('a cadence a later version might add throws on the preference read, never shows as immediate', async () => {
    const me = await someone();
    // No CHECK holds the column, so a later version's value lands as written.
    await drift(
      `INSERT INTO notifications_cadences (principal, topic, channel, cadence, updated_at)
       VALUES ('${me.principal}', 'order-assigned', 'email', 'weekly-digest', '2030-01-01T00:00:00.000Z')`,
    );
    await expect(me.stub.invoke('notifications/my-preferences', {})).rejects.toMatchObject({ code: 'internal' });
  });

  it("a held item that stopped being text throws for its person only: theirs stays held, everyone else's goes out, and it is said", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const me = await someone();
      const other = await someone();
      for (const p of [me, other]) {
        await p.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: true, cadence: 'daily-digest' });
      }
      await assign([me.principal, other.principal], 'held');
      await drift(`UPDATE notifications_digest_items SET subject = X'00' WHERE principal = '${me.principal}'`);
      clock.advance(DAY);
      const schedule = await h.as([PERM.sendDigests]);

      // The pass succeeds: the other person's digest is written, mine is not, and nothing of mine was let go.
      expect(await schedule.invoke('notifications/send-digests', {})).toEqual({ digests: 1, items: 1, failed: 1, deferred: 0 });
      const intents = (await h.host.listPlatformRequestHistory(h.tenant, h.scope)).filter(isPlatformRequest);
      expect(intents).toHaveLength(1);
      expect(intents[0]!.payload).toMatchObject({ subjectId: other.principal });
      const heldNow = () =>
        h.run((ctx) => ctx.sql.query<{ principal: string; failed_at: string | null }>('SELECT principal, failed_at FROM notifications_digest_items'));
      expect(await heldNow()).toEqual([{ principal: me.principal, failed_at: clock.now() }]);

      // Said on the spine, naming the person and what waits, and on an error line with the cause.
      const failed = () => h.eventsOfType('notifications.digest-failed').map((e) => e.payload as NotificationsDigestFailedPayload);
      const retryAt = new Date(Date.parse(clock.now()) + DAY).toISOString();
      expect(failed()).toEqual([{ principal: me.principal, channel: 'email', cadence: 'daily-digest', items: 1, code: 'internal', retryAt }]);
      const lines = error.mock.calls.map(([l]) => JSON.parse(String(l)) as { fields: Record<string, unknown>; message: string });
      expect(lines).toEqual([
        expect.objectContaining({ fields: expect.objectContaining({ principal: me.principal, items: 1 }), message: expect.stringContaining('does not match the shape') }),
      ]);

      // Not retried on every tick: a window passes first, then it is tried — and said — again.
      clock.advance(DAY - 60_000);
      expect(await schedule.invoke('notifications/send-digests', {})).toEqual({ digests: 0, items: 0, failed: 0, deferred: 0 });
      expect(failed()).toHaveLength(1);
      clock.advance(60_000);
      expect(await schedule.invoke('notifications/send-digests', {})).toMatchObject({ failed: 1 });
      expect(failed()).toHaveLength(2);
    } finally {
      error.mockRestore();
    }
  });
});
