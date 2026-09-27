/**
 * `@substrat-run/adapter-sqlite/testing` resolves through the package's own `exports` map
 * (#1770) — proven the way a CONSUMER reaches it, by package specifier rather than a file path,
 * from both an ESM import (what a vitest `setupFiles` entry does) and a CJS `require` (the shape
 * `tools/vitest/like-pattern-limit.cjs` needs: a `--require` target must be CJS, Node 22
 * `require`s an ES module — the same precedent `sql-limits.cjs` relies on for the kernel's dist).
 *
 * Self-referencing a package by its own name resolves through the SAME `exports` map algorithm
 * an external consumer's resolver runs, so this is not weaker evidence than a separate package
 * importing it — `packages/template-check` (materialized from the scaffold template, #878) is
 * that separate consumer, and its `test/setup.ts` imports this same subpath by ESM for real.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

describe('the published testing helper resolves through the exports map (#1770)', () => {
  it('via ESM import, by package specifier', async () => {
    const mod = await import('@substrat-run/adapter-sqlite/testing');
    expect(mod.LIKE_PATTERN_LIMIT).toBe(50);
    expect(typeof mod.liftLimit).toBe('function');
  });

  it('via CJS require, by package specifier', () => {
    const mod = createRequire(import.meta.url)('@substrat-run/adapter-sqlite/testing') as {
      LIKE_PATTERN_LIMIT: number;
      liftLimit: unknown;
    };
    expect(mod.LIKE_PATTERN_LIMIT).toBe(50);
    expect(typeof mod.liftLimit).toBe('function');
  });
});
