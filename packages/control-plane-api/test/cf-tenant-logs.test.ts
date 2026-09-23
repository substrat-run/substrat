import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { createCfObservabilityReader } from '../src/cf-observability.js';

/**
 * The tenant-grain reader against a faked Cloudflare, pinning the three behaviours that
 * are invisible in the shape of the code and were each a defect first.
 *
 * The backend is stubbed at `fetch` rather than mocked at a seam, because what is being
 * asserted IS the request: which filters phase one sends decides whether an error read
 * searches the right set of invocations at all.
 */

/** A stamped invocation line as Workers Logs returns it — pure JSON, so NO $metadata.message. */
const invocation = (over: Record<string, unknown> = {}, id = '01EV') => ({
  timestamp: 1000,
  source: {
    substrat: 'invocation',
    tenantId: '01TENANT',
    scopeId: '01SCOPE',
    vertical: 'acme/widgets',
    method: 'POST',
    path: '/api/orders',
    status: 200,
    threw: false,
    durationMs: 42,
    ...over,
  },
  $metadata: { id, requestId: `req-${id}`, service: 'acme-widgets' },
});

/** A line the vertical's own code wrote — it HAS a level and a message, and no tenant. */
const ownLine = (level: string, message: string, requestId: string, id: string) => ({
  timestamp: 1001,
  source: { level, message },
  $metadata: { id, requestId, level, message, service: 'acme-widgets' },
});

function readerOver(handler: (filters: Array<Record<string, unknown>>, limit: number) => unknown[]) {
  const sent: Array<Array<Record<string, unknown>>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const filters = body.parameters.filters as Array<Record<string, unknown>>;
      sent.push(filters);
      return new Response(JSON.stringify({ success: true, result: { events: { events: handler(filters, body.limit as number) } } }), {
        status: 200,
      });
    }),
  );
  return {
    reader: createCfObservabilityReader({ accountId: 'acct', apiToken: 't', routerDataset: 'substrat_router_test' }),
    sent,
  };
}

const keyed = (filters: Array<Record<string, unknown>>, key: string) => filters.find((f) => f['key'] === key);

describe('cf tenant logs', () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * A stamped line arrives with `message: null`, because Cloudflare populates
   * `$metadata.message` for a string log and leaves it unset for a pure JSON one. One is
   * written per request, so without this the default view is a page of blank rows.
   */
  it('gives a stamped line a readable message composed from its own fields', async () => {
    const { reader } = readerOver((f) => (keyed(f, 'substrat') ? [invocation()] : []));
    const events = await reader.tenantLogs!({ tenantId: '01TENANT', hours: 24, limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toBe('POST /api/orders → 200 (42 ms)');
    expect(events[0]!.level).toBe('info');
  });

  it('reads a throw as an error row, not a blank one', async () => {
    const { reader } = readerOver((f) =>
      keyed(f, 'substrat') ? [invocation({ status: null, threw: true })] : [],
    );
    const events = await reader.tenantLogs!({ tenantId: '01TENANT', hours: 24, limit: 10 });
    expect(events[0]!.message).toBe('POST /api/orders → threw (42 ms)');
    expect(events[0]!.level).toBe('error');
  });

  /**
   * THE defect this suite exists for. Stamped lines have no level, so a level filter drops
   * them all and an error can only arrive as a sibling — and siblings exist only for the
   * invocations phase two expanded (40). Asking for errors over 24h would then search the
   * 40 most RECENT invocations and answer "none" if the error was the 41st: an empty page
   * that reads as "nothing is wrong" and means "I did not look". Narrowing phase one to
   * failures makes those 40 the 40 most recent FAILURES instead.
   */
  it('narrows phase one to failing invocations when asked for errors', async () => {
    const { reader, sent } = readerOver(() => []);
    await reader.tenantLogs!({ tenantId: '01TENANT', level: 'error', hours: 24, limit: 10 });
    const statuses = sent.filter((f) => keyed(f, 'status')).map((f) => keyed(f, 'status'));
    expect(statuses).toEqual([
      { key: 'status', operation: 'eq', type: 'number', value: 500 },
      { key: 'status', operation: 'gte', type: 'number', value: 502 },
    ]);
  });

  /**
   * #1345: a 501 is a declared-absent capability — the vertical answering "this version has
   * no owner-seat hook" to a dashboard that asks on render. Correct behaviour, so it is
   * labelled rather than coloured as a failure, and rather than hidden: the line is the
   * evidence that something is asking at all.
   */
  it('labels a 501 as an absent capability, at info, instead of an error row', async () => {
    const { reader } = readerOver((f) =>
      keyed(f, 'substrat') ? [invocation({ method: 'GET', path: '/internal/owner-seat', status: 501, durationMs: 3 })] : [],
    );
    const events = await reader.tenantLogs!({ tenantId: '01TENANT', hours: 24, limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toBe('GET /internal/owner-seat → 501 capability absent (3 ms)');
    expect(events[0]!.level).toBe('info');
  });

  it('still reads a 500 as an error row', async () => {
    const { reader } = readerOver((f) => (keyed(f, 'substrat') ? [invocation({ status: 500 })] : []));
    const events = await reader.tenantLogs!({ tenantId: '01TENANT', hours: 24, limit: 10 });
    expect(events[0]!.message).toBe('POST /api/orders → 500 (42 ms)');
    expect(events[0]!.level).toBe('error');
  });

  it('reads a thrown invocation as an error even where a 501 status is present', async () => {
    const { reader } = readerOver((f) =>
      keyed(f, 'substrat') ? [invocation({ status: 501, threw: true })] : [],
    );
    const events = await reader.tenantLogs!({ tenantId: '01TENANT', hours: 24, limit: 10 });
    expect(events[0]!.message).toBe('POST /api/orders → threw (42 ms)');
    expect(events[0]!.level).toBe('error');
  });

  it('keeps a 501 out of an error read', async () => {
    // Whatever phase one is asked, a 501 that reaches the merge is not an error row.
    const { reader } = readerOver((f) => (keyed(f, 'substrat') ? [invocation({ status: 501 })] : []));
    const events = await reader.tenantLogs!({ tenantId: '01TENANT', level: 'error', hours: 24, limit: 10 });
    expect(events).toEqual([]);
  });

  /**
   * An escape — the error got past `onError` — carries `threw: true` and `status: null`,
   * which `status >= 500` can never match. Selecting on the status ALONE dropped the
   * rarest and most interesting failure a vertical has from the one view that exists to
   * find it.
   */
  it('also selects invocations that escaped the envelope, which carry no status', async () => {
    const { reader, sent } = readerOver(() => []);
    await reader.tenantLogs!({ tenantId: '01TENANT', level: 'error', hours: 24, limit: 10 });
    const escapes = sent.find((f) => keyed(f, 'threw'));
    expect(escapes).toBeDefined();
    expect(keyed(escapes!, 'threw')).toEqual({ key: 'threw', operation: 'eq', type: 'boolean', value: true });
    // Still the tenant's own — an escape query that forgot the tenant is a fleet read.
    expect(keyed(escapes!, 'tenantId')).toMatchObject({ value: '01TENANT' });
  });

  /**
   * The failure queries are separate pages, and the correlation cap (40) is spent in the
   * order their invocations are listed. Page order would let a busy `= 500` page spend it
   * all on old failures and never expand a newer 502 or escape.
   */
  it('spends the correlation budget on the newest failures across every failure page', async () => {
    const old500s = Array.from({ length: 45 }, (_, i) =>
      invocation({ status: 500 }, `01OLD${String(i).padStart(2, '0')}`),
    ).map((e, i) => ({ ...e, timestamp: 100 + i }));
    const { reader, sent } = readerOver((f) => {
      const status = keyed(f, 'status');
      if (status?.['operation'] === 'eq') return old500s;
      if (status?.['operation'] === 'gte') return [{ ...invocation({ status: 502 }, '01NEW502'), timestamp: 5000 }];
      if (keyed(f, 'threw')) return [{ ...invocation({ status: null, threw: true }, '01NEWESC'), timestamp: 4000 }];
      return [];
    });
    await reader.tenantLogs!({ tenantId: '01TENANT', level: 'error', hours: 24, limit: 100 });
    const expanded = sent.map((f) => keyed(f, '$metadata.requestId')?.['value']).filter(Boolean);
    expect(expanded).toContain('req-01NEW502');
    expect(expanded).toContain('req-01NEWESC');
    expect(expanded).toHaveLength(40);
  });

  it('does not narrow to failures for any other level', async () => {
    const { reader, sent } = readerOver(() => []);
    await reader.tenantLogs!({ tenantId: '01TENANT', level: 'info', hours: 24, limit: 10 });
    expect(sent.some((f) => keyed(f, 'status') || keyed(f, 'threw'))).toBe(false);
  });

  /**
   * The third shape of "an error": a `console.error` written during a request that went
   * on to answer 200. Its stamped line says 200, so no tenant-filtered failure query
   * selects that invocation — the line is reachable only by searching error-level lines
   * account-wide and then proving the invocation was this tenant's.
   */
  it('finds an error logged by a request that still succeeded', async () => {
    const { reader } = readerOver((f) => {
      if (keyed(f, 'status') || keyed(f, 'threw')) return []; // no failed invocations at all
      if (keyed(f, '$metadata.level')) return [ownLine('error', 'charge declined', 'req-01OK', '01ERR')];
      if (keyed(f, '$metadata.requestId')) {
        return [invocation({ status: 200 }, '01OK'), ownLine('error', 'charge declined', 'req-01OK', '01ERR')];
      }
      return [];
    });
    const events = await reader.tenantLogs!({ tenantId: '01TENANT', level: 'error', hours: 24, limit: 10 });
    expect(events.map((e) => e.message)).toContain('charge declined');
  });

  /**
   * …and the isolation half of that: an error-level line found account-wide belongs to
   * whoever ran the invocation, which the stamped line is the only proof of. A line whose
   * invocation carries ANOTHER tenant's stamp is dropped whole — showing it here is
   * precisely the leak the tenant grain exists to prevent.
   */
  it('refuses an account-wide error line whose invocation is another tenant’s', async () => {
    const { reader } = readerOver((f) => {
      if (keyed(f, 'status') || keyed(f, 'threw')) return [];
      if (keyed(f, '$metadata.level')) return [ownLine('error', 'someone else’s crash', 'req-01FOREIGN', '01X')];
      if (keyed(f, '$metadata.requestId')) {
        return [
          invocation({ tenantId: '01OTHER', status: 500 }, '01FOREIGN'),
          ownLine('error', 'someone else’s crash', 'req-01FOREIGN', '01X'),
        ];
      }
      return [];
    });
    const events = await reader.tenantLogs!({ tenantId: '01TENANT', level: 'error', hours: 24, limit: 10 });
    expect(events).toEqual([]);
  });

  /** Same refusal for a line correlated to an invocation with no stamp at all. */
  it('refuses an account-wide error line with no stamped invocation behind it', async () => {
    const { reader } = readerOver((f) => {
      if (keyed(f, 'status') || keyed(f, 'threw')) return [];
      if (keyed(f, '$metadata.level')) return [ownLine('error', 'a platform worker’s crash', 'req-01NONE', '01Y')];
      if (keyed(f, '$metadata.requestId')) return [ownLine('error', 'a platform worker’s crash', 'req-01NONE', '01Y')];
      return [];
    });
    const events = await reader.tenantLogs!({ tenantId: '01TENANT', level: 'error', hours: 24, limit: 10 });
    expect(events).toEqual([]);
  });

  /**
   * A failing invocation that wrote no console.error of its own must still appear under an
   * error filter — phase one selected it BECAUSE it failed, and the stamped line is the
   * record of that failure.
   */
  it('keeps a failed invocation under an error filter even with no error line of its own', async () => {
    const { reader } = readerOver((f) =>
      keyed(f, 'substrat') ? [invocation({ status: 500 })] : [], // phase two finds nothing
    );
    const events = await reader.tenantLogs!({ tenantId: '01TENANT', level: 'error', hours: 24, limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toContain('→ 500');
  });

  /**
   * The correlation contract: a vertical's own output carries no tenant, and is reachable
   * only through the invocation the stamped line names.
   */
  it('attributes the vertical’s own unstamped lines via the shared request id', async () => {
    const { reader } = readerOver((f) =>
      keyed(f, 'substrat')
        ? [invocation({ status: 500 })]
        : [ownLine('error', 'TypeError: undefined is not a function', 'req-01EV', '01SIB')],
    );
    const events = await reader.tenantLogs!({ tenantId: '01TENANT', level: 'error', hours: 24, limit: 10 });
    const messages = events.map((e) => e.message);
    expect(messages).toContain('TypeError: undefined is not a function');
    // Both the failure record and the exception behind it — that pairing is the feature.
    expect(messages).toContain('POST /api/orders → 500 (42 ms)');
  });

  /** The router's own access log is every vertical this tenant runs — not this app's logs. */
  it('drops the router’s own lines from an app’s log view', async () => {
    const { reader } = readerOver((f) =>
      keyed(f, 'substrat')
        ? [invocation()]
        : [{ timestamp: 1002, source: { router: 'request', tenantId: '01TENANT' }, $metadata: { id: '01RTR', requestId: 'req-01EV' } }],
    );
    const events = await reader.tenantLogs!({ tenantId: '01TENANT', hours: 24, limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]!.message).toContain('/api/orders');
  });

  it('always binds the tenant, and passes within-tenant narrowing through', async () => {
    const { reader, sent } = readerOver(() => []);
    await reader.tenantLogs!({ tenantId: '01TENANT', scopeId: '01SCOPE', hours: 24, limit: 10 });
    expect(keyed(sent[0]!, 'tenantId')).toMatchObject({ value: '01TENANT', operation: 'eq' });
    expect(keyed(sent[0]!, 'scopeId')).toMatchObject({ value: '01SCOPE', operation: 'eq' });
  });
});

/**
 * The window the read searches (#1447 step 3c) — the chart's time cursor asks about
 * minutes in the PAST, which `hours` alone cannot name.
 *
 * Asserted on the request body rather than the answer, for the reason the suite above
 * gives: what decides whether a cursor read finds anything is the timeframe the backend
 * was handed, and every phase must be handed the SAME one. A phase that re-anchored to
 * its own `Date.now()` would search a window shifted by however long the phase before it
 * took, and a sibling line near the edge would simply not be there.
 */
describe('cf tenant logs — the searched window', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** `readerOver`'s twin, keeping the WHOLE body: the timeframe is what is being read. */
  function bodiesOver(handler: (filters: Array<Record<string, unknown>>) => unknown[]) {
    const bodies: Array<{ timeframe: { from: number; to: number }; parameters: { filters: Array<Record<string, unknown>> } }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        return new Response(
          JSON.stringify({ success: true, result: { events: { events: handler(body.parameters.filters) } } }),
          { status: 200 },
        );
      }),
    );
    return {
      reader: createCfObservabilityReader({ accountId: 'acct', apiToken: 't', routerDataset: 'substrat_router_test' }),
      bodies,
    };
  }

  const SINCE = '2026-09-13T10:00:00.000Z';
  const UNTIL = '2026-09-13T10:10:00.000Z';

  it('sends the cursor’s window on every phase, not only the first', async () => {
    // An error read is the widest fan-out this reader has: three phase-one queries plus
    // one per correlated invocation. Every one of them is checked, because the bug this
    // pins is a later phase quietly using a different window.
    const { reader, bodies } = bodiesOver((f) => (keyed(f, 'status') ? [invocation({ status: 500 })] : []));
    await reader.tenantLogs!({
      tenantId: '01TENANT',
      level: 'error',
      hours: 24,
      since: SINCE,
      until: UNTIL,
      limit: 10,
    });
    // Three phase-one queries and at least one phase-two expansion actually happened —
    // otherwise "every body agrees" would be a claim about one body.
    expect(bodies.length).toBeGreaterThanOrEqual(4);
    expect(bodies.some((b) => keyed(b.parameters.filters, '$metadata.requestId'))).toBe(true);
    for (const b of bodies) {
      expect(b.timeframe).toEqual({ from: Date.parse(SINCE), to: Date.parse(UNTIL) });
    }
  });

  it('falls back to the trailing window when neither instant is given', async () => {
    const { reader, bodies } = bodiesOver(() => []);
    const before = Date.now();
    await reader.tenantLogs!({ tenantId: '01TENANT', hours: 6, limit: 10 });
    const after = Date.now();
    const { from, to } = bodies[0]!.timeframe;
    expect(to).toBeGreaterThanOrEqual(before);
    expect(to).toBeLessThanOrEqual(after);
    expect(from).toBe(to - 6 * 3_600_000);
  });

  it('anchors `hours` to `until` when only the upper bound is given', async () => {
    const { reader, bodies } = bodiesOver(() => []);
    await reader.tenantLogs!({ tenantId: '01TENANT', hours: 3, until: UNTIL, limit: 10 });
    expect(bodies[0]!.timeframe).toEqual({ from: Date.parse(UNTIL) - 3 * 3_600_000, to: Date.parse(UNTIL) });
  });
});

describe('cf tenant metrics', () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * Analytics Engine head-samples and reports each surviving row's weight. `count()` would
   * undercount a busy tenant by the sampling factor — silently, and in the flattering
   * direction — so the SQL must weight by `_sample_interval` everywhere it aggregates.
   */
  it('weights every aggregate by the sampling interval', async () => {
    let sql = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        sql = init.body;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }),
    );
    const reader = createCfObservabilityReader({
      accountId: 'acct',
      apiToken: 't',
      routerDataset: 'substrat_router_test',
    });
    await reader.tenantMetrics!({ tenantId: '01TENANT', hours: 24 });
    expect(sql).toContain('sum(_sample_interval)');
    expect(sql).toContain('quantileWeighted(0.5)(double1, _sample_interval)');
    expect(sql).not.toMatch(/\bcount\(\)/);
    // The tenant predicate is not optional — it is the entire isolation boundary.
    expect(sql).toContain("index1 = '01TENANT'");
  });

  /**
   * The environments write to DIFFERENT router datasets, and a hard-coded name meant a
   * TEST control plane answering questions about production traffic — a query that
   * succeeds, with somebody else's numbers in it (the same class of silent inheritance
   * as #962's dispatch namespace).
   */
  it('reads the dataset it was given, not a hard-coded one', async () => {
    let sql = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        sql = init.body;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }),
    );
    const reader = createCfObservabilityReader({
      accountId: 'acct',
      apiToken: 't',
      routerDataset: 'substrat_router_test',
    });
    await reader.tenantMetrics!({ tenantId: '01TENANT', hours: 24 });
    expect(sql).toContain('FROM substrat_router_test');
    expect(sql).not.toContain('FROM substrat_router\n');
  });

  /** No dataset ⇒ no capability, so the route 501s rather than inventing a source. */
  it('exposes no tenant metrics at all when no dataset was named', () => {
    const reader = createCfObservabilityReader({ accountId: 'acct', apiToken: 't' });
    expect(reader.tenantMetrics).toBeUndefined();
    // The log half needs no dataset — it reads Workers Logs — and stays available.
    expect(reader.tenantLogs).toBeTypeOf('function');
  });

  /** The name is an identifier spliced into SQL, so anything but a bare name is refused. */
  it('refuses a dataset name that is not a bare identifier', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const reader = createCfObservabilityReader({
      accountId: 'acct',
      apiToken: 't',
      routerDataset: 'substrat_router WHERE 1=1 --',
    });
    await expect(reader.tenantMetrics!({ tenantId: '01TENANT', hours: 24 })).rejects.toThrow(/bare identifier/);
  });

  /** A value that is not id-shaped never reaches a query built by string concatenation. */
  it('refuses a dimension value that could not be an id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const reader = createCfObservabilityReader({
      accountId: 'acct',
      apiToken: 't',
      routerDataset: 'substrat_router_test',
    });
    await expect(
      reader.tenantMetrics!({ tenantId: "01T' OR 1=1 --", hours: 24 }),
    ).rejects.toThrow(/unexpected characters/);
  });

  /**
   * The traffic chart's status-class split (#1693): `blob4` names every class the
   * router can stamp, so the aggregate sums each of 2xx/3xx/4xx the same way it
   * already sums 5xx into `errors` — weighted by `_sample_interval`, never `count()`.
   */
  it('sums every status class, weighted the same way `errors` already is', async () => {
    let sql = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        sql = init.body;
        return new Response(
          JSON.stringify({
            data: [
              {
                scopeId: '01SCOPE',
                vertical: 'callout',
                surface: 'api',
                requests: '130',
                errors: '5',
                class2xx: '100',
                class3xx: '20',
                class4xx: '5',
                durationP50: 12,
                durationP95: 40,
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const reader = createCfObservabilityReader({
      accountId: 'acct',
      apiToken: 't',
      routerDataset: 'substrat_router_test',
    });
    const rows = await reader.tenantMetrics!({ tenantId: '01TENANT', hours: 24 });

    for (const cls of ['2xx', '3xx', '4xx']) {
      expect(sql).toContain(`sum(if(blob4 = '${cls}', _sample_interval, 0))`);
    }
    expect(rows[0]).toMatchObject({ class2xx: 100, class3xx: 20, class4xx: 5, errors: 5, requests: 130 });
    // Every class the fixture named accounts for the whole bucket — the stacked bar's
    // total must equal `requests`, or the chart draws a bar shorter than its own axis.
    expect(rows[0]!.class2xx! + rows[0]!.class3xx! + rows[0]!.class4xx! + rows[0]!.errors).toBe(rows[0]!.requests);
  });
});

/**
 * The bucketed twin (#1447). It reads the SAME dataset as the aggregate — the tenant
 * dimension exists nowhere else — so what is worth pinning is that it inherits every
 * guard the aggregate has (forced tenant, sampling weights, identifier and literal
 * whitelists), buckets at the widths the script-grain series uses, and refuses a
 * saturated page rather than handing back a prefix a chart would draw as an outage.
 */
describe('cf tenant metrics series', () => {
  afterEach(() => vi.unstubAllGlobals());

  const reader = () =>
    createCfObservabilityReader({ accountId: 'acct', apiToken: 't', routerDataset: 'substrat_router_test' });

  /** Stub the AE SQL endpoint, capturing the SQL and answering with the given rows. */
  function stubSql(rows: Array<Record<string, unknown>>) {
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        sent.push(init.body);
        return new Response(JSON.stringify({ data: rows }), { status: 200 });
      }),
    );
    return sent;
  }

  it('rides the dataset switch: absent with no dataset, present beside the aggregate with one', () => {
    expect(createCfObservabilityReader({ accountId: 'acct', apiToken: 't' }).tenantMetricsSeries).toBeUndefined();
    expect(reader().tenantMetricsSeries).toBeTypeOf('function');
  });

  it('forces the tenant, narrows to the scope list, weights by the sample interval, and buckets by the window', async () => {
    const sent = stubSql([]);
    await reader().tenantMetricsSeries!({ tenantId: '01TENANT', scopeIds: ['01SCOPE', '01OTHER'], hours: 24 });
    const sql = sent[0]!;
    expect(sql).toContain("index1 = '01TENANT'");
    expect(sql).toContain("blob2 IN ('01SCOPE', '01OTHER')");
    expect(sql).toContain('sum(_sample_interval)');
    expect(sql).not.toMatch(/\bcount\(\)/);
    // Latency per bucket, weighted like the counts — `quantile()` would count each
    // surviving row once however many requests it stood for.
    expect(sql).toContain('quantileWeighted(0.5)(double1, _sample_interval)');
    expect(sql).toContain('quantileWeighted(0.95)(double1, _sample_interval)');
    expect(sql).not.toMatch(/\bquantile\(/);
    expect(sql).toContain("toStartOfInterval(timestamp, INTERVAL '60' MINUTE)");
    expect(sql).toContain('FROM substrat_router_test');
    // The traffic chart's status-class split (#1693) — same weight, per bucket.
    for (const cls of ['2xx', '3xx', '4xx']) {
      expect(sql).toContain(`sum(if(blob4 = '${cls}', _sample_interval, 0))`);
    }

    await reader().tenantMetricsSeries!({ tenantId: '01TENANT', scopeIds: ['01SCOPE'], hours: 6 });
    expect(sent[1]).toContain("toStartOfInterval(timestamp, INTERVAL '15' MINUTE)");
  });

  it('sums every status class per bucket, weighted, so the stacked total equals requests (#1693)', async () => {
    stubSql([
      {
        scopeId: '01SCOPE',
        start: '2026-09-13 10:00:00',
        requests: '130',
        errors: '5',
        class2xx: '100',
        class3xx: '20',
        class4xx: '5',
        durationP50: 12,
        durationP95: 40,
      },
    ]);
    const rows = await reader().tenantMetricsSeries!({ tenantId: '01TENANT', scopeIds: ['01SCOPE'], hours: 1 });
    expect(rows[0]).toMatchObject({ class2xx: 100, class3xx: 20, class4xx: 5, errors: 5, requests: 130 });
    expect(rows[0]!.class2xx! + rows[0]!.class3xx! + rows[0]!.class4xx! + rows[0]!.errors).toBe(rows[0]!.requests);
  });

  it('projects AE rows into ISO-instant buckets, sums as strings included', async () => {
    stubSql([
      { scopeId: '01SCOPE', start: '2026-09-13 10:00:00', requests: '40', errors: '2', durationP50: '12.5', durationP95: 80 },
      { scopeId: '01SCOPE', start: '2026-09-13T11:00:00Z', requests: 7, errors: 0, durationP50: 9, durationP95: '31' },
      // A row with no instant cannot be placed on an axis and is dropped, not invented.
      { scopeId: '01SCOPE', start: null, requests: '1', errors: '0', durationP50: 1, durationP95: 1 },
    ]);
    const rows = await reader().tenantMetricsSeries!({ tenantId: '01TENANT', scopeIds: ['01SCOPE'], hours: 24 });
    expect(rows).toEqual([
      {
        scopeId: '01SCOPE',
        start: '2026-09-13T10:00:00Z',
        bucketMinutes: 60,
        requests: 40,
        errors: 2,
        // Absent from the stubbed AE row, same as `errors` would be if unstubbed —
        // `aeNum` defaults a missing column to 0 rather than leaving it undefined.
        class2xx: 0,
        class3xx: 0,
        class4xx: 0,
        durationP50: 12.5,
        durationP95: 80,
      },
      {
        scopeId: '01SCOPE',
        start: '2026-09-13T11:00:00Z',
        bucketMinutes: 60,
        requests: 7,
        errors: 0,
        class2xx: 0,
        class3xx: 0,
        class4xx: 0,
        durationP50: 9,
        durationP95: 31,
      },
    ]);
  });

  it('answers an empty scope list with no rows and no query — never a widening', async () => {
    const sent = stubSql([{ scopeId: 'X', start: '2026-09-13 10:00:00', requests: '1', errors: '0' }]);
    expect(await reader().tenantMetricsSeries!({ tenantId: '01TENANT', scopeIds: [], hours: 24 })).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('refuses a saturated page rather than returning a prefix a chart would zero-fill', async () => {
    stubSql(
      Array.from({ length: 5000 }, (_, i) => ({
        scopeId: '01SCOPE',
        start: `2026-09-13 10:${String(i % 60).padStart(2, '0')}:00`,
        requests: '1',
        errors: '0',
      })),
    );
    await expect(
      reader().tenantMetricsSeries!({ tenantId: '01TENANT', scopeIds: ['01SCOPE'], hours: 24 }),
    ).rejects.toThrow(/saturated/);
  });

  it('applies the same whitelists as the aggregate to the tenant and every scope', async () => {
    stubSql([]);
    await expect(
      reader().tenantMetricsSeries!({ tenantId: "01T' OR 1=1 --", scopeIds: ['01SCOPE'], hours: 24 }),
    ).rejects.toThrow(/unexpected characters/);
    await expect(
      reader().tenantMetricsSeries!({ tenantId: '01TENANT', scopeIds: ['01SCOPE', "x') OR ('1'='1"], hours: 24 }),
    ).rejects.toThrow(/unexpected characters/);
    const bad = createCfObservabilityReader({ accountId: 'acct', apiToken: 't', routerDataset: 'x; DROP TABLE y' });
    await expect(bad.tenantMetricsSeries!({ tenantId: '01TENANT', scopeIds: ['01SCOPE'], hours: 24 })).rejects.toThrow(
      /bare identifier/,
    );
  });
});

/**
 * One call's lines (#1525).
 *
 * The backend here is a corpus that EVALUATES the filters it is sent, rather than a stub
 * that answers by key: the property is "an id from another tenant returns nothing", and a
 * stub that hands back a canned line whenever it sees `invocationId` would pass whether
 * or not the tenant filter was there. Two tenants share the corpus, so a filter that
 * dropped `tenantId` would visibly return the other one's line.
 */
describe('cf tenant logs — filtered to one invocation', () => {
  afterEach(() => vi.unstubAllGlobals());

  const OURS = '01TENANT';
  const THEIRS = '01OTHERTENANT';
  const A1 = '01AAAAAAAAAAAAAAAAAAAAAAA1'; // ours, answered 200 and logged an error on the way
  const A2 = '01AAAAAAAAAAAAAAAAAAAAAAA2'; // ours, answered 500
  const B1 = '01BBBBBBBBBBBBBBBBBBBBBBB1'; // THEIRS

  const stamped = (tenant: string, invocationId: string, status: number, requestId: string) => ({
    timestamp: 1000,
    source: {
      substrat: 'invocation',
      tenantId: tenant,
      scopeId: '01SCOPE',
      vertical: 'acme/widgets',
      method: 'POST',
      path: '/api/orders',
      invocationId,
      status,
      threw: false,
      durationMs: 42,
    },
    $metadata: { id: `stamp-${invocationId}`, requestId, service: 'acme-widgets' },
  });
  const CORPUS = [
    stamped(OURS, A1, 200, 'req-A1'),
    ownLine('error', 'charge declined', 'req-A1', 'own-A1'),
    stamped(OURS, A2, 500, 'req-A2'),
    stamped(THEIRS, B1, 200, 'req-B1'),
    ownLine('warn', 'their private detail', 'req-B1', 'own-B1'),
  ];

  /** Resolve a filter key the way the log platform does: `$metadata.x` is metadata, the rest is the JSON body. */
  const valueAt = (e: Record<string, any>, key: string): unknown =>
    key.startsWith('$metadata.') ? e['$metadata']?.[key.slice('$metadata.'.length)] : e['source']?.[key];
  const matches = (filters: Array<Record<string, unknown>>, e: Record<string, any>) =>
    filters.every((f) => {
      const v = valueAt(e, f['key'] as string);
      if (f['operation'] === 'eq') return v === f['value'];
      if (f['operation'] === 'gte') return typeof v === 'number' && v >= (f['value'] as number);
      return false;
    });

  const messages = (events: Array<{ message: string | null }>) => events.map((e) => e.message).sort();

  it('returns a call of the caller’s own tenant, with the lines its handler wrote', async () => {
    const { reader } = readerOver((f) => CORPUS.filter((e) => matches(f, e)));
    const events = await reader.tenantLogs!({ tenantId: OURS, invocationId: A1, hours: 24, limit: 50 });
    expect(events.find((e) => e.invocationId === A1)).toMatchObject({ invocationId: A1, requestId: 'req-A1' });
    expect(messages(events)).toEqual(['POST /api/orders → 200 (42 ms)', 'charge declined']);
  });

  // The boundary. Positive twin above; this is the leak it guards.
  it('returns NOTHING for an invocation id that belongs to another tenant', async () => {
    const { reader, sent } = readerOver((f) => CORPUS.filter((e) => matches(f, e)));
    const events = await reader.tenantLogs!({ tenantId: OURS, invocationId: B1, hours: 24, limit: 50 });
    expect(events).toEqual([]);
    // Nothing of theirs was even fetched: with no stamped line of ours there is no
    // request id to expand, so phase two never runs.
    expect(sent.some((f) => keyed(f, '$metadata.requestId'))).toBe(false);
    // …and every query that went out named OUR tenant.
    for (const f of sent) expect(keyed(f, 'tenantId')).toMatchObject({ value: OURS });
  });

  it('sends the id as an equality beside the tenant’s, on the field the stamped line carries', async () => {
    const { reader, sent } = readerOver(() => []);
    await reader.tenantLogs!({ tenantId: OURS, invocationId: A1, hours: 24, limit: 10 });
    expect(sent).toHaveLength(1);
    expect(keyed(sent[0]!, 'invocationId')).toEqual({ key: 'invocationId', operation: 'eq', type: 'string', value: A1 });
    expect(keyed(sent[0]!, 'tenantId')).toMatchObject({ value: OURS });
    expect(keyed(sent[0]!, 'substrat')).toMatchObject({ value: 'invocation' });
  });

  it('narrows to that one call, though the tenant has others', async () => {
    const { reader } = readerOver((f) => CORPUS.filter((e) => matches(f, e)));
    const events = await reader.tenantLogs!({ tenantId: OURS, invocationId: A2, hours: 24, limit: 50 });
    expect(messages(events)).toEqual(['POST /api/orders → 500 (42 ms)']);
  });

  it('treats an empty id as a filter that matches nothing, never as no filter', async () => {
    const { reader, sent } = readerOver((f) => CORPUS.filter((e) => matches(f, e)));
    const events = await reader.tenantLogs!({ tenantId: OURS, invocationId: '', hours: 24, limit: 50 });
    expect(events).toEqual([]);
    expect(keyed(sent[0]!, 'invocationId')).toMatchObject({ value: '' });
  });

  it('with no id, is unfiltered as before — every call of the tenant, none of the other’s', async () => {
    const { reader, sent } = readerOver((f) => CORPUS.filter((e) => matches(f, e)));
    const events = await reader.tenantLogs!({ tenantId: OURS, hours: 24, limit: 50 });
    expect(messages(events)).toEqual([
      'POST /api/orders → 200 (42 ms)',
      'POST /api/orders → 500 (42 ms)',
      'charge declined',
    ]);
    expect(sent.some((f) => keyed(f, 'invocationId'))).toBe(false);
  });

  /**
   * The error read selects invocations account-wide for its third shape (a `console.error`
   * in a request that answered 200), admitting them by `ownsInvocation` — which judges the
   * TENANT, not the call. Left in place under an id it would answer a one-call filter with
   * every other call of the tenant that logged an error.
   */
  it('does not widen an error read past the one call, and never searches account-wide', async () => {
    const { reader, sent } = readerOver((f) => CORPUS.filter((e) => matches(f, e)));
    const events = await reader.tenantLogs!({ tenantId: OURS, invocationId: A2, level: 'error', hours: 24, limit: 50 });
    expect(messages(events)).toEqual(['POST /api/orders → 500 (42 ms)']);
    expect(sent.some((f) => keyed(f, '$metadata.level'))).toBe(false);
  });

  // A chatty call must not hide its own diagnostic line behind the 20-line share a
  // multi-call page gives each invocation. The fake honours the limit it is sent, as the
  // backend does, so a capped query really does come back short.
  describe('how many lines of one call it reads', () => {
    const chatty = [
      stamped(OURS, A1, 200, 'req-A1'),
      ...Array.from({ length: 45 }, (_, i) => ownLine('log', `line ${i}`, 'req-A1', `chat-${i}`)),
    ];
    const over = () => {
      const limits: number[] = [];
      const made = readerOver((f, limit) => {
        if (keyed(f, '$metadata.requestId')) limits.push(limit);
        return chatty.filter((e) => matches(f, e)).slice(0, limit);
      });
      return { ...made, limits };
    };

    it('reads up to the caller’s limit, past the per-invocation share', async () => {
      const { reader, limits } = over();
      const events = await reader.tenantLogs!({ tenantId: OURS, invocationId: A1, hours: 24, limit: 100 });
      expect(limits).toEqual([100]);
      expect(events).toHaveLength(46); // the stamped line and all 45 of its own
    });

    it('still bounds the merged answer by the limit', async () => {
      const { reader } = over();
      const events = await reader.tenantLogs!({ tenantId: OURS, invocationId: A1, hours: 24, limit: 30 });
      expect(events).toHaveLength(30);
    });

    // The twin: a read that names no call is many calls sharing one budget.
    it('keeps the 20-line share per invocation when no call is named', async () => {
      const { reader, limits } = over();
      await reader.tenantLogs!({ tenantId: OURS, hours: 24, limit: 100 });
      expect(limits).toEqual([20]);
    });
  });

  it('applies the level to the lines of that one call', async () => {
    const { reader } = readerOver((f) => CORPUS.filter((e) => matches(f, e)));
    const events = await reader.tenantLogs!({ tenantId: OURS, invocationId: A1, level: 'error', hours: 24, limit: 50 });
    expect(messages(events)).toEqual(['charge declined']);
  });
});

describe('absolute tenant metrics', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('queries the historic half-open interval at both grains, preserving tenant and scope predicates', async () => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => { sent.push(init.body); return new Response(JSON.stringify({ data: [] })); }));
    const reader = createCfObservabilityReader({ accountId: 'acct', apiToken: 't', routerDataset: 'router_test' });
    const window = { since: '2026-09-01T10:07:00Z', until: '2026-09-01T10:29:00Z' };
    await reader.tenantMetrics!({ tenantId: 'tenant-a', scopeId: 'scope-a', hours: 72, ...window });
    await reader.tenantMetricsSeries!({ tenantId: 'tenant-a', scopeIds: ['scope-a'], hours: 72, ...window });
    for (const sql of sent) {
      expect(sql).toContain("index1 = 'tenant-a'");
      expect(sql).toContain(`timestamp >= toDateTime(${Date.parse(window.since) / 1000})`);
      expect(sql).toContain(`timestamp < toDateTime(${Date.parse(window.until) / 1000})`);
      expect(sql).not.toContain('now()');
    }
    expect(sent[0]).toContain("blob2 = 'scope-a'");
    expect(sent[1]).toContain("blob2 IN ('scope-a')");
    expect(sent[1]).toContain("INTERVAL '15' MINUTE");
  });
});
