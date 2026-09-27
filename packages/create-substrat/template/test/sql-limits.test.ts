import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// Proves the WIRING, not just the helper: test/setup.ts (vitest.config.ts's setupFiles) is what
// makes a pattern over 50 bytes throw here, the same way it throws on a Durable Object. If
// setupFiles is ever removed, or setup.ts stops importing the helper, this suite must fail
// loudly rather than quietly accept a pattern deployed production would refuse.
describe('the 50-byte LIKE/GLOB pattern limit is on by default', () => {
  it('test/setup.ts ran — the marker it derived from the real helper is present', () => {
    expect(globalThis.__substratLikeLimitSetup).toBe(50);
  });

  it('a 51-byte pattern is refused, the same message a Durable Object gives', () => {
    const db = new Database(':memory:');
    const pattern = `%${'a'.repeat(49)}%`; // 51 bytes
    try {
      expect(() => db.prepare('SELECT ? LIKE ?').pluck().get('x', pattern)).toThrow(
        /LIKE or GLOB pattern too complex/,
      );
    } finally {
      db.close();
    }
  });

  it('the passing twin: a 50-byte pattern still runs', () => {
    const db = new Database(':memory:');
    const pattern = `%${'a'.repeat(48)}%`; // 50 bytes
    try {
      expect(db.prepare('SELECT ? LIKE ?').pluck().get(`x${'a'.repeat(48)}x`, pattern)).toBe(1);
    } finally {
      db.close();
    }
  });
});
