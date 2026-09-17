import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { instant, platformActorId, type OpsFailureEntry, type SweepRunEntry } from '@substrat-run/contracts';
import { ulid, type OpsFailureInput, type SweepRunInput } from '@substrat-run/kernel';
import {
  SWEEP_INTERVAL_MS,
  failureDigestEmail,
  failureDigestWatermark,
  parseRecipients,
  sendFailureDigest,
  type FailureDigestOptions,
} from '../src/failure-alerts.js';

/**
 * The staff failure digest (#1416): the scheduled pass's one push. Held to four
 * facts — unset recipient ⇒ nothing sent; failures since the watermark ⇒ ONE mail
 * naming them; nothing since ⇒ no mail; a send that fails is a ledger row, not a
 * thrown pass. The watermark is pinned on a stub admin (every timestamp chosen), and
 * the read shape is proven once against the real adapter, so the filter the phase
 * hands `listOpsFailures` / `listSweepRuns` is one the DO actually honours.
 */

const ACTOR = platformActorId.parse(ulid());
const FROM = { email: 'no-reply@send.substrat.net', name: 'Substrat alerts' };
const T0 = new Date('2026-09-18T10:00:00.000Z');
const FLOOR = new Date(T0.getTime() - SWEEP_INTERVAL_MS).toISOString();

function failure(at: string, message: string, extra: Partial<OpsFailureEntry> = {}): OpsFailureEntry {
  return {
    id: ulid(),
    actor: ACTOR,
    operation: 'deploy.upload',
    stage: 'upload',
    tenantId: null,
    scopeId: null,
    vertical: 'todo',
    version: null,
    status: 502,
    origin: 'provider',
    code: null,
    message,
    reference: null,
    fingerprint: null,
    at: instant.parse(at),
    ...extra,
  };
}

function sweepRun(at: string): SweepRunEntry {
  return {
    id: ulid(),
    kind: 'connector',
    unit: 'conn-1',
    outcome: 'ok',
    tenantId: null,
    scopeId: null,
    vertical: null,
    version: null,
    operation: 'sweep.connector:scrive',
    eventType: null,
    observedAt: null,
    connectionId: 'conn-1',
    error: null,
    elapsedMs: 12,
    at: instant.parse(at),
  };
}

/** A stub ledger: records what the phase asked for, answers with what the test seeded. */
function stubAdmin(seed: { failures?: OpsFailureEntry[]; sweepRuns?: SweepRunEntry[] } = {}) {
  const calls = { opsFilters: [] as unknown[], sweepFilters: [] as unknown[], recorded: [] as OpsFailureInput[] };
  const admin: FailureDigestOptions['admin'] = {
    listOpsFailures: async (_actor, filter) => {
      calls.opsFilters.push(filter);
      const since = filter?.since ?? '';
      return (seed.failures ?? []).filter((f) => f.at >= since);
    },
    listSweepRuns: async (_actor, filter) => {
      calls.sweepFilters.push(filter);
      // Newest WRITTEN first — by id, as the adapter orders — never by `at`.
      const rows = [...(seed.sweepRuns ?? [])].sort((a, b) => (a.id < b.id ? 1 : -1));
      return filter?.limit !== undefined ? rows.slice(0, filter.limit) : rows;
    },
    recordOpsFailure: async (entry) => {
      calls.recorded.push(entry);
    },
  };
  return { admin, calls };
}

/** The worker's two calls in order: watermark before the sweep, digest after it. */
async function runPhase(
  stub: ReturnType<typeof stubAdmin>,
  transport: MockEmailTransport,
  overrides: Partial<FailureDigestOptions> = {},
) {
  const since = await failureDigestWatermark({ admin: stub.admin, actor: ACTOR, passStartedAt: T0 });
  return sendFailureDigest({
    admin: stub.admin,
    actor: ACTOR,
    transport,
    from: FROM,
    recipients: 'ops@example.com',
    since,
    reportErrors: [],
    now: () => new Date(T0.getTime() + 5_000),
    ...overrides,
  });
}

describe('failureDigestWatermark', () => {
  it('is the newest `at` among the last rows written, not the newest row by id', async () => {
    // A drained CP-less batch (#1232) is written AFTER the previous pass's own rows —
    // newest by id — but carries the older pass time its vertical stamped.
    const previousPass = '2026-09-18T09:45:03.000Z';
    const direct = sweepRun(previousPass);
    const drained = sweepRun('2026-09-18T09:46:00.000Z');
    const older = sweepRun('2026-09-18T09:30:02.000Z');
    // ids are ULIDs minted in construction order; make the drained row the newest.
    const stub = stubAdmin({ sweepRuns: [older, direct, drained] });
    expect(await failureDigestWatermark({ admin: stub.admin, actor: ACTOR, passStartedAt: T0 })).toBe(
      '2026-09-18T09:46:00.000Z',
    );
    // Bounded: it reads the recent tail, never the whole table.
    expect(stub.calls.sweepFilters).toEqual([{ limit: 25 }]);
  });

  it('no sweep-run rows at all: one cron interval before the pass, not forever', async () => {
    const stub = stubAdmin();
    expect(await failureDigestWatermark({ admin: stub.admin, actor: ACTOR, passStartedAt: T0 })).toBe(FLOOR);
  });

  it('a stale row (a missed tick) does not widen the window past the floor', async () => {
    const stub = stubAdmin({ sweepRuns: [sweepRun('2026-09-18T08:00:00.000Z')] });
    expect(await failureDigestWatermark({ admin: stub.admin, actor: ACTOR, passStartedAt: T0 })).toBe(FLOOR);
  });

  it('a sweep-run read that fails falls back to the floor AND is a ledger row', async () => {
    const stub = stubAdmin();
    stub.admin.listSweepRuns = async () => {
      throw new Error('DO unavailable');
    };
    expect(await failureDigestWatermark({ admin: stub.admin, actor: ACTOR, passStartedAt: T0 })).toBe(FLOOR);
    expect(stub.calls.recorded).toEqual([
      { actor: ACTOR, operation: 'alerts.digest', stage: 'watermark', message: 'DO unavailable' },
    ]);
  });
});

describe('sendFailureDigest', () => {
  it('unset recipient: nothing is read and nothing is sent', async () => {
    const stub = stubAdmin({ failures: [failure('2026-09-18T09:55:00.000Z', 'boom')] });
    const transport = new MockEmailTransport();
    for (const recipients of [undefined, '', '  ', ' , ']) {
      const out = await runPhase(stub, transport, { recipients });
      expect(out).toEqual({ status: 'skipped', reason: 'no-recipient' });
    }
    expect(transport.sent).toHaveLength(0);
    expect(stub.calls.opsFilters).toHaveLength(0);
  });

  it('failures since the previous pass: ONE digest, naming each of them', async () => {
    const previousPass = '2026-09-18T09:45:03.000Z';
    const stub = stubAdmin({
      sweepRuns: [sweepRun('2026-09-18T09:30:02.000Z'), sweepRun(previousPass)],
      failures: [
        failure('2026-09-18T09:40:00.000Z', 'already reported last pass'),
        failure('2026-09-18T09:50:00.000Z', 'upload refused by the provider', { reference: 'cf-ref-1' }),
        failure('2026-09-18T09:58:00.000Z', 'drain gave up', {
          operation: 'platform-request.drain',
          stage: null,
          status: null,
          origin: 'platform',
          code: 'unavailable',
        }),
      ],
    });
    const transport = new MockEmailTransport();
    const out = await runPhase(stub, transport, { recipients: 'ops@example.com, oncall@example.com' });

    expect(out).toMatchObject({ status: 'sent', since: previousPass, failures: 2, reportErrors: 0 });
    expect(stub.calls.opsFilters).toEqual([{ since: previousPass, order: 'asc' }]);

    expect(transport.sent).toHaveLength(1);
    const mail = transport.last!;
    expect(mail.to.map((a) => a.email)).toEqual(['ops@example.com', 'oncall@example.com']);
    expect(mail.from).toEqual(FROM);
    expect(mail.subject).toBe(`[substrat] 2 failures since ${previousPass}`);
    expect(mail.text).toContain('upload refused by the provider');
    expect(mail.text).toContain('reference=cf-ref-1');
    expect(mail.text).toContain('deploy.upload/upload');
    expect(mail.text).toContain('[502 provider]');
    expect(mail.text).toContain('platform-request.drain');
    expect(mail.text).toContain('[unavailable platform]');
    expect(mail.text).not.toContain('already reported last pass');
    expect(mail.html).toContain('upload refused by the provider');
  });

  it("the pass's own errors ride the digest even when the ledger is empty", async () => {
    const stub = stubAdmin();
    const transport = new MockEmailTransport();
    const out = await runPhase(stub, transport, {
      reportErrors: [{ kind: 'sweep', id: 'conn-9', error: 'connection secret cannot be opened' }],
    });
    expect(out).toMatchObject({ status: 'sent', failures: 0, reportErrors: 1 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.last!.subject).toMatch(/^\[substrat\] 1 failure since /);
    expect(transport.last!.text).toContain('sweep conn-9: connection secret cannot be opened');
  });

  it('nothing since the watermark: no mail', async () => {
    const stub = stubAdmin({
      sweepRuns: [sweepRun('2026-09-18T09:45:03.000Z')],
      failures: [failure('2026-09-18T09:44:00.000Z', 'older than the previous pass')],
    });
    const transport = new MockEmailTransport();
    const out = await runPhase(stub, transport);
    expect(out).toEqual({ status: 'skipped', reason: 'nothing-to-report' });
    expect(transport.sent).toHaveLength(0);
  });

  it('with no sweep-run rows the window is one cron interval, and the digest says so', async () => {
    const stub = stubAdmin({ failures: [failure('2026-09-18T09:50:00.000Z', 'recent')] });
    const transport = new MockEmailTransport();
    const out = await runPhase(stub, transport);
    expect(out).toMatchObject({ status: 'sent', since: FLOOR });
    expect(stub.calls.opsFilters).toEqual([{ since: FLOOR, order: 'asc' }]);
    expect(transport.last!.subject).toBe(`[substrat] 1 failure since ${FLOOR}`);
  });

  it('a send that fails is a ledger row of its own, never a thrown pass', async () => {
    const stub = stubAdmin({ failures: [failure('2026-09-18T09:50:00.000Z', 'recent')] });
    const transport = new MockEmailTransport({ failWith: 'provider down' });
    const out = await runPhase(stub, transport);
    expect(out).toMatchObject({ status: 'failed', error: 'provider down' });
    // Recorded BEFORE the phase answers — a row still in flight when `scheduled` returns may never land.
    expect(stub.calls.recorded).toEqual([
      { actor: ACTOR, operation: 'alerts.digest', stage: 'send', message: 'provider down' },
    ]);
  });

  it('a recorder that itself fails does not mask the phase answer', async () => {
    const stub = stubAdmin({ failures: [failure('2026-09-18T09:50:00.000Z', 'recent')] });
    stub.admin.recordOpsFailure = async () => {
      throw new Error('ledger down too');
    };
    const transport = new MockEmailTransport({ failWith: 'provider down' });
    await expect(runPhase(stub, transport)).resolves.toMatchObject({ status: 'failed', error: 'provider down' });
  });

  it('a ledger that cannot be read is reported as failed, not mailed as quiet', async () => {
    const stub = stubAdmin();
    stub.admin.listOpsFailures = async () => {
      throw new Error('DO unavailable');
    };
    const transport = new MockEmailTransport();
    const out = await runPhase(stub, transport);
    expect(out).toMatchObject({ status: 'failed', error: 'DO unavailable' });
    expect(transport.sent).toHaveLength(0);
    expect(stub.calls.recorded).toEqual([
      { actor: ACTOR, operation: 'alerts.digest', stage: 'read', message: 'DO unavailable' },
    ]);
  });

  it('reads the real ledger: a failure recorded since the previous sweep run is mailed', async () => {
    const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    try {
      const marker = `real-ledger-${ulid()}`;
      const run: SweepRunInput = { kind: 'connector', unit: `conn-${ulid()}`, outcome: 'ok' };
      await host.admin.recordSweepRun(run);
      await host.admin.recordOpsFailure({ actor: ACTOR, operation: 'deploy.upload', message: marker });

      // The worker's order: watermark first ("this pass" begins after both rows landed),
      // then the digest. Storage is shared across suites, so assert that OUR row is
      // named, not that it is the only one.
      const since = await failureDigestWatermark({ admin: host.admin, actor: ACTOR, passStartedAt: new Date() });
      const transport = new MockEmailTransport();
      const out = await sendFailureDigest({
        admin: host.admin,
        actor: ACTOR,
        transport,
        from: FROM,
        recipients: 'ops@example.com',
        since,
        reportErrors: [],
      });
      expect(out.status).toBe('sent');
      expect(transport.sent).toHaveLength(1);
      expect(transport.last!.text).toContain(marker);
    } finally {
      await host.close();
    }
  });
});

describe('parseRecipients', () => {
  it('splits on commas, trims, and drops empties', () => {
    expect(parseRecipients('a@x.io, b@y.io ,,')).toEqual(['a@x.io', 'b@y.io']);
    expect(parseRecipients(undefined)).toEqual([]);
  });
});

describe('failureDigestEmail', () => {
  it('caps the listing and escapes the html part', () => {
    const failures = Array.from({ length: 60 }, (_, i) =>
      failure('2026-09-18T09:50:00.000Z', `<b>failure ${i}</b>`),
    );
    const msg = failureDigestEmail({
      to: ['ops@example.com'],
      from: FROM,
      since: '2026-09-18T09:45:00.000Z',
      until: '2026-09-18T10:00:00.000Z',
      failures,
      reportErrors: [],
      consoleUrl: 'https://console.example.com',
    });
    expect(msg.subject).toBe('[substrat] 60 failures since 2026-09-18T09:45:00.000Z');
    expect(msg.text).toContain('… and 10 more');
    expect(msg.html).toContain('&lt;b&gt;failure 0&lt;/b&gt;');
    expect(msg.html).not.toContain('<b>failure 0</b>');
    expect(msg.html).toContain('href="https://console.example.com"');
  });
});
