import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { CloudflareScopeHost, type EventDrainDelegation } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * The Tier-2 drain's reach (#1334), the platform end, against the real directory DO.
 *
 * On the shared control plane `env.SCOPE` is the module-less placeholder namespace, so a
 * drain over it would construct one empty DO per scope and ship nothing. With an
 * `eventDrainDelegation` injected, `readUndrainedEvents` and `markEventsDrained` go to
 * the deployment serving the scope instead — and the audit rows the two verbs write stay
 * on THIS host, whichever branch served them, which is what lets an auditor read
 * "these events left the platform" without knowing where they were stored.
 */
describe('event-drain delegation (#1334)', () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());

  const seen: { read: unknown[]; mark: unknown[]; redrain: unknown[] } = { read: [], mark: [], redrain: [] };
  const delegation: EventDrainDelegation = {
    readUndrained: async (a) => {
      seen.read.push(a);
      return [{ id: 'evt-1' }, { id: 'evt-2' }] as never;
    },
    markDrained: async (a) => {
      seen.mark.push(a);
      return a.eventIds.length;
    },
    // The far end answers how many it reopened; 3 then 0, so the test can tell a receipt
    // written for real work from one written for a no-op re-run.
    redrain: async (a) => {
      seen.redrain.push(a);
      return seen.redrain.length === 1 ? 3 : 0;
    },
  };
  const hostFor = () =>
    new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, eventDrainDelegation: delegation });

  beforeAll(async () => {
    const host = hostFor();
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
  });

  it('reads through the delegation, naming the vertical, with the limit bounded', async () => {
    const events = await hostFor().admin.readUndrainedEvents(staff, t, s, 5000);
    expect(events.map((e) => e.id)).toEqual(['evt-1', 'evt-2']);
    expect(seen.read).toEqual([{ tenantId: t, scopeId: s, vertical: 'docs', limit: 1000 }]);
  });

  it('stamps through the delegation, carrying the instant it recorded', async () => {
    const drained = await hostFor().admin.markEventsDrained(staff, t, s, ['evt-1', 'evt-2']);
    expect(drained).toBe(2);
    expect(seen.mark).toHaveLength(1);
    const call = seen.mark[0] as { tenantId: string; scopeId: string; vertical: string; eventIds: string[]; drainedAt: string };
    expect(call).toMatchObject({ tenantId: t, scopeId: s, vertical: 'docs', eventIds: ['evt-1', 'evt-2'] });
    // The receipt names the same instant the far end was told to stamp.
    const receipts = await hostFor().admin.auditLog(staff, { tenantId: t, scopeId: s, action: 'drainEvents' });
    expect(receipts).toHaveLength(1);
    expect((receipts[0]!.after as { drainedAt: string }).drainedAt).toBe(call.drainedAt);
  });

  it('reopens through the delegation, and receipts only real work', async () => {
    // Clearing stamps in the placeholder namespace would report success while reopening
    // nothing — the same false "the fleet has no events" the read delegation removes.
    const drainedBefore = '2026-09-16T00:00:00.000Z';
    await expect(hostFor().admin.redrainEvents(staff, t, s, { drainedBefore })).resolves.toBe(3);
    expect(seen.redrain).toEqual([{ tenantId: t, scopeId: s, vertical: 'docs', drainedBefore }]);
    // A re-run over a window already reopened changes nothing and writes nothing.
    await expect(hostFor().admin.redrainEvents(staff, t, s, { drainedBefore })).resolves.toBe(0);
    const receipts = await hostFor().admin.auditLog(staff, { tenantId: t, scopeId: s, action: 'redrainEvents' });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.after).toEqual({ redrained: 3, drainedBefore });
  });

  it('refuses a redrain with no instant, rather than reopening everything', async () => {
    // The instant IS the guard: without it, rows already shipped to the rebuilt table
    // would be reopened and land there twice.
    await expect(hostFor().admin.redrainEvents(staff, t, s, {} as never)).rejects.toThrow();
    await expect(hostFor().admin.redrainEvents(staff, t, s, { drainedBefore: 'yesterday' })).rejects.toThrow();
  });

  it('leaves the access row on this host, so the branch is invisible to an auditor', async () => {
    const rows = await hostFor().admin.accessLog(staff, { tenantId: t, method: 'readUndrainedEvents' });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses a reaped scope before reaching for the delegation, like the co-located branch', async () => {
    const gone = scopeId.parse(ulid());
    const host = hostFor();
    await host.provisionScope(staff, { tenantId: t, scopeId: gone, vertical: 'docs' });
    await host.admin.activateScope(staff, t, gone);
    await host.admin.archiveScope(staff, t, gone);
    await host.admin.reapScope(staff, t, gone, { force: true });
    const before = seen.read.length;
    await expect(hostFor().admin.readUndrainedEvents(staff, t, gone, 10)).rejects.toThrow(/reaped/);
    expect(seen.read).toHaveLength(before);
  });
});
