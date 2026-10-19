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
  DIGEST_TICK_MINUTES,
  NOTIFICATIONS_PERM as PERM,
  notificationsModule,
  notify,
  sendDigests,
  type NotificationsDigestQuarantinedPayload,
} from '../src/index.js';
import { failingFor } from './kit.js';

const DAY = 24 * 60 * 60_000;
const TICK = DIGEST_TICK_MINUTES * 60_000;

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
        released: 0,
        withdrawn: 0,
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

      // Never in the way: my next message is due a day after it is held, not on the next tick
      // for being behind an old set-aside row.
      await assign([me.principal], 'later');
      clock.advance(TICK);
      expect(await schedule.invoke('notifications/send-digests', {})).toMatchObject({ digests: 0 });
      clock.advance(DAY - TICK);
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
        released: 0,
        withdrawn: 0,
      });
      expect(h.eventsOfType('notifications.digest-quarantined').map((e) => e.payload)).toEqual([
        { principal: me.principal, channel: 'email', occasions: [], unidentified: 1 },
      ]);
      expect(await h.host.listPlatformRequestHistory(h.tenant, h.scope)).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  /** One person whose only held message has been set aside as unreadable. */
  const setAside = async () => {
    const me = await someone();
    await me.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: true, cadence: 'daily-digest' });
    const [bad] = await assign([me.principal], 'bad');
    await drift(`UPDATE notifications_digest_items SET subject = X'00'`);
    clock.advance(DAY);
    const schedule = await h.as([PERM.sendDigests]);
    expect(await schedule.invoke('notifications/send-digests', {})).toMatchObject({ quarantined: 1 });
    const row = () =>
      h.run((ctx) =>
        ctx.sql.query<{ quarantined_at: string | null }>('SELECT quarantined_at FROM notifications_digest_items WHERE id = ?', [
          bad!.deliveryId,
        ]),
      );
    const delivery = async () =>
      (await (await h.as([PERM.read])).invoke<Page<Record<string, unknown>>>('notifications/list-deliveries', {})).entries.find(
        (d) => d.id === bad!.deliveryId,
      );
    return { me, bad: { deliveryId: bad!.deliveryId! }, schedule, row, delivery };
  };

  it('a switch-off leaves a set-aside row alone: still there, still quarantined, and not counted as withdrawn', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { me, row, delivery } = await setAside();
      await me.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: false });
      expect(await row()).toEqual([{ quarantined_at: clock.now() }]);
      expect(await delivery()).toMatchObject({ reason: 'quarantined' });
      expect(h.eventsOfType('notifications.preference-set').at(-1)!.payload).not.toHaveProperty('withdrawn');
    } finally {
      error.mockRestore();
    }
  });

  it('a set-aside row does not make a later hold look stale', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { me } = await setAside();
      // The set-aside row was held two days and a moment ago; the new one is fresh.
      clock.advance(DAY + 1);
      await assign([me.principal], 'fresh');
      expect(warn.mock.calls.map(([l]) => String(l)).filter((l) => l.includes('are sends being drained'))).toEqual([]);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('a set-aside row that reads again — its cause gone — is released a window later and sent', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { me, bad, schedule, row, delivery } = await setAside();
      // Whatever stored the bad value is gone: the row reads again.
      await drift(`UPDATE notifications_digest_items SET subject = 'Assigned' WHERE id = '${bad.deliveryId}'`);
      clock.advance(TICK);
      expect(await schedule.invoke('notifications/send-digests', {})).toMatchObject({ released: 0, digests: 0 });
      clock.advance(DAY - TICK);
      expect(await schedule.invoke('notifications/send-digests', {})).toMatchObject({ released: 1, digests: 1, items: 1 });
      expect(h.eventsOfType('notifications.digest-released').map((e) => e.payload)).toEqual([
        { principal: me.principal, channel: 'email', occasions: [bad.deliveryId] },
      ]);
      const sent = (await h.host.listPlatformRequestHistory(h.tenant, h.scope)).filter(isPlatformRequest);
      expect(sent.map((i) => (i.payload as { subjectId: string }).subjectId)).toEqual([me.principal]);
      expect(await row()).toEqual([]);
      expect(await delivery()).toMatchObject({ reason: 'digest', settled_at: clock.now() });
    } finally {
      error.mockRestore();
    }
  });

  it('a set-aside row that still does not read stays set aside: read again once a window, and said only once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { schedule, row, delivery } = await setAside();
      for (let day = 1; day <= 3; day += 1) {
        clock.advance(DAY);
        expect(await schedule.invoke('notifications/send-digests', {})).toMatchObject({ released: 0, quarantined: 0, digests: 0 });
        // Read again just now; not again until another window has passed.
        expect(await row()).toEqual([{ quarantined_at: clock.now() }]);
      }
      const lastRead = clock.now();
      clock.advance(TICK);
      await schedule.invoke('notifications/send-digests', {});
      expect(await row()).toEqual([{ quarantined_at: lastRead }]);
      expect(await delivery()).toMatchObject({ reason: 'quarantined' });
      expect(h.eventsOfType('notifications.digest-quarantined')).toHaveLength(1);
      expect(h.eventsOfType('notifications.digest-released')).toEqual([]);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  describe('a mute wins over a release, and over a send', () => {
    const repair = (id: string) => drift(`UPDATE notifications_digest_items SET subject = 'Assigned' WHERE id = '${id}'`);
    const intents = async () => (await h.host.listPlatformRequestHistory(h.tenant, h.scope)).filter(isPlatformRequest);
    const quietly = async (fn: () => Promise<void>) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await fn();
      } finally {
        error.mockRestore();
      }
    };

    it('a set-aside row whose topic was switched off since is withdrawn when it reads again — never released, never mailed', () =>
      quietly(async () => {
        const { me, bad, schedule, row, delivery } = await setAside();
        await me.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: false });
        await repair(bad.deliveryId);
        clock.advance(DAY);
        expect(await schedule.invoke('notifications/send-digests', {})).toMatchObject({ released: 0, withdrawn: 1, digests: 0 });
        expect(await intents()).toEqual([]);
        expect(await row()).toEqual([]);
        expect(await delivery()).toMatchObject({ status: 'skipped', reason: 'muted', settled_at: clock.now() });
        expect(h.eventsOfType('notifications.digest-withdrawn').map((e) => e.payload)).toEqual([
          { principal: me.principal, channel: 'email', occasions: [bad.deliveryId] },
        ]);
        expect(h.eventsOfType('notifications.digest-released')).toEqual([]);
      }));

    it('switched off and on again, it is released and sent as before', () =>
      quietly(async () => {
        const { me, bad, schedule, delivery } = await setAside();
        await me.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: false });
        await me.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: true });
        await repair(bad.deliveryId);
        clock.advance(DAY);
        expect(await schedule.invoke('notifications/send-digests', {})).toMatchObject({ released: 1, withdrawn: 0, digests: 1 });
        expect(await intents()).toHaveLength(1);
        expect(await delivery()).toMatchObject({ reason: 'digest' });
      }));

    it('a mute from before the topic became required does not withdraw it: required wins over the mute, as at notify', () =>
      quietly(async () => {
        const { me, bad, schedule } = await setAside();
        await me.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: false });
        await h.run((ctx) =>
          notify(ctx, {
            topic: 'order-assigned',
            description: 'A work order was assigned to you',
            dedupeKey: 'now-required',
            recipients: [],
            required: true,
            template: { subject: 'Assigned', text: 'You have a work order.' },
          }),
        );
        await repair(bad.deliveryId);
        clock.advance(DAY);
        expect(await schedule.invoke('notifications/send-digests', {})).toMatchObject({ released: 1, withdrawn: 0, digests: 1 });
      }));

    it('a held row whose topic is muted with no withdrawal behind it is withdrawn at send time, not mailed', () =>
      quietly(async () => {
        const me = await someone();
        const other = await someone();
        for (const p of [me, other]) {
          await p.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: true, cadence: 'daily-digest' });
        }
        const [mine] = await assign([me.principal, other.principal], 'held');
        // A mute that reached the table by some path that withdrew nothing.
        await drift(
          `INSERT INTO notifications_mutes (principal, topic, channel, created_at)
           VALUES ('${me.principal}', 'order-assigned', 'email', '2026-03-02T07:00:00.000Z')`,
        );
        clock.advance(DAY);
        expect(await (await h.as([PERM.sendDigests])).invoke('notifications/send-digests', {})).toMatchObject({
          digests: 1,
          withdrawn: 1,
        });
        expect((await intents()).map((i) => (i.payload as { subjectId: string }).subjectId)).toEqual([other.principal]);
        expect(h.eventsOfType('notifications.digest-withdrawn').map((e) => e.payload)).toEqual([
          { principal: me.principal, channel: 'email', occasions: [mine!.deliveryId] },
        ]);
        const log = (await (await h.as([PERM.read])).invoke<Page<Record<string, unknown>>>('notifications/list-deliveries', {})).entries;
        expect(log.find((d) => d.id === mine!.deliveryId)).toMatchObject({ reason: 'muted' });
      }));
  });

  it("a failed digest's report and backoff leave a set-aside row out: it neither counts as waiting nor is held back", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { me, bad } = await setAside();
      const [held] = await assign([me.principal], 'held');
      clock.advance(DAY);
      expect(await h.run((ctx) => sendDigests(failingFor(me.principal)(ctx)))).toMatchObject({ failed: 1 });
      expect(h.eventsOfType('notifications.digest-failed').map((e) => e.payload)).toEqual([
        expect.objectContaining({ principal: me.principal, items: 1 }),
      ]);
      const rows = await h.run((ctx) =>
        ctx.sql.query<{ id: string; failed_at: string | null }>('SELECT id, failed_at FROM notifications_digest_items ORDER BY id'),
      );
      expect(Object.fromEntries(rows.map((r) => [r.id, r.failed_at]))).toEqual({
        [bad.deliveryId]: null,
        [held!.deliveryId!]: clock.now(),
      });
    } finally {
      error.mockRestore();
    }
  });
});
