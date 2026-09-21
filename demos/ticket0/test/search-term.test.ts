/**
 * The inbox box's ceiling on a search term (#1655) — the app's restatement of the bound
 * `searchTerm` enforces, held to the model and to the numbers `test/workerd/sweeper.test.ts`
 * pins against a real Durable Object. Each claim is driven from both sides of the limit.
 */
import { describe, expect, it } from 'vitest';
import { LIKE_PATTERN_MAX_BYTES, likeTerm, searchTerm } from '../spec/model.js';
import { LIKE_PATTERN_MAX_BYTES as APP_MAX, searchTermBytes, searchTermFits } from '../app/src/search.js';

const AT_THE_LIMIT = {
  ascii: 'limit-'.padEnd(48, 'x'),
  'two-byte letters': 'å'.repeat(24),
  'escaped wildcards': '%'.repeat(24),
} as const;
const ONE_OVER = {
  ascii: `${AT_THE_LIMIT.ascii}x`,
  'two-byte letters': `${AT_THE_LIMIT['two-byte letters']}å`,
  'escaped wildcards': `${AT_THE_LIMIT['escaped wildcards']}%`,
} as const;

describe('the app search ceiling', () => {
  it('restates the model bound', () => {
    expect(APP_MAX).toBe(LIKE_PATTERN_MAX_BYTES);
  });

  for (const kind of Object.keys(AT_THE_LIMIT) as (keyof typeof AT_THE_LIMIT)[]) {
    it(`${kind}: 50 bytes of pattern fits, one character more does not`, () => {
      expect(searchTermBytes(AT_THE_LIMIT[kind])).toBe(50);
      expect(searchTermFits(AT_THE_LIMIT[kind])).toBe(true);
      expect(searchTermBytes(ONE_OVER[kind])).toBeGreaterThan(50);
      expect(searchTermFits(ONE_OVER[kind])).toBe(false);
    });

    it(`${kind}: agrees with the server's own verdict`, () => {
      for (const t of [AT_THE_LIMIT[kind], ONE_OVER[kind]]) {
        expect(searchTermBytes(t)).toBe(new TextEncoder().encode(likeTerm(t)).length);
        expect(searchTermFits(t)).toBe(searchTerm.safeParse(t).success);
      }
    });
  }

  it('counts bytes, not characters', () => {
    expect(AT_THE_LIMIT['two-byte letters'].length).toBe(24);
    expect(searchTermBytes('å')).toBe(4);
  });
});
