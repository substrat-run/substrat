import { describe, expect, it } from 'vitest';
import { currentInvocationId, invocationLine, STORE_CALL_SINK_KEY } from '../src/invocation-line.js';

/**
 * #2192: `parentInvocationId` is additive. A line with no parent is byte-for-byte the line
 * written before the field existed, and a line with one carries it under that one key.
 */
describe('invocation line: parentInvocationId (#2192)', () => {
  const base = {
    tenantId: 'T',
    scopeId: 'S',
    invocationId: '01JABCDEFGHJKMNPQRSTVWXYZ0',
    threw: false,
    durationMs: 3,
    level: 'info' as const,
  };
  const before =
    '{"substrat":"invocation","tenantId":"T","scopeId":"S","vertical":null,"surface":null,"method":null,"path":null,"route":null,' +
    '"status":null,"threw":false,"durationMs":3,"invocationId":"01JABCDEFGHJKMNPQRSTVWXYZ0","level":"info","operation":null,' +
    '"problemCode":null,"principalKind":null,"eventCount":null,"logLines":null,"eventTypes":[],"entities":[],"entityTypes":null,"versionId":null}';

  it('absent: the line is exactly what it was', () => {
    expect(JSON.stringify(invocationLine(base))).toBe(before);
    expect(JSON.stringify(invocationLine({ ...base, parentInvocationId: '' }))).toBe(before);
  });

  it('a parent scope is written only beside a parent: alone it is dropped, and the line is what it was', () => {
    expect(JSON.stringify(invocationLine({ ...base, parentScopeId: '01JSCOPESCOPESCOPESCOPESCO' }))).toBe(before);
    const line = invocationLine({ ...base, parentInvocationId: '01JZZZZZZZZZZZZZZZZZZZZZZZ', parentScopeId: '01JSCOPESCOPESCOPESCOPESCO' });
    const { parentInvocationId, parentScopeId, ...rest } = line;
    expect([parentInvocationId, parentScopeId]).toEqual(['01JZZZZZZZZZZZZZZZZZZZZZZZ', '01JSCOPESCOPESCOPESCOPESCO']);
    expect(JSON.stringify(rest)).toBe(before);
  });

  it('present: one more key, nothing else moves', () => {
    const line = invocationLine({ ...base, parentInvocationId: '01JZZZZZZZZZZZZZZZZZZZZZZZ' });
    expect(line.parentInvocationId).toBe('01JZZZZZZZZZZZZZZZZZZZZZZZ');
    const { parentInvocationId: _, ...rest } = line;
    expect(JSON.stringify(rest)).toBe(before);
  });
});

describe('currentInvocationId (#2192)', () => {
  const key = Symbol.for(STORE_CALL_SINK_KEY);
  const g = globalThis as Record<symbol, unknown>;

  it('reads the slot, and is undefined for a slot without the method or with a broken one', () => {
    const saved = g[key];
    try {
      g[key] = { current: () => undefined, invocationId: () => 'X' };
      expect(currentInvocationId()).toBe('X');
      g[key] = { current: () => undefined };
      expect(currentInvocationId()).toBeUndefined();
      g[key] = {
        current: () => undefined,
        invocationId: () => {
          throw new Error('broken');
        },
      };
      expect(currentInvocationId()).toBeUndefined();
      delete g[key];
      expect(currentInvocationId()).toBeUndefined();
    } finally {
      g[key] = saved;
    }
  });
});
