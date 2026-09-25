import { describe, expect, it } from 'vitest';
import { listIndexMigrations, moduleMigrations, searchIndexMigrations } from '../src/index.js';

/**
 * `moduleMigrations` (#1677) is the one place a module's migration order is written: authored,
 * then the search indexes, then the list indexes. The hosts store it and `substrat push` carries
 * it, so a module changing only its `searchables` or `lists` shows as a migration change.
 */
describe('moduleMigrations', () => {
  const manifest = {
    id: 'helpdesk',
    searchables: [{ entityType: 'ticket', fields: ['title'], table: 'ticket', idColumn: 'id', tokenizer: 'unicode61' as const }],
    lists: [{ entityType: 'ticket', sortable: ['created_at', 'id'], filterable: ['status'], table: 'ticket', idColumn: 'id' }],
  };
  const authored = [{ version: '0001-init', sql: 'CREATE TABLE ticket (id TEXT PRIMARY KEY, title TEXT, status TEXT, created_at TEXT);' }];

  it('is the authored migrations, then the search indexes, then the list indexes', () => {
    const all = moduleMigrations({ manifest, migrations: authored });
    expect(all).toEqual([
      ...authored,
      ...searchIndexMigrations('helpdesk', manifest.searchables),
      ...listIndexMigrations('helpdesk', manifest.lists),
    ]);
    expect(all.map((m) => m.version.split('/')[0])).toEqual(['0001-init', 'search', 'list']);
  });

  it('a module that declares neither has exactly its authored set, and one with none has none', () => {
    expect(moduleMigrations({ manifest: { id: 'helpdesk' }, migrations: authored })).toEqual(authored);
    expect(moduleMigrations({ manifest: { id: 'helpdesk' } })).toEqual([]);
  });

  it('changing only `lists` changes the set', () => {
    const before = moduleMigrations({ manifest, migrations: authored });
    const after = moduleMigrations({
      manifest: { ...manifest, lists: [{ ...manifest.lists[0]!, filterable: ['status', 'title'] }] },
      migrations: authored,
    });
    expect(after.map((m) => m.version)).not.toEqual(before.map((m) => m.version));
  });
});
