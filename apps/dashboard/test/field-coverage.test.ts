import { describe, expect, it } from 'vitest';
import type { DeclaredOperationOutput, EmittedModel } from '@substrat-run/contracts';
import { deriveFieldCoverage } from '../src/field-coverage.js';

const MODEL = {
  entities: {
    contact: {
      table: 'contacts',
      fields: {
        type: 'object',
        properties: { id: {}, email: {}, display_name: {}, legacy_note: {} },
      },
      primaryKey: 'id',
      erasable: ['email', 'display_name'],
    },
    ticket: {
      table: 'tickets',
      fields: { type: 'object', properties: { id: {}, subject: {}, internal_rank: {} } },
      primaryKey: 'id',
    },
  },
  lifecycles: {},
} as unknown as EmittedModel;

const SURFACE: DeclaredOperationOutput[] = [
  { operationId: 'get-contact', fields: ['id', 'email', 'display_name'] },
  { operationId: 'list-tickets', fields: ['id', 'subject'] },
];

describe('deriveFieldCoverage (#1321)', () => {
  it('names the fields no operation declares, and flags the erasable ones', () => {
    const view = deriveFieldCoverage({ model: MODEL, outputSurface: SURFACE });
    expect(view.available).toBe(true);
    expect(view.declared).toBe(7);
    expect(view.returned).toBe(5);
    expect(view.operations).toBe(2);

    const contact = view.entities.find((e) => e.entity === 'contact')!;
    expect(contact.neverReturned.map((f) => f.field)).toEqual(['legacy_note']);
    const ticket = view.entities.find((e) => e.entity === 'ticket')!;
    expect(ticket.neverReturned.map((f) => f.field)).toEqual(['internal_rank']);
    // Neither unreturned field is personal, so there is no retention argument here.
    expect(view.neverReturnedErasable).toBe(0);
  });

  it('counts an unreturned erasable field as a retention argument', () => {
    // `email` stops being returned: the app stores personal data it never hands back.
    const view = deriveFieldCoverage({
      model: MODEL,
      outputSurface: [{ operationId: 'get-contact', fields: ['id', 'display_name'] }],
    });
    expect(view.neverReturnedErasable).toBe(1);
    const contact = view.entities.find((e) => e.entity === 'contact')!;
    expect(contact.neverReturned.find((f) => f.field === 'email')!.erasable).toBe(true);
  });

  it('is CONSERVATIVE: a name shared with another entity counts as returned', () => {
    // `id` is returned for tickets only, but the match is by name across the whole
    // surface — so contact.id reads as returned. Under-reporting is the safe
    // direction for a list whose purpose is to justify deleting something.
    const view = deriveFieldCoverage({
      model: MODEL,
      outputSurface: [{ operationId: 'list-tickets', fields: ['id'] }],
    });
    const contact = view.entities.find((e) => e.entity === 'contact')!;
    expect(contact.fields.find((f) => f.field === 'id')!.returned).toBe(true);
    expect(contact.neverReturned.map((f) => f.field)).not.toContain('id');
  });

  it('says UNKNOWN, not "nothing is returned", when the version predates the surface', () => {
    // The load-bearing case. Without a surface every field is unnamed, and a view
    // that rendered the join anyway would report the app's entire schema as dead —
    // a confident, wrong finding on every app pushed before the CLI carried this.
    const view = deriveFieldCoverage({ model: MODEL, outputSurface: null });
    expect(view.available).toBe(false);
    expect(view.entities).toEqual([]);
    expect(view.declared).toBe(0);
    // And with no model at all — a vertical that emits none — the same answer.
    expect(deriveFieldCoverage({ model: null, outputSurface: SURFACE }).available).toBe(false);
  });

  it('leads with the entities that have something to act on', () => {
    const view = deriveFieldCoverage({
      model: MODEL,
      outputSurface: [{ operationId: 'get-contact', fields: ['id', 'subject'] }],
    });
    // contact has 2 unreturned (email, display_name, legacy_note → 3) vs ticket 1.
    expect(view.entities[0]!.entity).toBe('contact');
    expect(view.entities[0]!.neverReturned.length).toBeGreaterThan(
      view.entities[1]!.neverReturned.length,
    );
  });
});
