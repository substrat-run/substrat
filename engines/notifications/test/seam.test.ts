/**
 * The seam, under drift (#771/#970): when a stored row stops matching the shape this engine
 * publishes, the caller gets a throw, never wrong data. The drift is simulated by moving the
 * table under a running engine, which is what a version skew looks like from inside.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import { NOTIFICATIONS_PERM as PERM, notificationsModule } from '../src/index.js';

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
});
