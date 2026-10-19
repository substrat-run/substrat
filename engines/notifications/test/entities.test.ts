/**
 * The registry and the migration journal are two descriptions of one schema; they agree.
 */
import { describe, expect, it } from 'vitest';
import { journalColumns } from '@substrat-run/model-emit';
import { notificationsEntities } from '../src/entities.js';
import { notificationsManifest, notificationsModule } from '../src/index.js';

const journal = journalColumns((notificationsModule.migrations ?? []).map((m) => m.sql).join('\n'));

describe('the registry agrees with the migration journal', () => {
  it('parsed the journal at all', () => {
    expect(journal.size).toBe(6);
  });

  for (const [name, entity] of Object.entries(notificationsEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('the address is erasable, and an erasure deletes the row it lives on (K-46)', () => {
    expect(notificationsEntities['notification-recipient'].erasable).toEqual(['email']);
    // Carried into the manifest a host reads — a hand-written manifest would declare none.
    expect(notificationsManifest.erasure?.entities).toMatchObject([
      { entityType: 'notification-digest-item', mode: 'delete' },
      { entityType: 'notification-recipient', mode: 'delete' },
    ]);
  });

  it('a held digest item is the person\'s mail, rendered: erasable, and deleted with them', () => {
    expect(notificationsEntities['notification-digest-item'].erasable).toEqual(['subject', 'text', 'html']);
    expect(notificationsEntities['notification-digest-item'].erasure).toEqual({ subjects: ['principal'], mode: 'delete' });
  });
});
