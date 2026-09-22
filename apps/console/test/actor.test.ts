import { describe, expect, it } from 'vitest';
import type { Actor } from '@substrat-run/contracts';
import { actorFilter, actorKind, actorLabel } from '../src/lib/actor';

/**
 * The denial log's actor column (#867), for every member of the union — including the
 * one #1672 added, which used to fall through to the connection branch and read as a
 * connector named `undefined`.
 */
const cases: [Actor, ReturnType<typeof actorKind>, string][] = [
  ['01J000000000000000000PRINC' as Actor, 'principal', '01J000000000000000000PRINC'],
  [{ system: '@acme/billing' } as Actor, 'system', '@acme/billing'],
  [{ connection: '01J00000000000000000000CON' } as Actor, 'connection', '01J00000000000000000000CON'],
  [{ capability: '01J00000000000000000000CAP' } as Actor, 'capability', '01J00000000000000000000CAP'],
];

describe('the denial log names every kind of actor as what it is', () => {
  for (const [actor, kind, label] of cases) {
    it(`${kind}`, () => {
      expect(actorKind(actor)).toBe(kind);
      expect(actorLabel(actor)).toBe(label);
      expect(actorLabel(actor)).not.toBe('undefined');
    });
  }

  it('filters by the logical actor — a bare principal, or the object form as JSON', () => {
    expect(actorFilter('01J000000000000000000PRINC' as Actor)).toBe('01J000000000000000000PRINC');
    expect(actorFilter({ capability: '01J00000000000000000000CAP' } as Actor)).toBe(
      '{"capability":"01J00000000000000000000CAP"}',
    );
  });
});
