import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCfObservabilityReader } from '../src/cf-observability.js';
import { readFieldCoverage } from '../src/field-coverage-read.js';

// The real read, watched: what the field-coverage read hands its tally.
vi.mock('../src/field-coverage-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/field-coverage-read.js')>();
  return { ...actual, readFieldCoverage: vi.fn(actual.readFieldCoverage) };
});

/**
 * RFC wire-signing §8: the platform entry writes one `{ substrat: 'wire' }` line per request it
 * judged, with the refusal's reason on it, sharing the request's id. It is the platform's counter,
 * so no reader may return it: not the tenant-grain view, not the service-grain view a confined
 * principal reads for its own services, not the request list. Every `events` query the faked
 * Cloudflare answers here carries one beside the lines the reader is for.
 */

/** Only the wire line carries this outcome, so finding it anywhere in an answer means the line leaked. */
const LEAKED = 'legacy-accepted';

const wireLine = (requestId: string) => ({
  timestamp: 1003,
  source: {
    substrat: 'wire',
    state: 'dual',
    issuer: 'router',
    kind: 'route',
    outcome: LEAKED,
    reason: 'signature',
    fault: null,
    legacy: 'valid',
    tenantId: '01TENANT',
    scopeId: '01SCOPE',
    versionId: null,
  },
  $metadata: { id: `01WIRE${requestId}`, requestId, service: 'acme-widgets' },
});

const invocation = {
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
    level: 'info',
    invocationId: '01JZ0000000000000000INV001',
  },
  $metadata: { id: '01EV', requestId: 'req-01EV', service: 'acme-widgets' },
};

const ownLine = {
  timestamp: 1001,
  source: { level: 'error', message: 'the vertical’s own line' },
  $metadata: { id: '01OWN', requestId: 'req-01EV', level: 'error', message: 'the vertical’s own line', service: 'acme-widgets' },
};

/** The request's other error lines, older than its stamped line: more than its share of a page holds. */
const chatter = Array.from({ length: 25 }, (_, i) => ({
  timestamp: 900 - i,
  source: { level: 'error', message: `error ${i}` },
  $metadata: { id: `01CHAT${i}`, requestId: 'req-01EV', level: 'error', message: `the vertical’s error ${i}`, service: 'acme-widgets' },
}));

/**
 * Cloudflare as it answers: newest first and at most `limit` lines. A query for one request id is
 * answered with every line of that request; every other `events` query with the wire line, the
 * stamped line and one line of the vertical's own.
 */
function fakedCloudflare() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { view?: string; limit: number; parameters?: { filters?: Array<{ key: string }> } };
      const perRequest = body.parameters?.filters?.some((f) => f.key === '$metadata.requestId');
      const events = (perRequest ? [wireLine('req-01EV'), invocation, ...chatter] : [wireLine('req-01EV'), invocation, ownLine])
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, body.limit);
      const result = body.view === 'events' ? { events: { events } } : { calculations: [] };
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    }),
  );
  return createCfObservabilityReader({ accountId: 'acct', apiToken: 't', routerDataset: 'substrat_router_test' });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(readFieldCoverage).mockClear();
});

describe('no reader returns the platform’s wire line', () => {
  const lines: Array<[string, (reader: ReturnType<typeof fakedCloudflare>) => Promise<unknown[]>]> = [
    ['the fleet view', (r) => r.recentLogs({ hours: 24, limit: 50 })],
    ['the service-grain view of one service', (r) => r.recentLogs({ services: ['acme-widgets'], hours: 24, limit: 50 })],
    ['the service-grain view of several', (r) => r.recentLogs({ services: ['acme-widgets', 'acme-widgets-v2'], hours: 24, limit: 50 })],
    ['the tenant view', (r) => r.tenantLogs!({ tenantId: '01TENANT', hours: 24, limit: 50 })],
    ['the tenant view of one invocation', (r) => r.tenantLogs!({ tenantId: '01TENANT', invocationId: '01JZ0000000000000000INV001', hours: 24, limit: 50 })],
    ['the tenant request list', (r) => r.tenantRequests!({ tenantId: '01TENANT', services: ['acme-widgets'], from: 0, to: 2000, limit: 50 })],
  ];

  it.each(lines)('%s: the lines it is for, and not the wire line', async (_, read) => {
    const answer = await read(fakedCloudflare());
    expect(answer.length).toBeGreaterThan(0);
    expect(JSON.stringify(answer)).not.toContain(LEAKED);
    expect(JSON.stringify(answer)).not.toContain('"wire"');
  });

  // The level filter alone would drop the wire line here (it has no level), so this holds what the
  // line would cost before it: the slot it takes in the request's share of the page.
  it('the tenant view’s error read: every error line the page holds, and none of the wire line', async () => {
    const answer = await fakedCloudflare().tenantLogs!({ tenantId: '01TENANT', level: 'error', hours: 24, limit: 50 });
    // The line phase one found, then the request's own errors that fit beside its stamped line in
    // its 20-line share: 19 of them, as if the wire line had never been written.
    expect(answer.map((e) => e.message)).toEqual(['the vertical’s own line', ...chatter.slice(0, 19).map((l) => l.$metadata.message)]);
    expect(JSON.stringify(answer)).not.toContain(LEAKED);
  });

  // The tally admits only a stamped line, so its report could not show the wire line either way:
  // what is held here is that the tally is never handed one.
  it('the field-coverage read hands the tally it counts with none of it', async () => {
    const report = await fakedCloudflare().fieldCoverage!({
      tenantId: '01TENANT',
      vertical: 'acme/widgets',
      scopeId: '01SCOPE',
      services: ['acme-widgets'],
      hours: 24,
    });
    expect(JSON.stringify(report)).not.toContain(LEAKED);
    const [reports, routerLines] = vi.mocked(readFieldCoverage).mock.calls[0]!;
    // Its twin: the lines it was handed are the reads' own, the stamped line among them.
    expect(JSON.stringify([...reports])).toContain('01JZ0000000000000000INV001');
    expect(JSON.stringify([...reports, ...routerLines])).not.toContain(LEAKED);
  });
});

/**
 * The line is left out after the backend has spent its `limit` on it, so the readers ask again
 * for what it took. This Cloudflare answers as the real one does: newest first, at most `limit`
 * lines, from the window asked for.
 */
describe('a page is as full as it would be without the wire line', () => {
  type Line = { timestamp: number; source: Record<string, unknown>; $metadata: Record<string, unknown> };
  type Query = { view?: string; limit: number; timeframe: { from: number; to: number }; parameters?: { filters?: Array<{ key: string; value: unknown }> } };

  function backend(linesFor: (query: Query) => Line[]) {
    const queries: Query[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const query = JSON.parse(init.body) as Query;
        queries.push(query);
        const service = query.parameters?.filters?.find((f) => f.key === '$metadata.service')?.value;
        const events = linesFor(query)
          .filter((l) => service === undefined || l.$metadata['service'] === service)
          .filter((l) => l.timestamp >= query.timeframe.from && l.timestamp <= query.timeframe.to)
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, query.limit);
        const result = query.view === 'events' ? { events: { events } } : { calculations: [] };
        return new Response(JSON.stringify({ success: true, result }), { status: 200 });
      }),
    );
    return { reader: createCfObservabilityReader({ accountId: 'acct', apiToken: 't' }), queries };
  }

  const line = (timestamp: number, requestId: string, i: number): Line => ({
    timestamp,
    source: { message: `line ${i}` },
    $metadata: { id: `01LINE${requestId}${i}`, requestId, message: `the vertical’s line ${i}`, service: 'acme-widgets' },
  });
  const stamped = (timestamp: number, requestId: string): Line => ({
    ...invocation,
    timestamp,
    source: { ...invocation.source, invocationId: `01JZ00000000000000${requestId.slice(-8)}` },
    $metadata: { ...invocation.$metadata, id: `01STAMP${requestId}`, requestId },
  });
  const wire = (timestamp: number, requestId: string): Line => ({ ...wireLine(requestId), timestamp });
  const asks = (query: Query, key: string) => query.parameters?.filters?.find((f) => f.key === key)?.value;

  describe('the tenant view, one query per request id', () => {
    /** A chatty request: its stamped line first, then 30 lines of its own, then the wire line, newest. */
    const now = Date.now();
    const chatty = (withWire: boolean): Line[] => [
      stamped(now - 100_000, 'req-chatty'),
      ...Array.from({ length: 30 }, (_, i) => line(now - 50_000 + i * 100, 'req-chatty', i)),
      ...(withWire ? [wire(now - 1_000, 'req-chatty')] : []),
    ];
    const read = (withWire: boolean) => {
      const { reader } = backend((query) =>
        asks(query, '$metadata.requestId') === 'req-chatty' ? chatty(withWire)
        : asks(query, 'substrat') === 'invocation' ? [stamped(now - 100_000, 'req-chatty')]
        : [],
      );
      return reader.tenantLogs!({ tenantId: '01TENANT', hours: 24, limit: 100 });
    };

    it('shows a request its whole line budget, the wire line’s slot given back', async () => {
      const answer = await read(true);
      // The stamped line, and the 20 newest of the request's own: the per-request budget.
      const own = answer.filter((e) => (e.message ?? '').startsWith('the vertical’s line'));
      expect(own.map((e) => e.message)).toEqual(Array.from({ length: 20 }, (_, i) => `the vertical’s line ${29 - i}`));
      expect(answer).toHaveLength(21);
      expect(JSON.stringify(answer)).not.toContain(LEAKED);
    });

    it('its twin: a request with no wire line shows exactly the same page, and not a line more', async () => {
      expect(await read(false)).toEqual(await read(true));
    });
  });

  describe('the service-grain view, filled from the window before', () => {
    const now = Date.now();
    /** Three lines a request, as `dual` writes them: its own, its stamp and the wire line, 300 requests. */
    const busy = (): Line[] =>
      Array.from({ length: 300 }, (_, r) => {
        const at = now - 10_000_000 + r * 10_000;
        return [line(at, `req-${r}`, r), stamped(at + 1, `req-${r}`), wire(at + 2, `req-${r}`)];
      }).flat();

    it.each([
      ['the fleet view', undefined],
      ['one service', ['acme-widgets']],
    ] as const)('%s: a full page comes back full, newest first, and none of it the wire line', async (_, services) => {
      const lines = busy();
      const { reader, queries } = backend(() => lines);
      const answer = await reader.recentLogs({ services: services ? [...services] : undefined, hours: 24, limit: 100 });
      const expected = lines
        .filter((l) => l.source['substrat'] !== 'wire')
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 100)
        .map((l) => l.timestamp);
      expect(answer.map((e) => e.timestamp)).toEqual(expected);
      expect(JSON.stringify(answer)).not.toContain(LEAKED);
      // One page lost a third of itself to the wire line; the second filled it.
      expect(queries).toHaveLength(2);
    });

    it('a window with less than a page in it is answered whole, in one query', async () => {
      const lines = busy().slice(0, 30);
      const { reader, queries } = backend(() => lines);
      const answer = await reader.recentLogs({ services: ['acme-widgets'], hours: 24, limit: 100 });
      expect(answer).toHaveLength(20);
      expect(queries).toHaveLength(1);
    });

    it('a window of nothing but wire lines costs a bounded number of queries, and answers empty', async () => {
      const lines = Array.from({ length: 1000 }, (_, r) => wire(now - 10_000_000 + r * 1_000, `req-${r}`));
      const { reader, queries } = backend(() => lines);
      expect(await reader.recentLogs({ services: ['acme-widgets'], hours: 24, limit: 50 })).toEqual([]);
      expect(queries).toHaveLength(4);
    });

    describe('across many services', () => {
      const SERVICES = Array.from({ length: 20 }, (_, s) => `acme-widgets-v${s}`);
      /** 200 lines a service, interleaved in time across services, the `i`th of service `s` a wire line when `wire(i, s)`. */
      const fleet = (wire: (i: number, s: number) => boolean): Line[] =>
        SERVICES.flatMap((service, s) =>
          Array.from({ length: 200 }, (_, i): Line => {
            const at = now - 10_000_000 + i * 100 + s;
            const own = !wire(i, s);
            return {
              timestamp: at,
              source: own ? { message: `line ${i}` } : wireLine(`req-${s}-${i}`).source,
              $metadata: { id: `01L${s}x${i}`, requestId: `req-${s}-${i}`, service, message: own ? `${service} line ${i}` : undefined },
            };
          }),
        );
      const truth = (lines: Line[]) =>
        lines
          .filter((l) => l.source['substrat'] !== 'wire')
          .sort((a, b) => b.timestamp - a.timestamp)
          .map((l) => l.timestamp);

      it('a page the services’ first queries already fill costs one query a service, and is the true newest page', async () => {
        // In dual: a third of every page is the wire line.
        const lines = fleet((i) => i % 3 === 2);
        const { reader, queries } = backend(() => lines);
        const answer = await reader.recentLogs({ services: SERVICES, hours: 24, limit: 100 });
        expect(answer.map((e) => e.timestamp)).toEqual(truth(lines).slice(0, 100));
        expect(queries).toHaveLength(SERVICES.length);
      });

      it('fills a short merged page with at most MAX_FILL_QUERIES more queries, and answers a true prefix of the newest page', async () => {
        // Almost every line a wire line, so the first round leaves the merged page short and every
        // service wants more. The 8 read again first (the newest oldest lines, s 19 to 12) reach back
        // to a very old line of their own (i = 1), past the newer ones the 12 left unread still hold
        // (i = 75, 25): an answer that took it would not be the newest page's prefix.
        const lines = fleet((i, s) => (s >= 12 ? i !== 100 && i !== 1 : i % 50 !== 25));
        const { reader, queries } = backend(() => lines);
        const answer = await reader.recentLogs({ services: SERVICES, hours: 24, limit: 100 });
        expect(queries.length).toBe(SERVICES.length + 8);
        expect(answer.length).toBeGreaterThan(0);
        // Whatever was left unread cut the answer short; nothing in it is out of place.
        expect(answer.map((e) => e.timestamp)).toEqual(truth(lines).slice(0, answer.length));
      });
    });

    it('stops once a page is all one instant, which no earlier window can cut', async () => {
      const lines = Array.from({ length: 60 }, (_, r) => (r % 2 ? wire(now - 5_000, `req-${r}`) : line(now - 5_000, `req-${r}`, r)));
      const { reader, queries } = backend(() => lines);
      const answer = await reader.recentLogs({ services: ['acme-widgets'], hours: 24, limit: 50 });
      expect(answer).toHaveLength(25);
      // The second window ends just after that instant and returns the same page; nothing is asked after it.
      expect(queries).toHaveLength(2);
      expect(queries[1]!.timeframe.to).toBe(now - 5_000 + 1);
    });
  });
});
