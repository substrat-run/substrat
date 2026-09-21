/**
 * The node suites see the LIKE/GLOB pattern limit a Durable Object enforces (#1655).
 *
 * workerd's SQLite refuses a pattern over 50 bytes — `LIKE or GLOB pattern too complex` —
 * where stock SQLite allows 50 000, so a 92-byte GLOB ran in every node suite and failed
 * every hosted call (#1646). `better-sqlite3` exposes no `sqlite3_limit`, so
 * `tools/vitest/like-pattern-limit.cjs` reproduces the limit by overriding `like()` and
 * `glob()` on each connection. The root `test` script and CI `--require` it, so it is on
 * for every suite; this file requires it itself so that it holds when run alone, and
 * proves three things:
 *
 *  1. the boundary sits where the Durable Object's does — 50 bytes pass, 51 fail — for
 *     LIKE, GLOB and LIKE … ESCAPE, counted in UTF-8 BYTES rather than characters;
 *  2. the override changes nothing else: matching stays SQLite's own (case folding,
 *     wildcards, ESCAPE, NULL);
 *  3. it reaches the connection the ADAPTER opens — a module's `ctx.sql` — and not only
 *     one a test opens by hand, since that is the path module code takes.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moduleManifest, permissionKey, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { assertAllowed, ulid, type OperationHandler } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

const { LIMIT, liftLimit } = createRequire(import.meta.url)('../../../tools/vitest/like-pattern-limit.cjs') as {
  LIMIT: number;
  liftLimit: (db: Database.Database) => Database.Database;
};

const TOO_COMPLEX = /LIKE or GLOB pattern too complex/;

/** A pattern of exactly `n` bytes: `%` at each end, `a` between. */
const pattern = (n: number): string => `%${'a'.repeat(n - 2)}%`;

const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe('a connection refuses a LIKE/GLOB pattern over the Durable Object limit (#1655)', () => {
  const db = new Database(':memory:');
  afterAll(() => db.close());

  const run = (sql: string, ...params: unknown[]) => db.prepare(sql).pluck().get(...params);

  it('the limit is the Durable Object’s 50 bytes', () => {
    expect(LIMIT).toBe(50);
  });

  it('LIKE: a 50-byte pattern runs, a 51-byte one is refused', () => {
    expect(bytes(pattern(50))).toBe(50);
    expect(run('SELECT ? LIKE ?', 'xaax', pattern(50))).toBe(0);
    expect(run('SELECT ? LIKE ?', `x${'a'.repeat(48)}x`, pattern(50))).toBe(1);
    expect(() => run('SELECT ? LIKE ?', 'x', pattern(51))).toThrow(TOO_COMPLEX);
  });

  it('GLOB: a 50-byte pattern runs, a 51-byte one is refused', () => {
    const glob = (n: number) => `*${'a'.repeat(n - 2)}*`;
    expect(run('SELECT ? GLOB ?', `x${'a'.repeat(48)}x`, glob(50))).toBe(1);
    expect(() => run('SELECT ? GLOB ?', 'x', glob(51))).toThrow(TOO_COMPLEX);
  });

  it('LIKE … ESCAPE is held to the same limit', () => {
    expect(run(`SELECT ? LIKE ? ESCAPE '\\'`, `x${'a'.repeat(48)}x`, pattern(50))).toBe(1);
    expect(() => run(`SELECT ? LIKE ? ESCAPE '\\'`, 'x', pattern(51))).toThrow(TOO_COMPLEX);
  });

  it('counts bytes, not characters: 25 two-byte characters are 50, 26 are not', () => {
    const wide = (chars: number) => 'é'.repeat(chars);
    expect(bytes(wide(25))).toBe(50);
    expect(run('SELECT ? LIKE ?', wide(25), wide(25))).toBe(1);
    expect(() => run('SELECT ? LIKE ?', 'x', wide(26))).toThrow(TOO_COMPLEX);
  });

  it('a pattern written as a literal in the SQL is held to it as a bound one is', () => {
    expect(() => run(`SELECT 'x' LIKE '${pattern(51)}'`)).toThrow(TOO_COMPLEX);
    expect(run(`SELECT 'x' LIKE '${pattern(50)}'`)).toBe(0);
  });

  it('a limit on the pattern is not a limit on the subject: a long value is matched', () => {
    expect(run('SELECT ? LIKE ?', 'a'.repeat(5000), '%a')).toBe(1);
  });

  it('leaves the matching itself SQLite’s own', () => {
    expect(run(`SELECT 'abcAbc' LIKE 'ABC%'`)).toBe(1); // LIKE folds ASCII case
    expect(run(`SELECT 'abcAbc' GLOB 'ABC*'`)).toBe(0); // GLOB does not
    expect(run(`SELECT 'a_c' LIKE 'a\\_c' ESCAPE '\\'`)).toBe(1);
    expect(run(`SELECT 'abc' LIKE 'a\\_c' ESCAPE '\\'`)).toBe(0);
    expect(run(`SELECT 'abc' LIKE 'a_c'`)).toBe(1);
    expect(run(`SELECT 'abc' GLOB 'a[a-c]c'`)).toBe(1);
    expect(run(`SELECT NULL LIKE 'a'`)).toBeNull();
    expect(run(`SELECT 'a' LIKE NULL`)).toBeNull();
    expect(run(`SELECT 'a' GLOB NULL`)).toBeNull();
  });

  it('liftLimit takes it off one connection and leaves the next one alone', () => {
    const lifted = liftLimit(new Database(':memory:'));
    try {
      expect(lifted.prepare('SELECT ? LIKE ?').pluck().get('x', pattern(60))).toBe(0);
      expect(lifted.prepare('SELECT ? GLOB ?').pluck().get('x', `*${'a'.repeat(58)}*`)).toBe(0);
    } finally {
      lifted.close();
    }
    expect(() => run('SELECT ? LIKE ?', 'x', pattern(51))).toThrow(TOO_COMPLEX);
  });
});

describe('the connection the adapter opens for a scope carries the limit too (#1655)', () => {
  const PAT_RUN = permissionKey.parse('pat:run');
  const patMod = {
    manifest: moduleManifest.parse({
      id: '@test/pat',
      version: '1.0.0',
      kernelContract: '^0.0.1',
      permissions: [{ key: 'pat:run', description: 'run a pattern' }],
      events: { emits: [], consumes: [] },
      migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
      attachmentTargets: [],
      entitlementKey: 'pat',
    }),
    operations: {
      'pat/like': (async (ctx, input: { pattern: string }) => {
        assertAllowed(await ctx.check(PAT_RUN));
        return ctx.sql.query('SELECT ? LIKE ? AS hit', ['x', input.pattern]);
      }) as OperationHandler<never, unknown>,
      'pat/glob': (async (ctx, input: { pattern: string }) => {
        assertAllowed(await ctx.check(PAT_RUN));
        return ctx.sql.query('SELECT ? GLOB ? AS hit', ['x', input.pattern]);
      }) as OperationHandler<never, unknown>,
    },
  };

  const dir = mkdtempSync(join(tmpdir(), 'substrat-like-limit-'));
  const host = new SqliteScopeHost({ dir });
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const p = principalId.parse(ulid());

  beforeAll(async () => {
    host.registerModule(patMod);
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'pat');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'pat' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, { key: 'runner', permissions: [PAT_RUN], source: 'vertical' });
    await host.admin.assignRole(staff, {
      principalId: p,
      roleKey: 'runner',
      node: { tenantId: t, scopeId: s },
    });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a module’s ctx.sql runs a 50-byte pattern and is refused a 51-byte one', async () => {
    const stub = await host.getScope(p, t, s);
    await expect(stub.invoke('pat/like', { pattern: pattern(50) })).resolves.toEqual([{ hit: 0 }]);
    await expect(stub.invoke('pat/glob', { pattern: `*${'a'.repeat(48)}*` })).resolves.toEqual([{ hit: 0 }]);
    await expect(stub.invoke('pat/like', { pattern: pattern(51) })).rejects.toThrow(TOO_COMPLEX);
    await expect(stub.invoke('pat/glob', { pattern: `*${'a'.repeat(49)}*` })).rejects.toThrow(TOO_COMPLEX);
  });
});
