import { describe, expect, it } from 'vitest';
import { ASK_STRING_MAX, ASK_TOOL_OUTPUT_MAX, fitToolOutput, shapeForModel, toolNameOf } from '../src/ask.js';

/**
 * What a dashboard read looks like to the model (#2283): redacted where it is free text, kept
 * where it is the team's own roster, and cut to fit with the cut said out loud.
 */

describe('shapeForModel', () => {
  it('keeps a field that is one person’s address, and redacts addresses and secrets inside free text', () => {
    const shaped = shapeForModel({
      entries: [
        { email: 'jane@acme.test', role_key: 'viewer' },
        { message: 'upstream refused Bearer ' + 'tok' + 'en' + 'A1b2C3d4E5f6' + ' for ops@acme.example' },
      ],
      nested: { line: 'connect to postgres://admin:' + 'hunter2@db.example.net failed' },
      count: 3,
      ok: true,
      none: null,
    });
    expect(shaped).toEqual({
      entries: [{ email: 'jane@acme.test', role_key: 'viewer' }, { message: 'upstream refused Bearer [secret] for [email]' }],
      nested: { line: 'connect to postgres://[credentials]@db.example.net failed' },
      count: 3,
      ok: true,
      none: null,
    });
  });

  it('bounds a long log line', () => {
    expect((shapeForModel('x'.repeat(5_000)) as string).length).toBe(ASK_STRING_MAX);
  });
});

describe('fitToolOutput', () => {
  const row = (i: number) => ({ id: `row-${i}`, text: 'y'.repeat(200) });

  it('leaves an output that fits as it is', () => {
    const small = { entries: [row(1)], nextCursor: null };
    expect(fitToolOutput(small)).toBe(small);
  });

  it('halves the longest list until it fits, and says it was cut', () => {
    const big = { entries: Array.from({ length: 1_000 }, (_, i) => row(i)), nextCursor: 'c' };
    const fitted = fitToolOutput(big) as { entries: unknown[]; truncated: boolean; nextCursor: string };
    expect(fitted.truncated).toBe(true);
    expect(fitted.nextCursor).toBe('c');
    expect(fitted.entries.length).toBeGreaterThan(0);
    expect(fitted.entries.length).toBeLessThan(1_000);
    expect(new TextEncoder().encode(JSON.stringify(fitted)).byteLength).toBeLessThanOrEqual(ASK_TOOL_OUTPUT_MAX + 32);
    // The input is not changed under the caller.
    expect(big.entries).toHaveLength(1_000);
  });

  it('wraps a top-level list, and previews one record too large to cut', () => {
    expect(fitToolOutput(Array.from({ length: 1_000 }, (_, i) => row(i)))).toMatchObject({ truncated: true, items: expect.any(Array) });
    expect(fitToolOutput({ blob: 'z'.repeat(100_000) })).toMatchObject({ truncated: true, preview: expect.any(String) });
  });
});

describe('toolNameOf', () => {
  it('names a route’s tool the way a model accepts', () => {
    expect(toolNameOf('dashboard/app-observability-logs')).toBe('app_observability_logs');
  });
});
