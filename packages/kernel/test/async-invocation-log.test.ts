import { describe, expect, it } from 'vitest';
import { substratError } from '@substrat-run/contracts';
import {
  ASYNC_LINES_PER_PASS,
  asyncInvocationLine,
  asyncLevelOf,
  asyncLinePass,
  type AsyncUnit,
} from '../src/async-invocation-log.js';
import { invocationLine, type InvocationLogLine } from '../src/invocation-log.js';

/** #1901: the async line — one grammar with the request line, ids and codes only, bounded. */

const unit = (over: Partial<AsyncUnit> = {}): AsyncUnit => ({
  kind: 'consumer',
  tenantId: 'T1',
  scopeId: 'S1',
  invocationId: 'CALL1',
  operation: 'executor:notify',
  startedAt: Date.now(),
  outcome: 'delivered',
  eventType: 'ticket.created',
  eventId: 'EV1',
  attempt: 1,
  ...over,
});

describe('asyncInvocationLine', () => {
  it('is the request line with kind and the async fields, built by the one builder', () => {
    const line = asyncInvocationLine(unit());
    const base = invocationLine({ tenantId: 'T1', scopeId: 'S1', invocationId: 'CALL1', threw: false, durationMs: 0, level: 'info' });
    // Every key the request line has, in its order, then the async ones.
    expect(Object.keys(line).filter((k) => k !== 'kind' && !['outcome', 'eventType', 'eventId', 'attempt'].includes(k))).toEqual(
      Object.keys(base),
    );
    expect(line).toMatchObject({
      substrat: 'invocation',
      kind: 'consumer',
      method: null,
      path: null,
      status: null,
      level: 'info',
      operation: 'executor:notify',
      principalKind: 'system',
      outcome: 'delivered',
      eventType: 'ticket.created',
      eventId: 'EV1',
      attempt: 1,
      eventCount: null,
    });
    // A request's line carries no kind — absent IS request.
    expect('kind' in base).toBe(false);
  });

  it("keeps a thrown error's code and nothing of its text", () => {
    const line = asyncInvocationLine(
      unit({ outcome: 'dead-lettered', error: substratError('conflict', 'customer alice@example.com already has one') }),
    );
    expect(line).toMatchObject({ level: 'error', threw: true, problemCode: 'conflict' });
    expect(JSON.stringify(line)).not.toContain('alice');
    // An error with no code is still an error, with no code to name.
    expect(asyncInvocationLine(unit({ outcome: 'retrying', error: new Error('x') }))).toMatchObject({ problemCode: null, threw: true });
  });

  it('carries a schedule its due time and lateness, and no consumer fields', () => {
    const line = asyncInvocationLine({
      kind: 'schedule',
      tenantId: 'T1',
      scopeId: 'S1',
      invocationId: 'RUN1',
      operation: 'digest/send',
      startedAt: Date.now(),
      outcome: 'ok',
      dueAt: '2026-10-04T10:00:00.000Z',
      latenessMs: 1200,
    });
    expect(line).toMatchObject({ kind: 'schedule', outcome: 'ok', dueAt: '2026-10-04T10:00:00.000Z', latenessMs: 1200 });
    expect('eventId' in line).toBe(false);
  });

  it('files each outcome under its level — a warning when nothing broke but nothing was done', () => {
    expect(asyncLevelOf('delivered', false)).toBe('info');
    expect(asyncLevelOf('routed', false)).toBe('info');
    expect(asyncLevelOf('ok', false)).toBe('info');
    expect(asyncLevelOf('inert', false)).toBe('warn');
    expect(asyncLevelOf('dead-lettered', false)).toBe('warn');
    expect(asyncLevelOf('dead-lettered', true)).toBe('error');
    expect(asyncLevelOf('retrying', true)).toBe('error');
  });
});

describe('asyncLinePass', () => {
  it('writes up to the cap, then one line naming what it withheld per kind and outcome', () => {
    const lines: InvocationLogLine[] = [];
    const pass = asyncLinePass((l) => lines.push(l), 3);
    pass.write(unit());
    pass.write(unit());
    pass.write(unit());
    pass.write(unit({ outcome: 'dead-lettered', error: new Error('x') }));
    pass.write(unit({ outcome: 'dead-lettered', error: new Error('y') }));
    pass.write(unit({ outcome: 'delivered' }));
    expect(lines).toHaveLength(3);
    pass.end();
    expect(lines).toHaveLength(4);
    expect(lines[3]).toMatchObject({
      kind: 'consumer',
      outcome: 'suppressed',
      operation: null,
      level: 'error',
      suppressed: 3,
      suppressedBy: { 'consumer:dead-lettered': 2, 'consumer:delivered': 1 },
    });
    // Ending again writes nothing more.
    pass.end();
    expect(lines).toHaveLength(4);
  });

  it('writes no suppressed line for a pass under its cap, and defaults to the published cap', () => {
    const lines: InvocationLogLine[] = [];
    const pass = asyncLinePass((l) => lines.push(l));
    for (let i = 0; i < ASYNC_LINES_PER_PASS; i++) pass.write(unit());
    pass.end();
    expect(lines).toHaveLength(ASYNC_LINES_PER_PASS);
    expect(lines.some((l) => l.outcome === 'suppressed')).toBe(false);
  });

  it('never throws: a sink that fails is one missing line, not a failed delivery', () => {
    const pass = asyncLinePass(() => {
      throw new Error('console gone');
    }, 1);
    expect(() => {
      pass.write(unit());
      pass.write(unit());
      pass.end();
    }).not.toThrow();
  });
});
