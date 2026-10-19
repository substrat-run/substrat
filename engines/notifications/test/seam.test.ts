/**
 * The seam, under drift (#771/#970): when a stored row stops matching the shape this engine
 * publishes, the caller gets a throw, never wrong data. The drift is simulated by moving the
 * table under a running engine, which is what a version skew looks like from inside.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPlatformRequest, type Page } from '@substrat-run/contracts';
import { manualClock } from '@substrat-run/kernel';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  NOTIFICATIONS_PERM as PERM,
  notificationsModule,
  notify,
  type NotificationsDigestQuarantinedPayload,
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

  it("a held row that stopped reading is set aside on its own: the rest of that person's digest and everyone else's go out, and it is said", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const me = await someone();
      const other = await someone();
      for (const p of [me, other]) {
        await p.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: true, cadence: 'daily-digest' });
      }
      const [bad] = await assign([me.principal], 'bad');
      clock.advance(1_000);
      await assign([me.principal, other.principal], 'good');
      await drift(`UPDATE notifications_digest_items SET subject = X'00' WHERE id = '${bad!.deliveryId}'`);
      clock.advance(DAY);
      const schedule = await h.as([PERM.sendDigests]);

      expect(await schedule.invoke('notifications/send-digests', {})).toEqual({
        digests: 2,
        items: 2,
        failed: 0,
        deferred: 0,
        quarantined: 1,
      });
      // My readable message went out on its own, not behind the bad one.
      const intents = (await h.host.listPlatformRequestHistory(h.tenant, h.scope)).filter(isPlatformRequest);
      expect(intents.map((i) => (i.payload as { subjectId: string }).subjectId).sort()).toEqual([me.principal, other.principal].sort());
      expect(intents.find((i) => (i.payload as { subjectId: string }).subjectId === me.principal)!.payload).toMatchObject({ subject: 'Assigned' });

      // The bad row stays, marked, for repair; its occasion's delivery says what happened.
      const rows = () =>
        h.run((ctx) =>
          ctx.sql.query<{ id: string; quarantined_at: string | null }>('SELECT id, quarantined_at FROM notifications_digest_items'),
        );
      expect(await rows()).toEqual([{ id: bad!.deliveryId, quarantined_at: clock.now() }]);
      const admin = await h.as([PERM.read]);
      const log = (await admin.invoke<Page<Record<string, unknown>>>('notifications/list-deliveries', {})).entries;
      expect(log.find((d) => d.id === bad!.deliveryId)).toMatchObject({ status: 'skipped', reason: 'quarantined', settled_at: clock.now() });

      // Said on the spine and on an error line, by occasion id — never by what the row held.
      const quarantined = () =>
        h.eventsOfType('notifications.digest-quarantined').map((e) => e.payload as NotificationsDigestQuarantinedPayload);
      expect(quarantined()).toEqual([{ principal: me.principal, channel: 'email', occasions: [bad!.deliveryId], unidentified: 0 }]);
      const lines = error.mock.calls.map(([l]) => JSON.parse(String(l)) as { fields: Record<string, unknown> });
      expect(lines).toEqual([
        expect.objectContaining({ fields: expect.objectContaining({ principal: me.principal, occasions: bad!.deliveryId, count: 1 }) }),
      ]);

      // Never tried again, and never in the way: my next message goes out a day after it is held.
      await assign([me.principal], 'later');
      clock.advance(DAY);
      expect(await schedule.invoke('notifications/send-digests', {})).toMatchObject({ digests: 1, items: 1, quarantined: 0 });
      expect(quarantined()).toHaveLength(1);
      expect(await rows()).toEqual([{ id: bad!.deliveryId, quarantined_at: expect.any(String) }]);
    } finally {
      error.mockRestore();
    }
  });

  it('a row whose very id stopped reading is still set aside, and counted as unidentified', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const me = await someone();
      await me.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: true, cadence: 'daily-digest' });
      await assign([me.principal], 'held');
      await drift(`UPDATE notifications_digest_items SET id = X'00'`);
      clock.advance(DAY);
      expect(await (await h.as([PERM.sendDigests])).invoke('notifications/send-digests', {})).toMatchObject({
        digests: 0,
        quarantined: 1,
      });
      expect(h.eventsOfType('notifications.digest-quarantined').map((e) => e.payload)).toEqual([
        { principal: me.principal, channel: 'email', occasions: [], unidentified: 1 },
      ]);
      expect(await h.host.listPlatformRequestHistory(h.tenant, h.scope)).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });
});
