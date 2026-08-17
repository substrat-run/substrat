/**
 * The registry and the migration journal are two descriptions of one schema.
 * `journalColumns` is shared (contracts) — three engines had drifting copies.
 */
import { describe, expect, it } from 'vitest';
import { journalColumns } from '@substrat-run/contracts';
import { entityRelationsOf } from '@substrat-run/contracts';
import { bookingEntities } from '../src/entities.js';
import { bookingModule } from '../src/index.js';

const journal = journalColumns((bookingModule.migrations ?? []).map((m) => m.sql).join('\n'));

describe('the registry agrees with the migration journal', () => {
  it('parsed the journal at all', () => {
    expect(journal.size).toBeGreaterThan(0);
    expect(journal.get('booking_reservations')?.size).toBeGreaterThan(1);
  });

  for (const [name, entity] of Object.entries(bookingEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const actual = journal.get(entity.table);
      expect(actual, `no CREATE TABLE for '${entity.table}'`).toBeDefined();
      expect(Object.keys(entity.fields.shape).sort()).toEqual([...(actual ?? [])].sort());
    });
  }

  it('carries the engine OWN parent edge', () => {
    // Everywhere else the parent is the vertical's noun, so engine registries
    // declare none. Here it is genuinely the engine's: a reservation cannot
    // exist without the resource it reserves.
    expect(bookingEntities.reservation.parents).toEqual(['resource']);
    expect(entityRelationsOf(bookingEntities)).toContainEqual({
      entityType: 'reservation',
      parentType: 'resource',
    });
  });

  it('leaves participants out — a join row, not an entity', () => {
    expect(journal.has('booking_participants')).toBe(true);
    expect(Object.values(bookingEntities).map((e) => e.table)).not.toContain('booking_participants');
  });
});
