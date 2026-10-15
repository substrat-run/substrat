/**
 * The registry and the migration journal are two descriptions of one schema; they agree.
 */
import { describe, expect, it } from 'vitest';
import { journalColumns } from '@substrat-run/model-emit';
import { assistantEntities } from '../src/entities.js';
import { assistantManifest, assistantModule } from '../src/index.js';

const journal = journalColumns((assistantModule.migrations ?? []).map((m) => m.sql).join('\n'));

describe('the registry agrees with the migration journal', () => {
  it('parsed the journal at all', () => {
    expect(journal.size).toBe(4);
  });

  for (const [name, entity] of Object.entries(assistantEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('every table that holds the person’s words or ids declares its erasure by delete (K-46)', () => {
    expect(assistantEntities['assistant-event'].erasable).toEqual(['body']);
    // Carried into the manifest a host reads — a hand-written manifest would declare none.
    expect(assistantManifest.erasure?.entities.map((e) => [e.entityType, e.mode]).sort()).toEqual([
      ['assistant-event', 'delete'],
      ['assistant-run', 'delete'],
      ['assistant-thread', 'delete'],
      ['assistant-tool-call', 'delete'],
    ]);
  });
});
