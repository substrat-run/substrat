import { describe, expect, it } from 'vitest';
import { parseOrgnr } from '../src/orgnr.js';

// Placeholder numbers, Luhn-valid by construction; `811218-9876` is Skatteverket's own
// published example of a personnummer, not a person.
describe('parseOrgnr', () => {
  it.each([
    ['5560000001', '5560000001'],
    ['556000-0001', '5560000001'],
    ['  556000-0001 ', '5560000001'],
    ['165560000001', '5560000001'],
    ['16556000-0001', '5560000001'],
  ])('reads %j as %s', (input, canonical) => {
    expect(parseOrgnr(input)).toEqual({ ok: true, orgnr: canonical });
  });

  it.each([
    ['556000-001', 'format'],
    ['55600O0001', 'format'],
    ['5560000001-', 'format'],
    ['175560000001', 'format'],
    ['5560000002', 'checksum'],
    ['811218-9876', 'personnummer'],
    ['198112189876', 'personnummer'],
    ['205560000001', 'personnummer'],
  ])('refuses %j (%s)', (input, reason) => {
    expect(parseOrgnr(input)).toEqual({ ok: false, reason });
  });
});
