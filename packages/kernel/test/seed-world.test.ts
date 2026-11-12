import { describe, expect, it } from 'vitest';
import { principalId, scopeId, type PrincipalId } from '@substrat-run/contracts';
import { personaPrincipal, seatWorldWith, type SeedWorld, type WorldSeating } from '../src/seed-world.js';

/**
 * #3108: a deployed preview seats its personas through its own directory, and every push binds a
 * new script whose directory starts empty while the scope's data is carried. Seating again into
 * the emptied directory must hand each persona the principal it had, or it loses what it built.
 */
const SCOPE = scopeId.parse('01JZ0000000000000000SCP001');
const WORLD: SeedWorld = {
  personas: [
    { sub: 'dev|anna', name: 'Anna', email: 'anna@example.test', role: 'admin' },
    { sub: 'dev|eve', name: 'Eve', email: 'eve@example.test', elsewhere: true },
    { sub: 'dev|ivan', name: 'Ivan', email: 'ivan@example.test', invited: true },
  ],
};

/** A directory a push can empty, recording what each seating seated. */
const deployment = () => {
  let links = new Map<string, PrincipalId>();
  const seated: Array<[string, PrincipalId]> = [];
  const seating: WorldSeating = {
    resolve: async (sub) => links.get(sub) ?? null,
    principalFor: (sub) => personaPrincipal(SCOPE, sub),
    seat: async (persona, principal) => {
      seated.push([persona.sub, principal]);
      links.set(persona.sub, principal);
    },
    grantShape: async () => undefined,
    invoke: async () => undefined as never,
  };
  return { seating, seated, push: () => (links = new Map()) };
};

describe('seatWorldWith (#3108)', () => {
  it('seats a persona as the same principal after a push empties the directory, and only the home cast it seats', async () => {
    const d = deployment();
    const first = await seatWorldWith(d.seating, { world: WORLD });
    await seatWorldWith(d.seating, { world: WORLD }); // linked already: nothing seated again
    d.push();
    const second = await seatWorldWith(d.seating, { world: WORLD });

    const anna = first.get('dev|anna')!.principal;
    expect(principalId.parse(anna)).toBe(anna);
    expect(second.get('dev|anna')!.principal).toBe(anna);
    expect(d.seated).toEqual([['dev|anna', anna], ['dev|anna', anna]]);
    expect([...first.keys()]).toEqual(['dev|anna']);
    // Another scope's persona of the same `sub` is someone else.
    expect(await personaPrincipal(scopeId.parse('01JZ0000000000000000SCP002'), 'dev|anna')).not.toBe(anna);
  });
});
