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

function readerOver(handler: (filters: Array<Record<string, unknown>>) => unknown[]) {
  const sent: Array<Array<Record<string, unknown>>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const filters = body.parameters.filters as Array<Record<string, unknown>>;
      sent.push(filters);
      return new Response(JSON.stringify({ success: true, result: { events: { events: handler(filters) } } }), {
        status: 200,
      });
    }),
  );
  return { reader: createCfObservabilityReader({ accountId: 'acct', apiToken: 't' }), sent };
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
    const phaseOne = sent[0]!;
    expect(keyed(phaseOne, 'status')).toEqual({ key: 'status', operation: 'gte', type: 'number', value: 500 });
  });

  it('does not narrow to failures for any other level', async () => {
    const { reader, sent } = readerOver(() => []);
    await reader.tenantLogs!({ tenantId: '01TENANT', level: 'info', hours: 24, limit: 10 });
    expect(keyed(sent[0]!, 'status')).toBeUndefined();
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
    const reader = createCfObservabilityReader({ accountId: 'acct', apiToken: 't' });
    await reader.tenantMetrics!({ tenantId: '01TENANT', hours: 24 });
    expect(sql).toContain('sum(_sample_interval)');
    expect(sql).toContain('quantileWeighted(0.5)(double1, _sample_interval)');
    expect(sql).not.toMatch(/\bcount\(\)/);
    // The tenant predicate is not optional — it is the entire isolation boundary.
    expect(sql).toContain("index1 = '01TENANT'");
  });

  /** A value that is not id-shaped never reaches a query built by string concatenation. */
  it('refuses a dimension value that could not be an id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const reader = createCfObservabilityReader({ accountId: 'acct', apiToken: 't' });
    await expect(
      reader.tenantMetrics!({ tenantId: "01T' OR 1=1 --", hours: 24 }),
    ).rejects.toThrow(/unexpected characters/);
  });
});
