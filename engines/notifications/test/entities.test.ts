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
    expect(journal.size).toBe(4);
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
      { entityType: 'notification-recipient', mode: 'delete' },
    ]);
  });
});
