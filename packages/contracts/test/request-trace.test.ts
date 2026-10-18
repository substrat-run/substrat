import { describe, expect, expectTypeOf, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TRACE_SINK_KEY,
  TRACE_STEP_CAP,
  TRACE_STEP_TYPES,
  installedTraceSink,
  requestTrace,
  traceHead,
  traceStep,
  type TraceHead,
  type TraceSink,
  type TraceStep,
} from '../src/index.js';

const head = {
  invocationId: '01J0000000000000000000000A',
  startedAt: '2026-10-17T10:00:00.000Z',
  tenantId: '01J0000000000000000000000T',
  scopeId: null,
  vertical: 'todo',
  surface: 'app',
  method: 'POST',
  path: '/api/lists',
  status: 403,
  threw: false,
  durationMs: 4.2,
  level: 'warn' as const,
  operation: 'todo/rename-list',
  problemCode: 'permission_denied',
  principalKind: 'principal',
  principal: null,
  eventCount: 0,
  eventTypes: [],
  entities: [],
  versionId: null,
  specVersion: null,
};

describe('request trace', () => {
  it('parses a trace whose steps tell why a call was refused', () => {
    const trace = requestTrace.parse({
      ...head,
      steps: [
        { type: 'sql', atMs: 1, operation: 'query', statement: 'SELECT id FROM todo_lists WHERE id = ?', params: ['x'], rowsRead: 1, durationMs: 0 },
        { type: 'check', atMs: 2, permission: 'list:manage', entity: 'list:x', allowed: false, decidedBy: null, requires: ['owner'], callerHas: ['member'] },
        { type: 'error', atMs: 3, code: 'permission_denied', message: 'refused' },
      ],
      capture: { sqlParams: true, stepsDropped: 0 },
    });
    expect(trace.steps.map((s) => s.type)).toEqual(['sql', 'check', 'error']);
  });

  it('accepts a head with no steps: the hosted record fills only the head', () => {
    expect(requestTrace.parse({ ...head, steps: [], capture: { sqlParams: false, stepsDropped: 0 } }).steps).toEqual([]);
  });

  it('refuses a step of an unknown type, and a check without the verdict', () => {
    expect(traceStep.safeParse({ type: 'telepathy', atMs: 0 }).success).toBe(false);
    expect(traceStep.safeParse({ type: 'check', atMs: 0, permission: 'p', entity: null, requires: [], callerHas: [], decidedBy: null }).success).toBe(false);
  });

  it('keeps no more than the step cap', () => {
    const step = { type: 'log', atMs: 0, level: 'info', message: 'm' };
    const trace = (n: number) => ({ ...head, steps: Array.from({ length: n }, () => step), capture: { sqlParams: false, stepsDropped: 0 } });
    expect(requestTrace.safeParse(trace(TRACE_STEP_CAP)).success).toBe(true);
    expect(requestTrace.safeParse(trace(TRACE_STEP_CAP + 1)).success).toBe(false);
  });

  it('accepts fractional step timings, as a performance.now() recorder produces', () => {
    const step = { type: 'log', atMs: 1.25, durationMs: 0.04, level: 'info', message: 'm' };
    expect(traceStep.safeParse(step).success).toBe(true);
  });

  it('lists every step kind the schema carries', () => {
    const kinds = traceStep.options.map((o) => o.shape.type.value).sort();
    expect(kinds).toEqual([...TRACE_STEP_TYPES].sort());
  });
});

describe('the plain-TypeScript twin in trace-sink.ts', () => {
  // The platform entry imports trace-sink.ts and may not carry zod, so the shapes are written
  // twice. These make the compiler, not a reviewer, notice when they part company.
  it('agrees with the schemas on the head and on every step', () => {
    expectTypeOf<ReturnType<typeof traceHead.parse>>().toEqualTypeOf<TraceHead>();
    expectTypeOf<ReturnType<typeof traceStep.parse>>().toEqualTypeOf<TraceStep>();
  });

  it('has no runtime import, so it bundles without zod', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/trace-sink.ts', import.meta.url)), 'utf8');
    const runtimeImports = source.split('\n').filter((l) => /^import\s/.test(l) && !/^import\s+type\s/.test(l));
    expect(runtimeImports).toEqual([]);
  });
});

describe('the sink slot', () => {
  it('is a registered symbol, so two copies of a package agree on it', () => {
    expect(TRACE_SINK_KEY).toBe(Symbol.for('substrat.trace-sink'));
  });

  it('reads as no sink until one is installed, and as the installed one after', () => {
    const slots = globalThis as Record<symbol, unknown>;
    expect(installedTraceSink()).toBeUndefined();
    const sink: TraceSink = { head() {}, step() {}, end() {} };
    slots[TRACE_SINK_KEY] = sink;
    try {
      expect(installedTraceSink()).toBe(sink);
    } finally {
      delete slots[TRACE_SINK_KEY];
    }
    expect(installedTraceSink()).toBeUndefined();
  });
});
