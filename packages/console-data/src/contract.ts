import {
  invocationLevelOf,
  requestTrace,
  traceHead,
  type RequestTrace,
  type TraceHead,
  type TraceStep,
} from '@substrat-run/contracts';
import { parsePermissions } from '@substrat-run/model-view';
import { blankUnfilled, CAPABILITIES, REQUEST_FIELDS, REQUIRED_REQUEST_FIELDS, unfilledFields, type RequestField, type SourceCapabilities } from './capabilities.js';
import { countFacet, facetValueOf, matching } from './query.js';
import { FACET_KEYS, FACET_TOP, SOURCE_KINDS, type ConsoleDataSource, type RequestQuery } from './source.js';

/**
 * The suite every console data source passes (#2360): local, hosted and external alike.
 *
 * A source is judged against one fixed world ({@link contractWorld}) that its harness loads
 * into whatever the source reads from: the local trace buffer, a hosted store, a mock of an
 * external API. Each capability a source declares is a promise one check below holds it to,
 * and each check has a stable name, so a source that lies about a capability fails a named
 * check rather than "something". A source that declares less passes with less: the checks
 * hold it to what it declared, never to what the local source can do.
 *
 * Framework-free: a check throws {@link ContractViolation}, {@link runContract} collects the
 * outcomes, and {@link registerContract} hands them to vitest's `describe`/`it` (or any
 * runner with that shape) without this package importing one.
 */

export class ContractViolation extends Error {}

/** What a harness loads into a source before the suite reads it. */
export interface ContractWorld {
  readonly traces: readonly RequestTrace[];
  /** A `model.json`, JSON-parsed. */
  readonly modelJson: unknown;
  readonly permissionsMd: string;
}

export interface ContractSubject {
  readonly source: ConsoleDataSource;
  /**
   * Record one more request the way the source's backing store would receive it. Needed by a
   * source that declares `tail`, to prove the tail delivers.
   */
  record?(trace: RequestTrace): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface ContractHarness {
  /** A fresh source holding `world`, as far as its capabilities let it. */
  create(world: ContractWorld): Promise<ContractSubject>;
}

/** The instant the world starts at. */
export const WORLD_T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
/** A window holding some of the world's requests and not others. */
export const WORLD_WINDOW = { from: WORLD_T0 + 5 * MIN, to: WORLD_T0 + 15 * MIN } as const;
/** A window holding every request in the world. */
export const WORLD_ALL = { from: WORLD_T0 - 86_400_000, to: WORLD_T0 + 86_400_000 } as const;

const OPERATIONS = ['tasks/create', 'tasks/list', 'tasks/close', null] as const;
const STATUSES = [200, 201, 403, 500, 200] as const;

function trace(i: number, at: number): RequestTrace {
  const status = STATUSES[i % STATUSES.length] as number;
  const threw = status === 500 && i % 2 === 0;
  const problemCode = status === 403 ? 'forbidden' : null;
  const operation = OPERATIONS[i % OPERATIONS.length] ?? null;
  const steps: TraceStep[] =
    i % 3 === 0
      ? [
          { type: 'check', atMs: 1, permission: 'task:create', entity: null, allowed: status !== 403, decidedBy: status !== 403 ? 'role:member' : null, requires: ['member'], callerHas: status !== 403 ? ['member'] : [] },
          { type: 'sql', atMs: 2, durationMs: 0.3, operation: 'exec', statement: 'INSERT INTO tasks (id, title) VALUES (?, ?)', params: [`task-${i}`, `private title ${i}`], rowsWritten: 1 },
          { type: 'emit', atMs: 3, eventType: 'task.created', entity: `task:task-${i}` },
        ]
      : [];
  return {
    invocationId: `inv-${String(i).padStart(3, '0')}`,
    startedAt: new Date(at).toISOString(),
    tenantId: '',
    scopeId: i % 2 === 0 ? 'scope-a' : null,
    vertical: 'tasks',
    surface: i % 4 === 0 ? 'api' : 'app',
    method: i % 2 === 0 ? 'POST' : 'GET',
    path: `/api/tasks/${i}`,
    status,
    threw,
    durationMs: 3 + i,
    level: invocationLevelOf(status, threw, problemCode),
    operation,
    problemCode,
    principalKind: i % 5 === 0 ? null : 'user',
    principal: i % 5 === 0 ? null : (`01HZZZZZZZZZZZZZZZZZZZZZZ${i % 3}` as RequestTrace['principal']),
    eventCount: steps.length > 0 ? 1 : 0,
    eventTypes: steps.length > 0 ? ['task.created'] : [],
    entities: steps.length > 0 ? [`task:task-${i}`] : [],
    versionId: null,
    specVersion: '0.1.0',
    steps,
    capture: { sqlParams: true, stepsDropped: 0 },
  };
}

/**
 * The world every source is judged against: 24 requests a minute apart, two of them at the
 * same instant (so ordering must break ties), a facet value or two that is `null`, and SQL
 * steps carrying bound values a source without `rawPayloads` must not hand out.
 */
export function contractWorld(): ContractWorld {
  const traces = Array.from({ length: 24 }, (_, i) => trace(i, WORLD_T0 + (i === 8 ? 7 : i) * MIN));
  return {
    traces,
    modelJson: {
      entities: { task: { table: 'tasks', fields: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } } } } },
      lifecycles: { task: { field: 'status', initial: 'open', states: { open: { on: { 'tasks/close': 'closed' } }, closed: { terminal: true } } } },
    },
    permissionsMd: [
      '## 1. Registry — every key a registered manifest declares',
      '',
      '| Key | Description | Declared by |',
      '| --- | --- | --- |',
      '| `task:create` | Create tasks | `tasks` |',
      '',
      '## 2. Roles — as defined by this vertical',
      '',
      '| Role | Permissions |',
      '| --- | --- |',
      '| `member` | `task:create` |',
      '',
    ].join('\n'),
  };
}

function fail(message: string): never {
  throw new ContractViolation(message);
}

const strictHead = traceHead.strict();

async function everyPage(source: ConsoleDataSource, query: RequestQuery): Promise<TraceHead[]> {
  const out: TraceHead[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < 1000; n++) {
    const page = await source.queryRequests({ ...query, ...(cursor === undefined ? {} : { cursor }) });
    out.push(...page.requests);
    if (page.nextCursor === null) return out;
    cursor = page.nextCursor;
  }
  return fail('queryRequests never returned a last page');
}

const ids = (heads: readonly TraceHead[]) => heads.map((h) => h.invocationId);
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** What the suite holds a source to, given the world and what it declared. */
interface Ctx {
  readonly subject: ContractSubject;
  readonly source: ConsoleDataSource;
  readonly world: ContractWorld;
  /** The world's heads as this source must return them: its unfilled fields blanked. */
  readonly expected: readonly TraceHead[];
  readonly capabilities: SourceCapabilities;
  /** `capabilities.requestFields`. */
  readonly fields: readonly RequestField[];
}

export interface ContractCheck {
  readonly name: string;
  run(ctx: Ctx): Promise<void>;
}

/** The checks, in the order they run. Names are stable: a liar's test asserts which one it fails. */
export const CONTRACT_CHECKS: readonly ContractCheck[] = [
  {
    name: 'describe.capabilities',
    async run({ source }) {
      const { capabilities: c, id, kind } = source.describe();
      if (!id) fail('the source has no id');
      if (!SOURCE_KINDS.includes(kind)) fail(`unknown kind ${kind}`);
      for (const cap of CAPABILITIES) if (typeof c[cap] !== 'boolean') fail(`capability ${cap} is not declared`);
      for (const f of c.requestFields) if (!REQUEST_FIELDS.includes(f)) fail(`unknown request field ${f}`);
      for (const f of REQUIRED_REQUEST_FIELDS) if (!c.requestFields.includes(f)) fail(`required request field ${f} is not filled`);
    },
  },
  {
    name: 'requests.shape',
    async run({ source }) {
      for (const h of await everyPage(source, WORLD_ALL)) {
        const r = strictHead.safeParse(h);
        if (!r.success) fail(`request ${h.invocationId} is not a trace head: ${r.error.message}`);
      }
    },
  },
  {
    name: 'requests.unfilled-fields-are-blank',
    async run({ source, fields }) {
      const unfilled = unfilledFields(fields);
      for (const h of await everyPage(source, WORLD_ALL)) {
        for (const f of unfilled) {
          const v = h[f];
          if (!(v === null || (Array.isArray(v) && v.length === 0))) fail(`request ${h.invocationId} fills ${f}, which the source does not declare`);
        }
      }
    },
  },
  {
    name: 'requests.window',
    async run({ source, expected }) {
      for (const window of [WORLD_WINDOW, { from: WORLD_T0 + 7 * MIN, to: WORLD_T0 + 7 * MIN + 1 }]) {
        const got = await everyPage(source, window);
        const want = ids(matching(expected, window));
        if (!same(ids(got), want)) fail(`window [${window.from}, ${window.to}) returned ${ids(got).join(',')}; want ${want.join(',')}`);
      }
    },
  },
  {
    name: 'requests.order-and-paging',
    async run({ source, expected }) {
      const want = ids(matching(expected, WORLD_ALL));
      const paged = await everyPage(source, { ...WORLD_ALL, limit: 5 });
      if (!same(ids(paged), want)) fail(`pages of 5 returned ${ids(paged).join(',')}; want ${want.join(',')}`);
      const first = await source.queryRequests({ ...WORLD_ALL, limit: 5 });
      if (first.requests.length !== 5 || first.nextCursor === null) fail('a page of 5 over 24 requests is not full with a next cursor');
    },
  },
  {
    name: 'requests.where',
    async run({ source, expected, fields }) {
      for (const key of FACET_KEYS) {
        if (!fields.includes(key)) continue;
        const values = [...new Set(expected.map((h) => facetValueOf(h, key)).filter((v): v is string => v !== null))];
        // One value, then two: values under one key are alternatives.
        for (const chosen of [values.slice(0, 1), values.slice(0, 2)]) {
          const query = { ...WORLD_ALL, where: { [key]: chosen } };
          const got = await everyPage(source, query);
          const want = ids(matching(expected, query));
          if (!same(ids(got), want)) fail(`where ${key} in ${chosen.join('|')} returned ${got.length} requests; want ${want.length}`);
        }
      }
    },
  },
  {
    name: 'requests.refuse-bad-query',
    async run({ source }) {
      const refused = async (q: RequestQuery, what: string) => {
        const outcome = await source.queryRequests(q).then(
          () => 'answered',
          () => 'refused',
        );
        if (outcome !== 'refused') fail(`${what} was answered`);
      };
      await refused({ from: WORLD_ALL.to, to: WORLD_ALL.from }, 'a window that ends before it starts');
      await refused({ ...WORLD_ALL, cursor: 'not-a-cursor' }, 'a cursor the source did not write');
    },
  },
  {
    name: 'facets.exact-source-never-estimates',
    async run({ source, capabilities }) {
      if (!capabilities.exactFacetCounts) return;
      for (const q of [WORLD_ALL, { ...WORLD_ALL, where: { level: ['warn'] } }]) {
        if ((await source.facets(q)).estimated) fail('a source declaring exactFacetCounts answered estimated: true');
      }
    },
  },
  {
    name: 'facets.counts-exact-unless-estimated',
    async run({ source, expected, fields }) {
      for (const q of [WORLD_ALL, WORLD_WINDOW, { ...WORLD_ALL, where: { level: ['warn'], surface: ['app'] } }]) {
        const got = await source.facets(q);
        if (got.estimated) continue;
        const total = matching(expected, q).length;
        if (got.total !== total) fail(`facet total ${got.total}; want ${total}`);
        for (const key of FACET_KEYS) {
          if (!fields.includes(key)) continue;
          const counts = countFacet(expected, q, key);
          for (const { value, count } of got.facets[key] ?? []) {
            if (counts.get(value) !== count) fail(`facet ${key}=${value} counted ${count}; want ${counts.get(value) ?? 0}`);
          }
          const listed = new Set((got.facets[key] ?? []).map((v) => v.value));
          if (counts.size <= FACET_TOP) for (const v of counts.keys()) if (!listed.has(v)) fail(`facet ${key} leaves out ${v}`);
        }
      }
    },
  },
  {
    name: 'traces.get',
    async run({ source, world }) {
      for (const t of world.traces) {
        const got = await source.getTrace(t.invocationId);
        if (got === null) fail(`no trace for ${t.invocationId}`);
        const r = requestTrace.safeParse(got);
        if (!r.success) fail(`trace ${t.invocationId} is not a request trace: ${r.error.message}`);
        if (got.invocationId !== t.invocationId) fail(`getTrace(${t.invocationId}) returned ${got.invocationId}`);
      }
      if ((await source.getTrace('inv-none')) !== null) fail('getTrace answered an id the world does not hold');
    },
  },
  {
    name: 'traces.steps-match-capability',
    async run({ source, world, capabilities: { traceSteps } }) {
      for (const t of world.traces) {
        const got = await source.getTrace(t.invocationId);
        const steps = got?.steps ?? [];
        if (!traceSteps && steps.length > 0) fail(`trace ${t.invocationId} carries steps from a source that does not declare traceSteps`);
        if (traceSteps && !same(steps.map((s) => s.type), t.steps.map((s) => s.type))) {
          fail(`trace ${t.invocationId} steps ${steps.map((s) => s.type).join(',')}; want ${t.steps.map((s) => s.type).join(',')}`);
        }
      }
    },
  },
  {
    name: 'traces.raw-payloads',
    async run({ source, world, capabilities: { rawPayloads, traceSteps } }) {
      for (const t of world.traces) {
        const got = await source.getTrace(t.invocationId);
        if (!got) continue;
        const bound = got.steps.filter((s) => s.type === 'sql' && s.params !== undefined);
        if (!rawPayloads && (bound.length > 0 || got.capture.sqlParams)) fail(`trace ${t.invocationId} hands out bound values without rawPayloads`);
        const recorded = t.steps.filter((s) => s.type === 'sql' && s.params !== undefined).length;
        if (rawPayloads && traceSteps && bound.length !== recorded) fail(`trace ${t.invocationId} dropped bound values a rawPayloads source holds`);
      }
    },
  },
  {
    name: 'artifacts.match-capability',
    async run({ source, world, capabilities: { model: hasModel, permissions: hasPermissions } }) {
      const { model, permissions } = await source.artifacts();
      if (!hasModel && model !== null) fail('a model from a source that does not declare model');
      if (hasModel) {
        if (model === null) fail('no model from a source that declares model');
        const declared = world.modelJson as { entities: object; lifecycles?: object };
        const keys = (o: object | undefined) => Object.keys(o ?? {}).sort().join(',');
        if (keys(model.entities) !== keys(declared.entities)) fail('the model does not hold the world entities');
        if (keys(model.lifecycles) !== keys(declared.lifecycles)) fail('the model does not hold the declared lifecycles');
      }
      if (!hasPermissions && permissions !== null) fail('permissions from a source that does not declare permissions');
      if (hasPermissions) {
        const want = parsePermissions(world.permissionsMd).roles.map((r) => `${r.role}:${r.keys.join('+')}`).join(',');
        if (permissions === null) fail('no permissions from a source that declares permissions');
        if (permissions.roles.map((r) => `${r.role}:${r.keys.join('+')}`).join(',') !== want) fail('the roles are not the world roles');
      }
    },
  },
  {
    name: 'tail.declared-iff-present',
    async run({ source, capabilities: { tail: declared } }) {
      if (declared !== (typeof source.tail === 'function')) fail(declared ? 'tail is declared and there is no tail()' : 'tail() exists and tail is not declared');
    },
  },
  {
    name: 'tail.delivers',
    async run({ subject, source, world, capabilities, fields }) {
      if (!capabilities.tail || typeof source.tail !== 'function') return;
      const record = subject.record?.bind(subject) ?? fail('a source declaring tail has a harness that cannot record');
      const base = world.traces[0] as RequestTrace;
      const at = new Date(WORLD_T0 + 60 * MIN).toISOString();
      const got: string[] = [];
      const delivered: unknown[] = [];
      const stop = source.tail({ where: { level: ['error'] } }, (h) => {
        got.push(h.invocationId);
        delivered.push(h);
      });
      await record({ ...base, invocationId: 'inv-tail-1', startedAt: at, status: 500, level: 'error' });
      await record({ ...base, invocationId: 'inv-tail-2', startedAt: at, status: 200, level: 'info' });
      stop();
      await record({ ...base, invocationId: 'inv-tail-3', startedAt: at, status: 500, level: 'error' });
      if (!same(got, ['inv-tail-1'])) fail(`tail delivered ${got.join(',') || 'nothing'}; want inv-tail-1`);
      // A tail is a read path like a page: it hands out heads, nothing more, blank where undeclared.
      // A `RequestTrace` is assignable to the listener's `TraceHead`, so only this catches steps leaking.
      for (const h of delivered) {
        const r = strictHead.safeParse(h);
        if (!r.success) fail(`tail delivered something other than a trace head: ${r.error.message}`);
        for (const f of unfilledFields(fields)) {
          const v = r.data[f];
          if (!(v === null || (Array.isArray(v) && v.length === 0))) fail(`tail delivered ${f}, which the source does not declare`);
        }
      }
    },
  },
];

export interface CheckOutcome {
  readonly name: string;
  readonly ok: boolean;
  readonly error?: string;
}

async function withSubject<T>(harness: ContractHarness, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const world = contractWorld();
  const subject = await harness.create(world);
  try {
    const capabilities = subject.source.describe().capabilities;
    const fields = capabilities.requestFields;
    // The oracle is the world as this source may show it; a lie in requestFields is the
    // unfilled-fields check's to catch, so the others are not also failed by it.
    const expected = world.traces.map((t) => blankUnfilled(t, fields));
    return await fn({ subject, source: subject.source, world, expected, capabilities, fields });
  } finally {
    await subject.close?.();
  }
}

/** Run one check against a fresh source. */
export async function runCheck(harness: ContractHarness, check: ContractCheck): Promise<CheckOutcome> {
  try {
    await withSubject(harness, (ctx) => check.run(ctx));
    return { name: check.name, ok: true };
  } catch (e) {
    return { name: check.name, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Run every check, each against a fresh source. */
export async function runContract(harness: ContractHarness): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];
  for (const check of CONTRACT_CHECKS) out.push(await runCheck(harness, check));
  return out;
}

/** The two functions of a test runner the suite registers through: vitest's, or any with that shape. */
export interface TestRunner {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void>): void;
}

/** Register the suite with a test runner: `registerContract('local source', harness, { describe, it })`. */
export function registerContract(name: string, harness: ContractHarness, runner: TestRunner): void {
  runner.describe(`console data source contract: ${name}`, () => {
    for (const check of CONTRACT_CHECKS) {
      runner.it(check.name, async () => {
        const outcome = await runCheck(harness, check);
        if (!outcome.ok) throw new ContractViolation(`${check.name}: ${outcome.error}`);
      });
    }
  });
}
