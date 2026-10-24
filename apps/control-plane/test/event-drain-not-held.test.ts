import { describe, expect, it, vi } from 'vitest';
import type { OpsFailureEntry, PlatformActorId, Scope, ScopeId, TenantId } from '@substrat-run/contracts';
import { ScopeNotHeld, scopeNotHeldRefusal, type OpsFailureInput } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-api';
import { NOT_HELD_REFILE_MS, fileNotHeld, undrainedOrNotHeld } from '../src/event-drain-not-held.js';

const T = 'tenant-a' as TenantId;
const ACTOR = 'actor' as PlatformActorId;
const gone = (id: string) => ({ tenantId: T, scopeId: id as ScopeId });
const S = 'scope-1' as ScopeId;

/** A ledger that remembers what was filed, as the directory does across isolates. */
function ledger(opts: { failWrites?: number } = {}) {
  const rows: OpsFailureInput[] = [];
  let failWrites = opts.failWrites ?? 0;
  const admin = {
    listOpsFailures: vi.fn(async (_a: PlatformActorId, f?: { scopeId?: string; operation?: string }) =>
      rows.filter((r) => r.scopeId === f?.scopeId && r.operation === f?.operation) as unknown as OpsFailureEntry[]),
    recordOpsFailure: vi.fn(async (r: OpsFailureInput) => {
      if (failWrites-- > 0) throw new Error('ledger down');
      rows.push(r);
    }),
  };
  return { admin, rows };
}

describe('fileNotHeld (#2544)', () => {
  it('files one STAFF row per scope across several fresh isolates', async () => {
    const { admin, rows } = ledger();
    for (let isolate = 0; isolate < 4; isolate += 1) {
      await fileNotHeld({ admin, actor: ACTOR, recorded: new Set(), notHeld: [gone('s1')] });
    }
    expect(rows).toHaveLength(1);
    // No tenant: a tenant-attributed row is the tenant's to read (#2540); this one is the platform's.
    expect(rows[0]).toMatchObject({ operation: 'sweep.event-drain', stage: 'not-held', tenantId: null, scopeId: 's1' });
    expect(rows[0]!.message).not.toMatch(/tenant-a/);
  });

  it('does not even read the ledger again on later ticks of one isolate', async () => {
    const { admin } = ledger();
    const recorded = new Set<string>();
    await fileNotHeld({ admin, actor: ACTOR, recorded, notHeld: [gone('s1')] });
    await fileNotHeld({ admin, actor: ACTOR, recorded, notHeld: [gone('s1')] });
    expect(admin.listOpsFailures).toHaveBeenCalledTimes(1);
  });

  it('remembers a scope only after the ledger answered: a failed write is tried again', async () => {
    const { admin, rows } = ledger({ failWrites: 1 });
    const recorded = new Set<string>();
    await fileNotHeld({ admin, actor: ACTOR, recorded, notHeld: [gone('s1')] });
    expect(rows).toHaveLength(0);
    expect(recorded.has('s1')).toBe(false);
    await fileNotHeld({ admin, actor: ACTOR, recorded, notHeld: [gone('s1')] });
    expect(rows).toHaveLength(1);
  });

  it('files a scope again once it was held in between, and a second scope on its own', async () => {
    const { admin, rows } = ledger();
    const recorded = new Set<string>();
    await fileNotHeld({ admin, actor: ACTOR, recorded, notHeld: [gone('s1')] });
    await fileNotHeld({ admin, actor: ACTOR, recorded, notHeld: [gone('s1'), gone('s2')] });
    expect(rows.map((r) => r.scopeId)).toEqual(['s1', 's2']);
    await fileNotHeld({ admin, actor: ACTOR, recorded, notHeld: undefined });
    expect(recorded.size).toBe(0);
  });

  it('reads the ledger over the last week, so a condition that lasts is said again weekly', async () => {
    const { admin } = ledger();
    const now = new Date('2026-10-25T12:00:00.000Z');
    await fileNotHeld({ admin, actor: ACTOR, recorded: new Set(), notHeld: [gone('s1')], now: () => now });
    expect(admin.listOpsFailures).toHaveBeenCalledWith(ACTOR, expect.objectContaining({
      since: new Date(now.getTime() - NOT_HELD_REFILE_MS).toISOString(),
    }));
  });
});

describe('undrainedOrNotHeld (#2544)', () => {
  const refusal = () => new ControlPlaneError(409, scopeNotHeldRefusal(S));
  const scope = (over: Partial<Scope>): Scope => ({ id: S, status: 'active', servingRef: null, verticalVersionId: 'v1', ...over }) as Scope;
  const routeOf = (s: Scope) => `${s.servingRef ?? ''}|${s.verticalVersionId ?? ''}`;
  const drain = (read: () => Promise<never>, now: Scope | undefined, routeAtRead = '|v1') =>
    undrainedOrNotHeld({ scopeId: S, read, record: async () => now, routeAtRead, routeOf });

  it('maps a not-held 409 of an active scope that still routes there to ScopeNotHeld', async () => {
    await expect(drain(async () => { throw refusal(); }, scope({}))).rejects.toBeInstanceOf(ScopeNotHeld);
  });

  it.each(['reaped', 'archived'] as const)('reads a scope %s since it was listed as nothing to ship', async (status) => {
    expect(await drain(async () => { throw refusal(); }, scope({ status }))).toEqual([]);
  });

  it('reads a scope with no record as nothing to ship', async () => {
    expect(await drain(async () => { throw refusal(); }, undefined)).toEqual([]);
  });

  it('reads a scope a carry re-pointed under the read as nothing this tick: the new home is read next', async () => {
    expect(await drain(async () => { throw refusal(); }, scope({ verticalVersionId: 'v2' }))).toEqual([]);
  });

  it('lets another 409, another refusal sentence and any other failure through as errors', async () => {
    await expect(drain(async () => { throw new ControlPlaneError(409, 'something else'); }, scope({}))).rejects.toThrow('something else');
    await expect(drain(async () => { throw new ControlPlaneError(409, scopeNotHeldRefusal('other' as ScopeId)); }, scope({}))).rejects.not.toBeInstanceOf(ScopeNotHeld);
    await expect(drain(async () => { throw new Error('boom'); }, scope({}))).rejects.toThrow('boom');
  });

  it('keeps a failed directory read an error, never a skip', async () => {
    await expect(
      undrainedOrNotHeld({ scopeId: S, read: async () => { throw refusal(); }, record: async () => { throw new Error('directory down'); }, routeAtRead: '|v1', routeOf }),
    ).rejects.toThrow('directory down');
  });

  it('answers a held scope as the read does', async () => {
    const events = Object.assign([], { skipped: { count: 1, eventIds: ['x'] } });
    expect(await undrainedOrNotHeld({ scopeId: S, read: async () => events, record: async () => scope({}), routeAtRead: '|v1', routeOf })).toBe(events);
  });
});
