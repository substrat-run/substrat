import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCfObservabilityReader } from '../src/cf-observability.js';

/**
 * The bucketed series read (#1236) against a stubbed GraphQL endpoint. The thing worth
 * testing without a real account is the page ceiling: `workersInvocationsAdaptive`
 * answers at most 5,000 rows, a bucketed read is scripts × buckets, and the query orders
 * ASCENDING — so a truncated answer is missing its NEWEST buckets, which the caller's
 * zero-fill would then draw as an outage that never happened. Batching keeps the ask
 * under the ceiling; refusing covers the ask that cannot be batched (fleet-wide).
 */
afterEach(() => vi.unstubAllGlobals());

const reader = () => createCfObservabilityReader({ accountId: 'acct', apiToken: 'tok' });

/** One GraphQL answer, shaped as Cloudflare returns it. */
function answer(rows: Array<{ scriptName: string; datetimeHour: string; requests: number; errors: number }>) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptive: rows.map((r) => ({
              sum: { requests: r.requests, errors: r.errors },
              dimensions: { scriptName: r.scriptName, dispatchNamespaceName: 'verticals', datetimeHour: r.datetimeHour },
            })),
          },
        ],
      },
    },
  };
}

/** Stub `fetch`, recording the `scripts` variable each request asked for. */
function stub(reply: (scripts: string[] | null) => unknown) {
  const asked: Array<string[] | null> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: { body?: string }) => {
      const body = JSON.parse(init.body ?? '{}') as { variables?: { scripts?: string[] | null } };
      const scripts = body.variables?.scripts ?? null;
      asked.push(scripts);
      return new Response(JSON.stringify(reply(scripts)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return asked;
}

describe('cf observability serviceMetricsSeries (#1236) — the page ceiling', () => {
  it('batches a long service list so no single ask can reach the row limit', async () => {
    // 24h at hourly buckets is 25 rows per script, so a batch is 199 scripts (4,975
    // rows) — 250 must therefore arrive as two asks, and every name in exactly one.
    const services = Array.from({ length: 250 }, (_, i) => `acme-crm-${i}`);
    const asked = stub((scripts) =>
      answer((scripts ?? []).map((s) => ({ scriptName: s, datetimeHour: '2026-09-08T11:00:00', requests: 1, errors: 0 }))),
    );
    const rows = await reader().serviceMetricsSeries!({ hours: 24, services });

    expect(asked).toHaveLength(2);
    expect(asked.flatMap((a) => a ?? [])).toEqual(services);
    // The batches are merged, not raced — every script still has its row.
    expect(rows).toHaveLength(250);
    // And the bucket instant is normalised to UTC, as the axis reads it.
    expect(rows[0]).toMatchObject({ start: '2026-09-08T11:00:00Z', bucketMinutes: 60, namespace: 'verticals' });
  });

  it('resolves a batch whose every script filled every bucket — the busiest legitimate answer', async () => {
    // The batch size has to be STRICTLY under the ceiling, not equal to it: at exactly
    // the limit a complete answer is indistinguishable from a truncated page, and the
    // refusal below would report a full series as unavailable. This is the case that
    // catches that off-by-one — a whole batch of maximally busy scripts.
    // 200 is the number that breaks a `floor(LIMIT / buckets)` batch: one ask of 200
    // maximally busy scripts is 200 × 25 = exactly 5,000 rows, which the refusal cannot
    // distinguish from a truncated page. Strict sizing splits it 199 + 1 instead.
    const services = Array.from({ length: 200 }, (_, i) => `acme-crm-${i}`);
    const hourly = Array.from({ length: 25 }, (_, h) => `2026-09-08T${String(h % 24).padStart(2, '0')}:00:00`);
    const asked = stub((scripts) =>
      answer(
        (scripts ?? []).flatMap((s) => hourly.map((datetimeHour) => ({ scriptName: s, datetimeHour, requests: 1, errors: 0 }))),
      ),
    );
    const rows = await reader().serviceMetricsSeries!({ hours: 24, services });
    expect(asked.map((a) => (a ?? []).length)).toEqual([199, 1]);
    // No page reached the ceiling, so nothing was refused and every row came back.
    expect(rows).toHaveLength(5000);
  });

  it('refuses a saturated answer rather than returning a prefix the caller would zero-fill', async () => {
    // The fleet-wide ask (no services) cannot be batched, so the ceiling is all that
    // stands between a truncated prefix and a chart showing a fabricated outage.
    stub(() =>
      answer(
        Array.from({ length: 5000 }, (_, i) => ({
          scriptName: `s-${i}`,
          datetimeHour: '2026-09-08T11:00:00',
          requests: 1,
          errors: 0,
        })),
      ),
    );
    await expect(reader().serviceMetricsSeries!({ hours: 24 })).rejects.toThrow(/saturated/);
  });

  it('asks once, for every script, when no service list narrows it', async () => {
    const asked = stub(() => answer([{ scriptName: 'acme-crm', datetimeHour: '2026-09-08T11:00:00', requests: 7, errors: 1 }]));
    const rows = await reader().serviceMetricsSeries!({ hours: 24 });
    expect(asked).toEqual([null]);
    expect(rows).toEqual([
      {
        service: 'acme-crm',
        namespace: 'verticals',
        start: '2026-09-08T11:00:00Z',
        bucketMinutes: 60,
        requests: 7,
        errors: 1,
      },
    ]);
  });
});
