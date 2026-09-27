/**
 * Regression test for a dual-module-instance hazard (#1770 review, round 2): vitest's own SSR
 * module loader "inlines" a workspace file like `testing.cjs` — evaluates it in its OWN
 * transform pipeline for a dynamic `import()` — while `createRequire(...)('../testing.cjs')`
 * bypasses that pipeline entirely and goes through Node's NATIVE `require`. Node's module cache
 * (keyed by resolved path) does NOT save this: the two loaders keep separate registries, so the
 * SAME file is evaluated TWICE, each with its own closure — confirmed below by asserting the
 * two `liftLimit` exports are not the same function. `better-sqlite3` itself is an external
 * dependency, not something vitest inlines, so both evaluations resolve the SAME native
 * `Database` class and therefore the SAME `Database.prototype` — which is what makes the
 * `Symbol.for` registry on that shared prototype the fix, rather than Node's module cache: a
 * plain `WeakSet` scoped to each evaluation's own closure would desync, exactly as it did before
 * this fix (verified by swapping the registry for a local `WeakSet` and watching this go red).
 */
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

type TestingModule = { liftLimit: (db: Database.Database) => Database.Database };

describe('liftLimit is visible across two module instances of testing.cjs (#1770 review)', () => {
  it('lifted via the non-active instance, prepare (driven by the active one) still honors it', async () => {
    const imported = (await import('../testing.cjs')) as unknown as { default?: TestingModule } & TestingModule;
    const a: TestingModule = imported.default ?? imported;
    const b = createRequire(import.meta.url)('../testing.cjs') as TestingModule;

    // Precondition: genuinely two distinct module instances, or the assertion below would pass
    // vacuously even with the old, unshared WeakSet.
    expect(a.liftLimit).not.toBe(b.liftLimit);

    // `a` evaluates first (the `import()` above already ran by the time `createRequire` runs),
    // so `a`'s own prototype patch wins the `__likePatternLimit` guard and becomes what
    // `prepare()` actually dispatches to — meaning `a.liftLimit` is trivially self-consistent
    // with `a`'s own `install()` even WITHOUT a shared registry. `b` is the non-active instance:
    // calling `liftLimit` there and observing `prepare()` (driven by `a`) honor it is what
    // actually exercises the hazard — confirmed by swapping the registry for a local `WeakSet`
    // and watching this go red only with `b.liftLimit`, not `a.liftLimit`.
    const db = new Database(':memory:');
    try {
      b.liftLimit(db);
      expect(db.prepare('SELECT ? LIKE ?').pluck().get('x', `%${'a'.repeat(58)}%`)).toBe(0); // 60 bytes
    } finally {
      db.close();
    }
  });
});
