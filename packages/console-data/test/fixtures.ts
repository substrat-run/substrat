import type { RequestTrace } from '@substrat-run/contracts';
import {
  blankUnfilled,
  createLocalSource,
  FACET_TOP,
  facetsOf,
  headOf,
  matchesWhere,
  pageOf,
  WORLD_ALL,
  type ConsoleDataSource,
  type ContractHarness,
  type ContractSubject,
  type ContractWorld,
  type RequestField,
  type SourceCapabilities,
  type TraceReader,
} from '../src/index.js';

/** A trace buffer in memory: what #2358's buffer will be to the local source. */
export function memoryBuffer(initial: readonly unknown[] = []): TraceReader & { push(trace: unknown): void } {
  const traces = [...initial];
  const listeners = new Set<(t: unknown) => void>();
  return {
    traces: () => traces,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(trace) {
      traces.push(trace);
      for (const l of listeners) l(trace);
    },
  };
}

/** The local source over a memory buffer holding the world. */
export const localHarness = (options: { tail?: boolean } = {}): ContractHarness => ({
  async create(world: ContractWorld): Promise<ContractSubject> {
    const buffer = memoryBuffer(world.traces);
    const source = createLocalSource({
      label: 'tasks',
      artifacts: () => ({ modelJson: world.modelJson, permissionsMd: world.permissionsMd }),
      traces: options.tail === false ? { traces: buffer.traces } : buffer,
    });
    return { source, record: (t) => buffer.push(t) };
  },
});

/** What a hosted record fills by default: the head, less who the call ran as and the spec version. */
const HEAD_ONLY_FIELDS: readonly RequestField[] = [
  'invocationId',
  'startedAt',
  'tenantId',
  'scopeId',
  'vertical',
  'surface',
  'method',
  'path',
  'status',
  'threw',
  'durationMs',
  'level',
  'operation',
  'problemCode',
  'principalKind',
  'eventCount',
  'eventTypes',
  'entities',
  'versionId',
];

/**
 * A tiny source in the shape a hosted one will have: heads only, estimated counts, no tail,
 * no artifacts. Honest about all of it, so it passes the suite with less than the local source.
 */
export function headOnlySource(world: ContractWorld): ConsoleDataSource {
  const capabilities: SourceCapabilities = {
    tail: false,
    rawPayloads: false,
    exactFacetCounts: false,
    traceSteps: false,
    model: false,
    permissions: false,
    requestFields: HEAD_ONLY_FIELDS,
  };
  const heads = world.traces.map((t) => blankUnfilled(headOf(t), HEAD_ONLY_FIELDS));
  return {
    describe: () => ({ id: 'fixture:head-only', kind: 'hosted', label: 'head-only fixture', capabilities }),
    artifacts: async () => ({ model: null, permissions: null }),
    queryRequests: async (q) => pageOf(heads, q),
    facets: async (q) => ({ ...facetsOf(heads, q), estimated: true }),
    async getTrace(id) {
      const head = heads.find((h) => h.invocationId === id);
      return head ? { ...head, steps: [], capture: { sqlParams: false, stepsDropped: 0 } } : null;
    },
  };
}

export const headOnlyHarness = (wrap: (s: ConsoleDataSource, world: ContractWorld) => ConsoleDataSource = (s) => s): ContractHarness => ({
  create: async (world) => ({ source: wrap(headOnlySource(world), world) }),
});

/** A source with some of its answers replaced: every other member forwards to the original. */
function lie(source: ConsoleDataSource, over: Partial<ConsoleDataSource>): ConsoleDataSource {
  const forwarded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) forwarded[key] = typeof value === 'function' ? value.bind(source) : value;
  return { ...(forwarded as unknown as ConsoleDataSource), ...over };
}

const declaring = (source: ConsoleDataSource, capabilities: Partial<SourceCapabilities>) => () => {
  const d = source.describe();
  return { ...d, capabilities: { ...d.capabilities, ...capabilities } };
};

const wrapLocal = (wrap: (s: ConsoleDataSource, world: ContractWorld) => ConsoleDataSource, options: { tail?: boolean } = {}): ContractHarness => ({
  async create(world) {
    const subject = await localHarness(options).create(world);
    return { ...subject, source: wrap(subject.source, world) };
  },
});

const rawTrace = (world: ContractWorld, id: string): RequestTrace | null => world.traces.find((t) => t.invocationId === id) ?? null;

/** Sources that each break one promise, and the one check that must catch it. */
export const LIARS: readonly { readonly lie: string; readonly fails: string; readonly harness: ContractHarness }[] = [
  {
    lie: 'declares exact facet counts and answers estimated',
    fails: 'facets.exact-source-never-estimates',
    harness: wrapLocal((s) => lie(s, { facets: async (q) => ({ ...(await s.facets(q)), estimated: true }) })),
  },
  {
    lie: 'answers sampled counts as exact',
    fails: 'facets.counts-exact-unless-estimated',
    harness: headOnlyHarness((s) =>
      lie(s, {
        async facets(q) {
          const f = await s.facets(q);
          const scaled = Object.fromEntries(Object.entries(f.facets).map(([k, vs]) => [k, vs.map((v) => ({ ...v, count: v.count * 2 }))]));
          return { ...f, facets: scaled as unknown as typeof f.facets, total: f.total * 2, estimated: false };
        },
      }),
    ),
  },
  {
    lie: 'lists each facet least frequent first',
    fails: 'facets.order-and-cap',
    harness: wrapLocal((s) =>
      lie(s, {
        async facets(q) {
          const f = await s.facets(q);
          const reversed = Object.fromEntries(Object.entries(f.facets).map(([k, vs]) => [k, [...vs].reverse()]));
          return { ...f, facets: reversed as unknown as typeof f.facets };
        },
      }),
    ),
  },
  {
    lie: 'lists more facet values than the cap',
    fails: 'facets.order-and-cap',
    harness: headOnlyHarness((s) =>
      lie(s, {
        async facets(q) {
          const f = await s.facets(q);
          const padding = Array.from({ length: FACET_TOP + 1 }, (_, i) => ({ value: `zz-${String(i).padStart(2, '0')}`, count: 0 }));
          return { ...f, facets: { ...f.facets, operation: [...f.facets.operation, ...padding] } };
        },
      }),
    ),
  },
  {
    lie: 'hands out bound SQL values without rawPayloads',
    fails: 'traces.raw-payloads',
    harness: wrapLocal((s, world) => lie(s, { getTrace: async (id) => rawTrace(world, id) })),
  },
  {
    lie: 'declares tail and has no tail()',
    fails: 'tail.declared-iff-present',
    harness: wrapLocal((s) => lie(s, { describe: declaring(s, { tail: true }) }), { tail: false }),
  },
  {
    lie: 'declares tail and never delivers',
    fails: 'tail.delivers',
    harness: wrapLocal((s) => lie(s, { tail: () => () => {} })),
  },
  {
    lie: 'tails the whole trace, bound values included, not the head',
    fails: 'tail.delivers',
    harness: {
      async create(world) {
        const buffer = memoryBuffer(world.traces);
        const honest = createLocalSource({
          label: 'tasks',
          artifacts: () => ({ modelJson: world.modelJson, permissionsMd: world.permissionsMd }),
          traces: buffer,
        });
        const source = lie(honest, {
          // Filters as the honest tail does, then hands out the buffered record whole.
          tail: (q, listener) =>
            buffer.subscribe!((raw) => {
              const t = raw as RequestTrace;
              if (matchesWhere(t, q.where)) listener(t);
            }),
        });
        return { source, record: (t) => buffer.push(t) };
      },
    },
  },
  {
    lie: 'returns steps without declaring traceSteps',
    fails: 'traces.steps-match-capability',
    harness: headOnlyHarness((s, world) =>
      lie(s, {
        async getTrace(id) {
          const head = await s.getTrace(id);
          const steps = (rawTrace(world, id)?.steps ?? []).map((step) => (step.type === 'sql' ? { ...step, params: undefined } : step));
          return head && { ...head, steps: steps.map((step) => JSON.parse(JSON.stringify(step))) };
        },
      }),
    ),
  },
  {
    lie: 'ignores the window',
    fails: 'requests.window',
    harness: wrapLocal((s) =>
      lie(s, { queryRequests: (q) => s.queryRequests(q.from <= q.to ? { ...q, from: WORLD_ALL.from, to: WORLD_ALL.to } : q) }),
    ),
  },
  {
    lie: 'fills a field it does not declare',
    fails: 'requests.unfilled-fields-are-blank',
    harness: headOnlyHarness((s, world) =>
      lie(s, {
        async queryRequests(q) {
          const page = await s.queryRequests(q);
          return { ...page, requests: page.requests.map((h) => ({ ...h, principal: rawTrace(world, h.invocationId)?.principal ?? null })) };
        },
      }),
    ),
  },
  {
    lie: 'returns a model without declaring model',
    fails: 'artifacts.match-capability',
    harness: headOnlyHarness((s) =>
      lie(s, { artifacts: async () => ({ model: { entities: {} }, permissions: null }) }),
    ),
  },
];
