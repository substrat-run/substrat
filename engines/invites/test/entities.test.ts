/**
 * The registry and the migration journal are two descriptions of one schema.
 * `journalColumns` is shared (contracts) — three engines had drifting copies.
 */
import { describe, expect, it } from 'vitest';
import { journalColumns } from '@substrat-run/contracts';
import { invitation, invitationRow, invitesEntities } from '../src/entities.js';
import { invitesModule } from '../src/index.js';

const journal = journalColumns((invitesModule.migrations ?? []).map((m) => m.sql).join('\n'));

describe('the registry agrees with the migration journal', () => {
  it('parsed the journal at all', () => {
    expect(journal.size).toBeGreaterThan(0);
    expect(journal.get('invites_invitation')?.size).toBeGreaterThan(1);
  });

  for (const [name, entity] of Object.entries(invitesEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('publishes the row MINUS the hash', () => {
    // The point of hashing the invitee's identifier is that nobody else reads
    // it. The registry describes what is stored; `invitation` is what may be
    // returned, and returning the row instead would publish exactly that.
    expect(Object.keys(invitationRow.shape)).toContain('identifier_hash');
    expect(Object.keys(invitation.shape)).not.toContain('identifier_hash');
    expect(invitesEntities.invitation.erasable).toEqual(['identifier_hash']);
  });
});
