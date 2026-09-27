/**
 * #1743 on the pure adapter: a tenant-level `grantToSystem` reads the switch record and
 * writes the tenant tuple as ONE unit, so a scope switched off concurrently cannot slip in
 * between them.
 *
 * Why this pins the unit rather than injecting an OFF into the gap, as the Cloudflare test
 * does: there is no gap to inject into. `better-sqlite3` is synchronous on the directory's
 * one connection, and an OFF's record write (`switchSystem`) runs only after its own awaits
 * (the scope actor's turn). So an OFF can land between the check and the write only if an
 * `await` separates them. What makes that impossible is the shape of the code: both
 * statements run inside one directory transaction, in one synchronous run with no microtask
 * turn in between. That shape is what this asserts, statement by statement. Splitting the
 * check from the write, whether by an await or by a separate transaction, turns it red.
 *
 * ADAPTER-SPECIFIC, like `job-store-turn.test.ts`: the property is about one shared
 * `better-sqlite3` connection, and the Durable Object has its own proof
 * (`adapter-cloudflare/test/contract.test.ts`, "#1743 — an OFF landing between…").
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moduleId, permissionKey, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { scheduleMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

describe('a tenant-level grantToSystem checks and writes in one directory unit (#1743)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-tenant-grant-'));
  const host = new SqliteScopeHost({ dir });
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');
  const directory = (host as unknown as { directory: Database.Database }).directory;

  /** Each statement the grant runs against the directory, as it runs. */
  type Seen = { kind: 'check' | 'write'; inTransaction: boolean; ticked: boolean };
  let seen: Seen[] = [];
  /** Flips on the first microtask after the check: set means an await could have run in between. */
  let ticked = false;
  const kindOf = (sql: string): Seen['kind'] | null =>
    /FROM _substrat_system_switches/.test(sql) && /module_id = \?/.test(sql) && /position = 'off'/.test(sql)
      ? 'check'
      : /INTO _substrat_tenant_tuples/.test(sql)
        ? 'write'
        : null;

  const grant = (key: string) =>
    host.admin.grantToSystem(staff, {
      moduleId: SCHED,
      permission: permissionKey.parse(key),
      node: { tenantId: t, scopeId: null },
      grantedBy: staff,
    });

  beforeAll(async () => {
    host.registerModule(scheduleMod);
    await host.admin.createTenant(staff, { id: t, slug: `unit-${t.slice(-10).toLowerCase()}`, name: 'Unit' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    await host.admin.activateScope(staff, t, s);
    // Record every statement the directory runs, with whether a transaction is open and
    // whether a microtask has run since the check.
    const prepare = directory.prepare.bind(directory);
    directory.prepare = ((sql: string) => {
      const stmt = prepare(sql);
      const kind = kindOf(sql);
      if (!kind) return stmt;
      return new Proxy(stmt, {
        get: (target, prop) => {
          const v = Reflect.get(target, prop);
          if (typeof v !== 'function' || !['run', 'all', 'get'].includes(String(prop))) return v;
          return (...args: unknown[]) => {
            if (kind === 'check') {
              ticked = false;
              queueMicrotask(() => {
                ticked = true;
              });
            }
            seen.push({ kind, inTransaction: directory.inTransaction, ticked });
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    }) as typeof directory.prepare;
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('an accepted grant: the check, then the write, inside one transaction with no turn between', async () => {
    seen = [];
    await grant('sched:admin');
    expect(seen).toEqual([
      { kind: 'check', inTransaction: true, ticked: false },
      { kind: 'write', inTransaction: true, ticked: false },
    ]);
  });

  it('twin: a refused grant runs the check in the transaction and never reaches the write', async () => {
    await host.admin.revokeFromSystem(staff, { moduleId: SCHED, node: { tenantId: t, scopeId: s }, reason: 'incident' });
    seen = [];
    await expect(grant('sched:tick')).rejects.toThrow(/switched off on scope/);
    expect(seen).toEqual([{ kind: 'check', inTransaction: true, ticked: false }]);
  });
});
