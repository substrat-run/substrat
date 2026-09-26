/**
 * Contract suite for the SQL limits a Durable Object enforces on `ctx.sql` (#1741).
 *
 * One sentence: **a statement over a hosted limit is refused, with the hosted message, by
 * BOTH adapters — and a statement at exactly the limit is not.**
 *
 * The limits are `DO_SQL_LIMITS` in the kernel, measured against a real Durable Object by
 * `packages/adapter-cloudflare/test/do-sql-limits.test.ts`. This suite is the parity half:
 * the pure host enforces them itself (`guardSqlLimits`, wrapped around `ctx.sql`), the DO
 * host gets them from its own SQLite, and a vertical is written against the first and
 * deployed onto the second. So each case pairs a refusal with its at-the-limit twin, and the
 * refusal is matched against the DO's exact message. A guard that refused everything fails
 * the twins; one that refused nothing fails the refusals.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { DO_SQL_LIMITS, ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { testMod } from './modules.js';

const { compoundTerms, boundParameters, statementBytes, columns } = DO_SQL_LIMITS;

/** `SELECT 0, 1, …` — a result set `n` columns wide. */
const selectColumns = (n: number): string => `SELECT ${Array.from({ length: n }, (_, i) => i).join(', ')}`;

const compound = (terms: number, op = 'UNION ALL'): string =>
  Array.from({ length: terms }, (_, i) => `SELECT ${i}`).join(` ${op} `);
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
/** `SELECT '<a…>'`, exactly `bytes` bytes long. */
const selectOfLength = (bytes: number): string => `SELECT '${'a'.repeat(bytes - "SELECT ''".length)}'`;

interface Case {
  readonly name: string;
  readonly sql: string;
  readonly params?: number[];
  /** The exact refusal, or undefined when the statement must run. */
  readonly refusal?: string;
}

const cases: Case[] = [
  // -- columns in a result set (#1811) ---------------------------------------
  { name: `${columns} result columns`, sql: selectColumns(columns) },
  {
    name: `${columns + 1} result columns`,
    sql: selectColumns(columns + 1),
    refusal: 'too many columns in result set: SQLITE_ERROR',
  },
  // -- compound SELECT terms -------------------------------------------------
  { name: `${compoundTerms} UNION ALL terms`, sql: compound(compoundTerms) },
  {
    name: `${compoundTerms + 1} UNION ALL terms`,
    sql: compound(compoundTerms + 1),
    refusal: 'too many terms in compound SELECT: SQLITE_ERROR',
  },
  { name: `${compoundTerms} UNION terms`, sql: compound(compoundTerms, 'UNION') },
  {
    name: `${compoundTerms + 1} UNION terms`,
    sql: compound(compoundTerms + 1, 'UNION'),
    refusal: 'too many terms in compound SELECT: SQLITE_ERROR',
  },
  {
    name: `${compoundTerms + 1} INTERSECT terms`,
    sql: compound(compoundTerms + 1, 'INTERSECT'),
    refusal: 'too many terms in compound SELECT: SQLITE_ERROR',
  },
  {
    name: `${compoundTerms + 1} EXCEPT terms`,
    sql: compound(compoundTerms + 1, 'EXCEPT'),
    refusal: 'too many terms in compound SELECT: SQLITE_ERROR',
  },
  // A subquery starts its own compound: two chains at the limit are fine, one over is not.
  {
    name: 'two subqueries of exactly the limit, in one statement',
    sql: `SELECT * FROM (${compound(compoundTerms)}) UNION ALL SELECT * FROM (${compound(compoundTerms)})`,
  },
  {
    name: 'a CTE body over the limit',
    sql: `WITH c AS (${compound(compoundTerms + 1)}) SELECT * FROM c`,
    refusal: 'too many terms in compound SELECT: SQLITE_ERROR',
  },
  {
    // The measured exemption: VALUES rows are not compound terms. Shipping this as a refusal
    // would push verticals off the one form that batches an insert.
    name: `a ${compoundTerms * 100}-row VALUES list`,
    sql: `SELECT * FROM (VALUES ${Array.from({ length: compoundTerms * 100 }, () => '(1)').join(', ')})`,
  },
  {
    name: 'the word UNION inside a string and a comment',
    sql: `SELECT 'a UNION ALL b UNION ALL c UNION ALL d UNION ALL e UNION ALL f' /* UNION UNION UNION UNION UNION UNION */`,
  },

  // -- bound parameters ------------------------------------------------------
  {
    name: `${boundParameters} bound parameters`,
    sql: `SELECT 1 WHERE 1 IN (${marks(boundParameters)})`,
    params: Array(boundParameters).fill(1),
  },
  {
    name: `${boundParameters + 1} bound parameters`,
    sql: `SELECT 1 WHERE 1 IN (${marks(boundParameters + 1)})`,
    params: Array(boundParameters + 1).fill(1),
    // The offset is SQLite's own: the byte where the 101st `?` starts, after 100 of `?, `.
    refusal: `too many SQL variables at offset ${'SELECT 1 WHERE 1 IN ('.length + '?, '.length * boundParameters}: SQLITE_ERROR`,
  },
  {
    name: `?${boundParameters + 1} (numbered)`,
    sql: `SELECT ?${boundParameters + 1}`,
    params: Array(boundParameters + 1).fill(1),
    refusal: `variable number must be between ?1 and ?${boundParameters} at offset 7: SQLITE_ERROR`,
  },
  {
    name: 'a question mark inside a string is not a parameter',
    sql: `SELECT '${'?'.repeat(boundParameters + 50)}'`,
  },

  // -- statement length ------------------------------------------------------
  { name: `a statement of exactly ${statementBytes} bytes`, sql: selectOfLength(statementBytes) },
  {
    name: `a statement of ${statementBytes + 1} bytes`,
    sql: selectOfLength(statementBytes + 1),
    refusal: 'statement too long: SQLITE_TOOBIG',
  },
  {
    // Counted in UTF-8 bytes: 50 001 two-byte characters are 100 002 bytes in 50 010 characters.
    name: 'a statement over the limit in bytes but under it in characters',
    sql: `SELECT '${'é'.repeat(statementBytes / 2)}'`,
    refusal: 'statement too long: SQLITE_TOOBIG',
  },
];

export function sqlLimitsContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`SQL limits (ctx.sql): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    let stub: ScopeStub;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(testMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'sql-limits', name: 'SQL limits' });
      await host.admin.grantEntitlement(staff, t1, 'testmod');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'sql-limits' });
      await host.admin.activateScope(staff, t1, s1);
      stub = await host.getScope(alice, t1, s1);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    for (const c of cases) {
      for (const door of ['sql-query', 'sql-exec'] as const) {
        if (door === 'sql-exec' && !/^SELECT|^WITH/.test(c.sql)) continue;
        it(`${c.refusal ? 'refuses' : 'runs'} ${c.name} (${door})`, async () => {
          const run = stub.invoke(`testmod/${door}`, { sql: c.sql, params: c.params ?? [] });
          if (c.refusal === undefined) {
            await expect(run).resolves.not.toBeUndefined();
          } else {
            // The hosted message is the whole contract: match it exactly, not by prefix.
            await expect(run).rejects.toThrow(new RegExp(`^${c.refusal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
          }
        });
      }
    }

    it('refuses without taking the scope down — the next statement still runs', async () => {
      await expect(stub.invoke('testmod/sql-query', { sql: compound(compoundTerms + 1) })).rejects.toThrow();
      await expect(stub.invoke('testmod/sql-query', { sql: 'SELECT 1 AS ok' })).resolves.toEqual([{ ok: 1 }]);
    });
  });
}
