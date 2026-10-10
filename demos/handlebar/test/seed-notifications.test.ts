import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { buildBikeShopHost, seedBikeShop } from '../src/index.js';

/**
 * The seed's notification addresses are set once, as each person, and a restart leaves them
 * alone: it neither overwrites an address the person changed nor announces anything again.
 */
describe('seeding notification addresses', () => {
  it('a second seed run writes and emits nothing, and keeps a changed address', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handlebar-seed-notify-'));
    try {
      let host = buildBikeShopHost(dir);
      const w = await seedBikeShop(host, dir);
      const mans = await host.getScope(w.mans, w.t1, w.s1);
      expect(await mans.invoke('notifications/my-preferences', {})).toMatchObject({ email: 'mans@handlebar.test' });
      await mans.invoke('notifications/set-my-address', { email: 'mans.elsewhere@handlebar.test' });
      await host.close();

      const announced = () => {
        const db = new Database(join(dir, `${w.t1}__${w.s1}.sqlite`), { readonly: true });
        try {
          return (
            db.prepare("SELECT COUNT(*) AS n FROM _substrat_outbox WHERE type = 'notifications.recipient-updated'").get() as {
              n: number;
            }
          ).n;
        } finally {
          db.close();
        }
      };
      const before = announced();
      expect(before).toBe(3); // greta, måns, and måns's own change

      host = buildBikeShopHost(dir);
      await seedBikeShop(host, dir);
      expect(announced()).toBe(before);
      const again = await host.getScope(w.mans, w.t1, w.s1);
      expect(await again.invoke('notifications/my-preferences', {})).toMatchObject({
        email: 'mans.elsewhere@handlebar.test',
      });
      await host.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
