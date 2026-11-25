import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_CLAIMS_DDL,
  DIRECTORY_CROSSINGS_DDL,
  oneDatabaseDirectoryObjects,
  runCrossing,
  type CrossingLedgerPort,
  type DirectoryClaimsPort,
  type DirectoryObjects,
} from '../src/directory-crossing.js';
import type { SwitchSql } from '../src/system-switch.js';

/**
 * K-68 (directory split), rfc/tenant-scale.md §7.3: a crossing commits its intent, then each step
 * commits in its own object. These run the async path (`runCrossing`) over ports whose every call
 * is its own transaction, on one real SQLite database, with a clock the test moves.
 */
const T0 = Date.parse('2026-11-25T10:00:00.000Z');
const TENANT_A = '01JZ0000000000000000TENA01';
const TENANT_B = '01JZ0000000000000000TENB01';

function world(): { objects: DirectoryObjects; sql: SwitchSql; clock: { t: number } } {
  const db = new DatabaseSync(':memory:');
  db.exec(DIRECTORY_CLAIMS_DDL);
  db.exec(DIRECTORY_CROSSINGS_DDL);
  const sql: SwitchSql = {
    all: (q, ...p) => db.prepare(q).all(...p) as Record<string, unknown>[],
    run: (q, ...p) => {
      db.prepare(q).run(...p);
    },
  };
  const clock = { t: T0 };
  const transaction = <T>(fn: () => T): T => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
  return { objects: oneDatabaseDirectoryObjects(sql, { now: () => clock.t, transaction }), sql, clock };
}

const bind = (crossingId: string, holder: string, leaseMs = 60_000) => ({
  crossingId, kind: 'hostname-bind', namespace: 'hostname' as const, key: 'shop.example.test', holder, scopeId: null, leaseMs,
});

/** Ports that commit the call they wrap, then die: the process crashing between two commits. */
function crashingAfter<T extends object>(port: T, method: keyof T): T {
  return new Proxy(port, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== method || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        throw new Error(`crashed after ${String(prop)}`);
      };
    },
  });
}

describe('directory claims', () => {
  it('a confirmed claim is the holder’s for good; repeating either step answers the same claim', async () => {
    const { objects } = world();
    const registry = objects.registry();
    const first = await registry.claim({ namespace: 'hostname', key: 'a.test', claimId: 'c1', holder: TENANT_A, leaseMs: 1000 });
    expect(first).toMatchObject({ ok: true, claim: { state: 'leased', holder: TENANT_A } });
    expect(await registry.claim({ namespace: 'hostname', key: 'a.test', claimId: 'c1', holder: TENANT_A, leaseMs: 1000 })).toEqual(first);
    expect(await registry.confirmClaim({ namespace: 'hostname', key: 'a.test', claimId: 'c1' })).toMatchObject({ ok: true, claim: { state: 'confirmed', leaseUntil: null } });
    expect(await registry.confirmClaim({ namespace: 'hostname', key: 'a.test', claimId: 'c1' })).toMatchObject({ ok: true });
    expect(await registry.claim({ namespace: 'hostname', key: 'a.test', claimId: 'c2', holder: TENANT_B, leaseMs: 1000 })).toEqual({ ok: false, reason: 'held', holder: TENANT_A });
  });

  it('a lease that ran out is superseded by the next claimant, and its own confirm then refuses', async () => {
    const { objects, clock } = world();
    const registry = objects.registry();
    await registry.claim({ namespace: 'hostname', key: 'a.test', claimId: 'c1', holder: TENANT_A, leaseMs: 1000 });
    expect(await registry.claim({ namespace: 'hostname', key: 'a.test', claimId: 'c2', holder: TENANT_B, leaseMs: 1000 })).toMatchObject({ ok: false, reason: 'held' });
    clock.t += 1000;
    expect(await registry.claim({ namespace: 'hostname', key: 'a.test', claimId: 'c2', holder: TENANT_B, leaseMs: 1000 })).toMatchObject({ ok: true, claim: { holder: TENANT_B } });
    expect(await registry.confirmClaim({ namespace: 'hostname', key: 'a.test', claimId: 'c1' })).toEqual({ ok: false, reason: 'superseded' });
  });

  it('a confirm after the lease ran out refuses and frees the key at once', async () => {
    const { objects, clock } = world();
    const registry = objects.registry();
    await registry.claim({ namespace: 'hostname', key: 'a.test', claimId: 'c1', holder: TENANT_A, leaseMs: 1000 });
    clock.t += 1000;
    expect(await registry.confirmClaim({ namespace: 'hostname', key: 'a.test', claimId: 'c1' })).toEqual({ ok: false, reason: 'expired' });
    expect(await registry.readClaim('hostname', 'a.test')).toBeNull();
  });

  it('a tombstone is never claimed again, and only the holder’s crossing can release a claim', async () => {
    const { objects } = world();
    const registry = objects.registry();
    await registry.claim({ namespace: 'tenant-id', key: TENANT_A, claimId: 'c1', holder: TENANT_A, leaseMs: 1000 });
    await registry.confirmClaim({ namespace: 'tenant-id', key: TENANT_A, claimId: 'c1' });
    expect(await registry.releaseClaim({ namespace: 'tenant-id', key: TENANT_A, claimId: 'other' })).toEqual({ released: false });
    expect(await registry.releaseClaim({ namespace: 'tenant-id', key: TENANT_A, claimId: 'c1', tombstone: true })).toEqual({ released: true });
    expect(await registry.claim({ namespace: 'tenant-id', key: TENANT_A, claimId: 'c9', holder: TENANT_A, leaseMs: 1000 })).toEqual({ ok: false, reason: 'tombstone', holder: TENANT_A });
  });

  it('refuses a namespace it does not know, at the boundary', async () => {
    const { objects } = world();
    await expect(objects.registry().claim({ namespace: 'tenant' as never, key: 'x', claimId: 'c', holder: TENANT_A, leaseMs: 1 })).rejects.toThrow(/not a directory claim namespace/);
  });
});

describe('runCrossing: a crash between two commits leaves an intent a retry finishes', () => {
  const steps: { label: string; crash: (ledger: CrossingLedgerPort, registry: DirectoryClaimsPort) => [CrossingLedgerPort, DirectoryClaimsPort] }[] = [
    { label: 'after the registry claimed', crash: (l, r) => [l, crashingAfter(r, 'claim')] },
    { label: 'after the ledger marked it claimed', crash: (l, r) => [crashingAfter(l, 'markCrossingClaimed'), r] },
    { label: 'after the registry confirmed', crash: (l, r) => [l, crashingAfter(r, 'confirmClaim')] },
  ];

  for (const step of steps) {
    it(`crashed ${step.label}: the retry ends done, with one confirmed claim`, async () => {
      const { objects } = world();
      const ledger = objects.tenant(TENANT_A);
      const registry = objects.registry();
      await ledger.recordCrossing(bind('x1', TENANT_A));
      const [dyingLedger, dyingRegistry] = step.crash(ledger, registry);
      await expect(runCrossing(dyingLedger, dyingRegistry, 'x1')).rejects.toThrow(/crashed after/);
      expect((await ledger.crossing('x1'))?.state).toMatch(/^(intent|claimed)$/);

      expect(await runCrossing(ledger, registry, 'x1')).toMatchObject({ state: 'done', outcome: null });
      expect(await registry.readClaim('hostname', 'shop.example.test')).toMatchObject({ claimId: 'x1', holder: TENANT_A, state: 'confirmed' });
      expect(await ledger.openCrossings({ updatedBefore: '9999', limit: 10 })).toEqual([]);
    });
  }

  it('a crossing resumed after its lease ran out and another tenant took the key ends failed, not bound', async () => {
    const { objects, clock } = world();
    const registry = objects.registry();
    const a = objects.tenant(TENANT_A);
    const b = objects.tenant(TENANT_B);
    await a.recordCrossing(bind('xa', TENANT_A, 1000));
    await expect(runCrossing(crashingAfter(a, 'markCrossingClaimed'), registry, 'xa')).rejects.toThrow();
    clock.t += 1000;
    await b.recordCrossing(bind('xb', TENANT_B));
    expect(await runCrossing(b, registry, 'xb')).toMatchObject({ state: 'done' });

    expect(await runCrossing(a, registry, 'xa')).toMatchObject({ state: 'failed', outcome: 'superseded' });
    expect(await registry.readClaim('hostname', 'shop.example.test')).toMatchObject({ holder: TENANT_B, state: 'confirmed' });
  });

  it('two tenants crossing for one hostname at once: exactly one is done, the other failed as held', async () => {
    const { objects } = world();
    const registry = objects.registry();
    const a = objects.tenant(TENANT_A);
    const b = objects.tenant(TENANT_B);
    await a.recordCrossing(bind('xa', TENANT_A));
    await b.recordCrossing(bind('xb', TENANT_B));
    const ends = await Promise.all([runCrossing(a, registry, 'xa'), runCrossing(b, registry, 'xb')]);
    expect(ends.map((c) => c.state).sort()).toEqual(['done', 'failed']);
    const loser = ends.find((c) => c.state === 'failed')!;
    const winner = ends.find((c) => c.state === 'done')!;
    expect(loser.outcome).toBe(`held by ${winner.holder}`);
  });

  it('recording the same crossing twice is one crossing; the same id for another key is refused', async () => {
    const { objects } = world();
    const ledger = objects.tenant(TENANT_A);
    const first = await ledger.recordCrossing(bind('x1', TENANT_A));
    expect(await ledger.recordCrossing(bind('x1', TENANT_A))).toEqual(first);
    await expect(ledger.recordCrossing({ ...bind('x1', TENANT_A), key: 'other.test' })).rejects.toThrow(/already recorded/);
  });

  it('a tenant’s ledger answers only its own crossings, and the safety net only the old open ones', async () => {
    const { objects, clock } = world();
    const a = objects.tenant(TENANT_A);
    await a.recordCrossing(bind('old', TENANT_A));
    clock.t += 60 * 60 * 1000;
    const cut = new Date(clock.t).toISOString();
    await a.recordCrossing({ ...bind('new', TENANT_A), key: 'new.test' });
    expect((await a.openCrossings({ updatedBefore: cut, limit: 10 })).map((c) => c.crossingId)).toEqual(['old']);
    expect(await objects.tenant(TENANT_B).crossing('old')).toBeNull();
  });
});
