/**
 * `@substrat-run/adapter-sqlite/testing` resolves through the package's own `exports` map
 * (#1770) — proven the way a CONSUMER reaches it, by package specifier rather than a file path,
 * from both an ESM import (what a vitest `setupFiles` entry does) and a CJS `require` (the shape
 * `tools/vitest/like-pattern-limit.cjs` needs). The subpath resolves `testing.cjs`, plain
 * hand-written CommonJS that ships uncompiled — Node reads a `.cjs` file as CommonJS either way,
 * `import`ed or `require`d, so one file answers both.
 *
 * Self-referencing a package by its own name resolves through the SAME `exports` map algorithm
 * an external consumer's resolver runs, so this is not weaker evidence than a separate package
 * importing it — `packages/template-check` (materialized from the scaffold template, #878) is
 * that separate consumer, and its `test/setup.ts` imports this same subpath by ESM for real.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DO_SQL_LIMITS } from '@substrat-run/kernel';

describe('the published testing helper resolves through the exports map (#1770)', () => {
  it('via ESM import, by package specifier', async () => {
    const mod = await import('@substrat-run/adapter-sqlite/testing');
    expect(mod.LIKE_PATTERN_LIMIT).toBe(DO_SQL_LIMITS.likePatternBytes);
    expect(typeof mod.liftLimit).toBe('function');
  });

  it('via CJS require, by package specifier', () => {
    const mod = createRequire(import.meta.url)('@substrat-run/adapter-sqlite/testing') as {
      LIKE_PATTERN_LIMIT: number;
      liftLimit: unknown;
    };
    expect(mod.LIKE_PATTERN_LIMIT).toBe(DO_SQL_LIMITS.likePatternBytes);
    expect(typeof mod.liftLimit).toBe('function');
  });

  it('is excluded from a worker/browser bundle — the same shape as ./vertical-broker', () => {
    const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      exports: Record<string, Record<string, unknown>>;
    };
    for (const subpath of ['./testing', './vertical-broker']) {
      const entry = pkg.exports[subpath];
      expect(entry, `${subpath} exports entry`).toBeDefined();
      expect(entry!.workerd, `${subpath}.workerd`).toBeNull();
      expect(entry!.worker, `${subpath}.worker`).toBeNull();
      expect(entry!.browser, `${subpath}.browser`).toBeNull();
    }
    expect(pkg.exports['./testing']!.default).toBe('./testing.cjs');
    expect(pkg.exports['./testing']!.types).toBe('./testing.d.cts');
  });
});
