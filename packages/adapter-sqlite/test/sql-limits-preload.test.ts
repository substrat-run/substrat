import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// #1786: `tools/vitest/sql-limits.cjs` judges ALL node SQL, platform included. Only meaningful
// when the suite runs the way CI does (NODE_OPTIONS carries the preload), so a bare run skips.
const preloaded = Boolean((Database.prototype as { __sqlLimits?: boolean }).__sqlLimits);

describe.skipIf(!preloaded)('sql-limits preload (#1786)', () => {
  const db = new Database(':memory:');
  const inList = (n: number) => `SELECT 1 WHERE 1 IN (${Array(n).fill('?').join(',')})`;

  it('refuses a prepare over 100 bound parameters, as a Durable Object does', () => {
    expect(() => db.prepare(inList(101))).toThrow(/too many SQL variables/);
  });

  it('accepts one at the limit', () => {
    expect(() => db.prepare(inList(100))).not.toThrow();
  });

  it('judges exec too', () => {
    expect(() => db.exec('SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6')).toThrow(
      /too many terms in compound SELECT/,
    );
  });
});
