import { describe, expect, it } from 'vitest';
import { connectionId, instant, platformActorId, tenantId } from '@substrat-run/contracts';
import type { SweepRunEntry } from '@substrat-run/contracts';
import { CONNECTOR_SWEEP_PAUSED, runConnectorSweep, runPlatformSweep, type ConnectorSweepOptions } from '../src/platform-sweep.js';
import type { FetchLike } from '../src/connector-transport.js';
import type { ScopeHost, SweepRunFilter, SweepRunInput } from '../src/scope-host.js';

/**
 * #3324: one connection's sweep killed the control plane's scheduled pass on every run for three
 * days. A sweep the isolate dies in records nothing, so the next pass ran it again; and it ran
 * before the drains, the digest and the backup, so they never ran at all. These hold the sweep to:
 * an attempt noted before the work, a crashed attempt waited out (doubling, capped), an operator's
 * pause, a per-connection share of the pass, and a pass that can leave the sweep out to run last.
 */

const ACTOR = platformActorId.parse('01JZ00000000000000000000SV');
const T = tenantId.parse('01JZ00000000000000000000TN');
let n = 0;
const cid = () => connectionId.parse('01K' + String(++n).padStart(23, '0'));

/** A host whose sweep ledger is a list: both recorders write to it and `listSweepRuns` reads it. */
function world(providers: Record<string, string>, clock: { now: number }) {
  const ledger: SweepRunEntry[] = [];
  let seq = 0;
  const write = (e: SweepRunInput) => {
    const at = instant.parse(new Date(clock.now).toISOString());
    ledger.push({
      id: '01Z' + String(++seq).padStart(23, '0'),
      kind: e.kind,
      unit: e.unit,
      outcome: e.outcome,
      tenantId: e.tenantId ?? null,
      scopeId: null,
      vertical: e.vertical ?? null,
      version: null,
      operation: e.operation ?? null,
      eventType: null,
      observedAt: null,
      connectionId: e.connectionId ?? null,
      error: e.error ?? null,
      elapsedMs: e.elapsedMs ?? null,
      at,
    });
  };
  const connections = Object.entries(providers).map(([id, provider]) => ({ id, provider, tenantId: T, vertical: 'v', revokedAt: null }));
  const host = {
    admin: {
      listScopes: async () => [],
      listConnections: async () => connections,
      listSweepRuns: async (_a: unknown, f: SweepRunFilter) =>
        ledger
          .filter((r) => (!f.kind || r.kind === f.kind) && (!f.unit || r.unit === f.unit) && (!f.outcome || r.outcome === f.outcome))
          .reverse()
          .slice(0, f.limit ?? 100),
    },
  } as unknown as ScopeHost;
  return { host, ledger, write };
}

const FETCH = (() => Promise.reject(new Error('unused'))) as unknown as FetchLike;
const MIN = 60_000;

function options(w: ReturnType<typeof world>, clock: { now: number }, sweepers: ConnectorSweepOptions['sweepers'], extra: Partial<ConnectorSweepOptions> = {}): ConnectorSweepOptions {
  return {
    actor: ACTOR,
    fetch: FETCH,
    sweepers,
    clock: () => clock.now,
    recordSweepRun: (e) => w.write(e),
    recordSweepAttempt: async (e) => w.write(e),
    ...extra,
  };
}

/** What a pass that died inside a sweep leaves: the attempt, and no outcome after it. */
const diedIn = (w: ReturnType<typeof world>, id: string) =>
  w.write({ kind: 'connector-attempt', unit: id, outcome: 'started', tenantId: null, connectionId: id });

describe('the connector sweep notes each attempt before the work (#3324)', () => {
  it('writes the attempt before the sweeper runs and the outcome after it', async () => {
    const clock = { now: Date.parse('2026-11-22T10:00:00Z') };
    const id = cid();
    const w = world({ [id]: 'acme' }, clock);
    let seenAtCall: string[] = [];
    await runConnectorSweep(w.host, options(w, clock, { acme: async () => { seenAtCall = w.ledger.map((r) => `${r.kind}:${r.outcome}`); } }));
    expect(seenAtCall).toEqual(['connector-attempt:started']);
    expect(w.ledger.map((r) => `${r.kind}:${r.outcome}`)).toEqual(['connector-attempt:started', 'connector:ok']);
    // Staff's alone: no tenant on the attempt, so a tenant's read never meets it.
    expect(w.ledger[0]!.tenantId).toBeNull();
  });

  it('does not sweep a connection whose attempt could not be noted', async () => {
    const clock = { now: Date.parse('2026-11-22T10:00:00Z') };
    const id = cid();
    const w = world({ [id]: 'acme' }, clock);
    let polls = 0;
    const report = await runConnectorSweep(
      w.host,
      options(w, clock, { acme: async () => { polls += 1; } }, { recordSweepAttempt: async () => { throw new Error('directory down'); } }),
    );
    expect(polls).toBe(0);
    expect(report.errors[0]?.error).toMatch(/cannot note the sweep's attempt/);
  });
});

describe('a sweep the pass died in is waited out, not run again on the next pass (#3324)', () => {
  it('waits out one unfinished attempt, then retries it once and files a staff failure', async () => {
    const clock = { now: Date.parse('2026-11-22T10:00:00Z') };
    const bad = cid();
    const good = cid();
    const w = world({ [bad]: 'acme', [good]: 'acme' }, clock);
    diedIn(w, bad);
    const swept: string[] = [];
    const failures: string[] = [];
    const opts = options(w, clock, { acme: async (_h, id) => { swept.push(id); } }, { recordFailure: (f) => void failures.push(f.message) });

    // 10 minutes on: well inside 30 minutes ±20%. The other connection is swept as usual.
    clock.now += 10 * MIN;
    const waiting = await runConnectorSweep(w.host, opts);
    expect(swept).toEqual([good]);
    expect(waiting.connectionsBackingOff).toBe(1);
    expect(waiting.errors).toEqual([expect.objectContaining({ id: bad, error: expect.stringMatching(/did not finish.*next attempt after/) })]);
    expect(failures).toEqual([]);

    // 40 minutes on: past it. Retried, and the digest gets one row saying why.
    clock.now += 30 * MIN;
    swept.length = 0;
    await runConnectorSweep(w.host, opts);
    expect(swept.sort()).toEqual([bad, good].sort());
    expect(failures).toEqual([expect.stringMatching(/the last 1 sweep of connection .* did not finish.*trying again/)]);

    // That retry finished, so nothing is waited out on the pass after.
    clock.now += 1 * MIN;
    swept.length = 0;
    expect((await runConnectorSweep(w.host, opts)).connectionsBackingOff).toBe(0);
    expect(swept).toHaveLength(2);
  });

  it('doubles the wait with each unfinished attempt in a row, up to the cap', async () => {
    const clock = { now: Date.parse('2026-11-22T10:00:00Z') };
    const id = cid();
    const w = world({ [id]: 'acme' }, clock);
    let polls = 0;
    const opts = options(w, clock, { acme: async () => { polls += 1; } }, { connectorCrashBackoff: { baseDelayMs: 10 * MIN, maxDelayMs: 30 * MIN } });
    const passAt = async (minutesAfterLastAttempt: number) => {
      const at = Date.parse(w.ledger.at(-1)!.at);
      clock.now = at + minutesAfterLastAttempt * MIN;
      return runConnectorSweep(w.host, opts);
    };

    diedIn(w, id);
    diedIn(w, id); // two in a row: 20 minutes ±20%
    expect((await passAt(15)).connectionsBackingOff).toBe(1);
    diedIn(w, id);
    diedIn(w, id); // four in a row: 80 minutes, capped at 30 ±20%
    expect((await passAt(23)).connectionsBackingOff).toBe(1);
    expect((await passAt(37)).connectionsBackingOff).toBe(0);
    expect(polls).toBe(1);
  });
});

describe("an operator's pause (#3324)", () => {
  it('skips a paused connection without an attempt or a poll, and says so on its row', async () => {
    const clock = { now: Date.parse('2026-11-22T10:00:00Z') };
    const paused = cid();
    const other = cid();
    const w = world({ [paused]: 'acme', [other]: 'acme' }, clock);
    const swept: string[] = [];
    const report = await runConnectorSweep(w.host, options(w, clock, { acme: async (_h, id) => { swept.push(id); } }, { pausedConnections: new Set([paused]) }));
    expect(swept).toEqual([other]);
    expect(report).toMatchObject({ connectionsPaused: 1, connectionsSkipped: 1, connectionsSwept: 1 });
    expect(w.ledger.filter((r) => r.unit === paused)).toEqual([expect.objectContaining({ kind: 'connector', outcome: 'skipped', error: CONNECTOR_SWEEP_PAUSED })]);
  });
});

describe("each connection's share of the pass (#3324)", () => {
  it('fails the connection that reads past its share and still sweeps the others', async () => {
    const clock = { now: Date.parse('2026-11-22T10:00:00Z') };
    const big = cid();
    const small = cid();
    const w = world({ [big]: 'big', [small]: 'small' }, clock);
    const fetch = (async (url: string) => new Response('x'.repeat(url.endsWith('/big') ? 2_000 : 10))) as unknown as FetchLike;
    const report = await runConnectorSweep(w.host, {
      ...options(w, clock, {
        big: async (_h, _id, deps) => (await deps.fetch('https://p.example/big')).text(),
        small: async (_h, _id, deps) => (await deps.fetch('https://p.example/small')).text(),
      }),
      fetch,
      connectorBudget: { maxBytes: 1_000 },
    });
    expect(report.connectionsSwept).toBe(1);
    const outcome = (id: string) => w.ledger.find((r) => r.kind === 'connector' && r.unit === id);
    expect(outcome(big)).toMatchObject({ outcome: 'failed' });
    expect(outcome(small)).toMatchObject({ outcome: 'ok' });
    expect(report.errors).toEqual([expect.objectContaining({ id: big, error: expect.stringMatching(/1000 bytes of response bodies/) })]);
  });
});

describe('a pass that leaves the connector sweep to its caller (#3324)', () => {
  it('reads no connection when sweepConnectors is false', async () => {
    let listed = 0;
    const host = { admin: { listScopes: async () => [], listConnections: async () => { listed += 1; return []; } } } as unknown as ScopeHost;
    const report = await runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: {}, sweepConnectors: false, drainRetries: false, reconcileMigrations: false });
    expect(listed).toBe(0);
    expect(report.connectionsSwept).toBe(0);
  });
});
