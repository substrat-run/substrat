/**
 * Regression test for a dual-module-instance hazard (#1770 pre-push review): this repo's OWN
 * suite imports `testing.ts` from SOURCE (this file's sibling tests do, transformed on the fly
 * by vitest), while a consumer's `setupFiles` reaches it through the exports map, which
 * resolves the BUILT `dist/testing.js` — two distinct module evaluations of the same logic,
 * each with its own closure, patching the SAME native `Database.prototype`. Only the first one
 * to run wins the `__likePatternLimit` guard and becomes the active `prepare`/`exec` patcher.
 * Before the fix, `liftLimit` marked a connection in ITS OWN module's `seen` WeakSet; if that
 * was not the active instance, the active instance's `install()` never saw the mark and
 * re-limited the connection on its very first `prepare()` — silently, since the connection
 * looked lifted to whichever code called `liftLimit`. `seen` now lives behind a
 * `Symbol.for` key on the shared prototype object, so both instances read and write the same
 * set regardless of which one is active — proven here by driving BOTH named exports.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import * as fromSource from '../src/testing.js';
// The built artifact: a genuinely different file/module instance from `../src/testing.js`,
// the same way a consumer's `@substrat-run/adapter-sqlite/testing` import resolves it.
import * as fromDist from '../dist/testing.js';

const longPattern = (n: number) => `%${'a'.repeat(n - 2)}%`; // n bytes, n > 50 for n > 52

describe('liftLimit is visible across module instances of testing.ts (#1770 review)', () => {
  it('lifted via the source-imported export, prepare (whichever instance is active) still sees it', () => {
    const db = fromSource.liftLimit(new Database(':memory:'));
    try {
      expect(db.prepare('SELECT ? LIKE ?').pluck().get('x', longPattern(60))).toBe(0);
    } finally {
      db.close();
    }
  });

  it('lifted via the dist-imported export, prepare (whichever instance is active) still sees it', () => {
    const db = fromDist.liftLimit(new Database(':memory:'));
    try {
      expect(db.prepare('SELECT ? LIKE ?').pluck().get('x', longPattern(60))).toBe(0);
    } finally {
      db.close();
    }
  });
});
