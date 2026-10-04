import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  errorCodeOf,
  moduleId,
  permissionKey,
  platformActorId,
  scopeId,
  tenantId,
  type ModuleId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { scheduleMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

const SCHED = moduleId.parse('@test/sched');

type Runtime = {
  db: Database.Database;
  actor: { turn<T>(op: () => Promise<T> | T): Promise<T> };
};

/**
 * #1823, gap 2, on the pure host: the window between the scope's switch moving and the
 * directory's record of it. #1743's refusal of a tenant-level `grantToSystem` reads that
 * record, so OFF writes it BEFORE the scope moves — there is no instant at which the scope is
 * off and the record is not.
 *
 * The window is held open deterministically: the test takes the scope actor's turn, so OFF
 * reaches the scope and waits there. A tenant grant issued while it waits must be refused.
 * The Durable-Object adapter has the same test, holding its window at the delegation seam
 * (`adapter-cloudflare/test/contract.test.ts`).
 */
describe('#1823: OFF records before the scope moves — no tenant grant lands in between', () => {
  const setup = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-switch-window-'));
    const host = new SqliteScopeHost({ dir });
    host.registerModule(scheduleMod);
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `window-${t.slice(-10).toLowerCase()}`, name: 'Window' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s });
    await host.admin.activateScope(staff, t, s);
    const runtime = (host as unknown as { runtime(t: TenantId, s: ScopeId): Runtime }).runtime(t, s);
    const node = { tenantId: t, scopeId: s };
    const off = (module: ModuleId = SCHED) => host.admin.revokeFromSystem(staff, { moduleId: module, node, reason: 'incident' });
    const tenantGrant = (key: string, module: ModuleId = SCHED) =>
      host.admin
        .grantToSystem(staff, {
          moduleId: module,
          permission: permissionKey.parse(key),
          node: { tenantId: t, scopeId: null },
          grantedBy: staff,
        })
        .then(() => null, (e: unknown) => e);
    const records = () => host.admin.listSystemSwitches(staff, { scopeId: s });
    /** Take the scope actor's turn and keep it until `release` — OFF's move queues behind it. */
    const holdScope = () => {
      let release!: () => void;
      const held = runtime.actor.turn(() => new Promise<void>((r) => (release = r)));
      return { release: async () => (release(), held) };
    };
    /** Wait (bounded) for OFF to have written its record while the scope is held. */
    const recordWritten = async () => {
      for (let i = 0; i < 50; i++) {
        if ((await records()).some((r) => r.position === 'off')) return true;
        await new Promise((r) => setTimeout(r, 5));
      }
      return false;
    };
    const done = async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { host, t, s, runtime, off, tenantGrant, records, holdScope, recordWritten, done };
  };

  it('a tenant grant issued while OFF waits on the scope is refused, and lands nowhere', async () => {
    const { host, t, s, off, tenantGrant, holdScope, recordWritten, done } = await setup();
    const scope = holdScope();
    const switching = off();
    // The record is written while the scope has not moved yet: that is the window closed.
    expect(await recordWritten()).toBe(true);
    const e = await tenantGrant('sched:tick');
    expect(errorCodeOf(e)).toBe('conflict');
    expect(String(e)).toContain(s);
    await scope.release();
    await switching;
    await expect((await host.getSystemScope(SCHED, t, s)).invoke('sched/tick')).rejects.toThrow(/sched:tick/);
    await done();
  });

  it('twin: an OFF that holds nothing takes its record back, and the grant it held off is then accepted', async () => {
    const { off, tenantGrant, records, done } = await setup();
    const stranger = moduleId.parse('@test/not-held');
    expect(errorCodeOf(await off(stranger).then(() => null, (x: unknown) => x))).toBe('not_found');
    expect(await records()).toEqual([]);
    expect(await tenantGrant('sched:admin', stranger)).toBeNull();
    await done();
  });

  it('an OFF whose scope move throws takes its record back too — and a held OFF before it is kept', async () => {
    const { off, records, runtime, done } = await setup();
    await off();
    const before = await records();
    expect(before).toEqual([expect.objectContaining({ position: 'off' })]);
    // The scope's connection refuses the OFF marker's write, so the repeat OFF throws mid-move.
    const prepare = runtime.db.prepare.bind(runtime.db);
    runtime.db.prepare = ((source: string) => {
      const stmt = prepare(source);
      const run = stmt.run.bind(stmt);
      stmt.run = ((...params: unknown[]) => {
        if (params.includes('switched:sched:tick') || params.includes('switch:off')) {
          throw new Error('the scope refused the switch (test fault)');
        }
        return run(...params);
      }) as typeof stmt.run;
      return stmt;
    }) as typeof runtime.db.prepare;
    // The marker is already live, so make the move fail on its first write: re-grant first.
    runtime.db.exec(`UPDATE _substrat_tuples SET revoked_at = NULL WHERE relation = 'granted:sched:tick'`);
    await expect(off()).rejects.toThrow(/test fault/);
    expect(await records()).toEqual(before);
    await done();
  });
});
