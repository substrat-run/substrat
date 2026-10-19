/**
 * The seam, under drift (#771/#970): when a stored row stops matching the shape this engine
 * publishes, the caller gets a throw, never wrong data. The drift is simulated by moving the
 * table under a running engine, which is what a version skew looks like from inside.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import { NOTIFICATIONS_PERM as PERM, notificationsModule, notify } from '../src/index.js';

describe('engine-notifications — the seam is parsed, not asserted', () => {
  let h: EngineHarness;
  beforeEach(async () => {
    h = await engineHarness({ modules: [notificationsModule] });
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

  /** A person with an address, and the topic used once so they can choose it. */
  const someone = async () => {
    const p = await h.mintPrincipal([PERM.self]);
    await p.stub.invoke('notifications/set-my-address', { email: 'me@example.test' });
    await h.run((ctx) =>
      notify(ctx, {
        topic: 'order-assigned',
        description: 'A work order was assigned to you',
        dedupeKey: `seed-${p.principal}`,
        recipients: [],
        template: { subject: 'Assigned', text: 'You have a work order.' },
      }),
    );
    return p;
  };

  it('a cadence a later version might add throws on the preference read, never shows as immediate', async () => {
    const me = await someone();
    await drift(`ALTER TABLE notifications_cadences RENAME TO old_cadences`);
    await drift(`CREATE TABLE notifications_cadences AS SELECT * FROM old_cadences`);
    await drift(
      `INSERT INTO notifications_cadences (principal, topic, channel, cadence, updated_at)
       VALUES ('${me.principal}', 'order-assigned', 'email', 'weekly-digest', '2030-01-01T00:00:00.000Z')`,
    );
    await expect(me.stub.invoke('notifications/my-preferences', {})).rejects.toMatchObject({ code: 'internal' });
  });

  it('a held item whose text stopped being text throws rather than being mailed, and stays held', async () => {
    const me = await someone();
    await me.stub.invoke('notifications/set-my-preference', { topic: 'order-assigned', enabled: true, cadence: 'daily-digest' });
    await h.run((ctx) =>
      notify(ctx, {
        topic: 'order-assigned',
        description: 'A work order was assigned to you',
        dedupeKey: 'held',
        recipients: [me.principal],
        template: { subject: 'Assigned', text: 'You have a work order.' },
      }),
    );
    await drift(`UPDATE notifications_digest_items SET subject = X'00'`);
    const schedule = await h.as([PERM.sendDigests]);
    await expect(schedule.invoke('notifications/send-digests', {})).rejects.toMatchObject({ code: 'internal' });
    // The throw rolled the whole digest back: the item is still held, and no mail was written.
    expect(await h.run((ctx) => ctx.sql.query('SELECT id FROM notifications_digest_items'))).toHaveLength(1);
    expect(await h.host.listPlatformRequestHistory(h.tenant, h.scope)).toEqual([]);
  });
});
