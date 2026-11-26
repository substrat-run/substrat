/**
 * K-69, step 4.2 (#3376): the switch that hands each connection's sweep to its own object, the pass's
 * check, and one run of one connection's sweep (`src/connection-sweep.ts`).
 */
import { describe, expect, it, vi } from 'vitest';
import { connectionId, platformActorId, tenantId, type Connection } from '@substrat-run/contracts';
import type { ScopeHost, SweepRunInput } from '@substrat-run/kernel';
import { checkConnectionSweeps, connectorSweepOwnerOf, sweepOwnConnection } from '../src/connection-sweep.js';

const ACTOR = platformActorId.parse('01JZ00000000000000000000SV');
const T = tenantId.parse('01JZ00000000000000000000TN');
let n = 0;
const conn = (provider = 'acme', revokedAt: string | null = null) =>
  ({ id: connectionId.parse('01K' + String(++n).padStart(23, '0')), tenantId: T, vertical: 'crm', provider, revokedAt, ownerScopeId: null }) as unknown as Connection;
const refOf = (c: Connection) => ({ id: c.id, tenantId: c.tenantId, vertical: c.vertical, provider: c.provider });

describe('CONNECTOR_SWEEP_OWNER', () => {
  it('leaves the sweep with the pass unless it says connection and the objects are bound', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(connectorSweepOwnerOf(undefined, true)).toBe('pass');
    expect(connectorSweepOwnerOf(' connection ', true)).toBe('connection');
    expect(connectorSweepOwnerOf('connection', false)).toBe('pass');
    expect(connectorSweepOwnerOf('connections', true)).toBe('pass');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("the pass's check", () => {
  it('counts what each live object answered, and hands back the connections whose object it could not reach', async () => {
    const [held, started, overdue, lost] = [conn(), conn(), conn(), conn()];
    const revoked = conn('acme', '2026-11-20T00:00:00.000Z');
    const answers = new Map<string, string>([[held.id, 'held'], [started.id, 'started'], [overdue.id, 'overdue']]);
    const asked: string[] = [];
    const ns = {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        ensure: async (ref: { id: string }) => {
          asked.push(name);
          const a = answers.get(ref.id);
          if (!a) throw new Error('unreachable');
          return a;
        },
      }),
    } as unknown as DurableObjectNamespace;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { check, fallback } = await checkConnectionSweeps(ns, [held, started, overdue, lost, revoked]);
    warn.mockRestore();
    expect(check).toEqual({ held: 1, started: 1, overdue: 1, fallback: 1 });
    expect(fallback).toEqual([lost]);
    // A revoked connection's object is not woken: it is terminal, and its object clears itself.
    expect(asked).not.toContain(`connection:${revoked.id}`);
  });
});

describe("one run of a connection's own sweep", () => {
  function hostWith(rows: Connection[]) {
    const filters: unknown[] = [];
    const ledger: SweepRunInput[] = [];
    const summary: string[] = [];
    const host = {
      admin: {
        listConnections: async (_a: unknown, f: unknown) => (filters.push(f), rows),
        listSweepRuns: async () => [],
        listScopes: async () => [],
        summarizeAccess: async () => void summary.push('open'),
        flushAccessSummary: async () => (summary.push('flush'), null),
      },
    } as unknown as ScopeHost;
    return { host, filters, ledger, summary };
  }

  it('sweeps its one connection with the pass options, and is gone once the connection is revoked', async () => {
    const c = conn('hourly');
    const w = hostWith([c]);
    const swept: string[] = [];
    let settled = 0;
    const deps = {
      host: w.host,
      actor: ACTOR,
      settle: async () => void (settled += 1),
      options: {
        actor: ACTOR,
        fetch: (() => Promise.reject(new Error('unused'))) as never,
        sweepers: { hourly: async (_h: unknown, id: string) => void swept.push(id) },
        sweepEveryMinutes: { hourly: 60 },
        recordSweepRun: (e: SweepRunInput) => void w.ledger.push(e),
      },
    };
    expect(await sweepOwnConnection(deps, refOf(c))).toEqual({ intervalMs: 60 * 60_000 });
    expect(swept).toEqual([c.id]);
    expect(w.ledger).toEqual([expect.objectContaining({ kind: 'connector', unit: c.id, outcome: 'ok' })]);
    expect(w.filters).toEqual([{ tenantId: T, vertical: 'crm', provider: 'hourly', includeRevoked: true }]);
    expect(settled).toBe(1);
    expect(w.summary).toEqual(['open', 'flush']);

    const revoked = { ...c, revokedAt: '2026-11-20T00:00:00.000Z' } as Connection;
    expect(await sweepOwnConnection({ ...deps, host: hostWith([revoked]).host }, refOf(c))).toEqual({ gone: true });
    expect(await sweepOwnConnection({ ...deps, host: hostWith([]).host }, refOf(c))).toEqual({ gone: true });
    expect(swept).toHaveLength(1);
  });
});
