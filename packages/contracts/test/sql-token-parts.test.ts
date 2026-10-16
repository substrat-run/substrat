import { describe, expect, it } from 'vitest';
import { tokenizeSql } from '../src/index.js';

/**
 * #115 r6: `text` joins a qualified name's parts with `.`, so `main.n` and `"main.n"` read alike.
 * `parts` keeps them apart: a schema and a name, or ONE identifier that holds a dot.
 */
describe('SqlToken.parts', () => {
  const partsOf = (sql: string) => tokenizeSql(sql).map((t) => t.parts);

  it('splits a qualified name, however it is quoted or spaced', () => {
    for (const spelling of ['main.n', '"main"."n"', '[main].[n]', '`main`.`n`', 'main /* c */ . n']) {
      expect(partsOf(`DROP TABLE ${spelling}`)[2]).toEqual(['main', 'n']);
    }
  });

  it('keeps a quoted identifier holding a dot whole', () => {
    for (const spelling of ['"main.n"', '[main.n]', '`main.n`']) {
      const [, , name] = tokenizeSql(`DROP TABLE ${spelling}`);
      expect(name).toMatchObject({ text: 'main.n', parts: ['main.n'] });
    }
  });

  it('a plain word is one part; punctuation has none', () => {
    const tokens = tokenizeSql('DROP TABLE n;', { punctuation: true });
    expect(tokens.map((t) => t.parts)).toEqual([['DROP'], ['TABLE'], ['n'], undefined]);
  });
});
