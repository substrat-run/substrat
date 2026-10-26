import { describe, expect, it } from 'vitest';
import { ASK_STRING_MAX, ASK_TOOL_OUTPUT_MAX, answeredTurn, fitToolOutput, shapeForModel, toolNameOf } from '../src/ask.js';

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

  it('passes an identifier the model hands back whole: a cursor redact would call opaque stays usable', () => {
    const cursor = 'eyJhZnRlciI6IjAxSlpYWVoxMjM0NTY3ODlBQkNERUZHSEpLTSJ9AbCdEf';
    const longId = 'a'.repeat(700);
    expect(shapeForModel({ nextCursor: cursor, entries: [{ id: 'row-1', scopeId: '01JZ0000000000000000000000' }] })).toEqual({
      nextCursor: cursor,
      entries: [{ id: 'row-1', scopeId: '01JZ0000000000000000000000' }],
    });
    // The same run under any other name is free text, and redacted as before.
    expect(shapeForModel({ note: cursor })).toEqual({ note: expect.not.stringContaining(cursor) });
    // Longer than any id this dashboard mints, an "id" is bounded like text.
    expect((shapeForModel({ id: longId }) as { id: string }).id.length).toBeLessThanOrEqual(ASK_STRING_MAX);
  });

  it("keeps only the team's own roster and audit addresses: an app's end user is redacted", () => {
    expect(
      shapeForModel({
        entries: [{ email: 'jane@acme.test', invitedBy: 'lead@acme.test', actor: 'ops@acme.test' }],
        records: [{ user: 'customer@example.com', principal: 'customer@example.com' }],
      }),
    ).toEqual({
      entries: [{ email: 'jane@acme.test', invitedBy: 'lead@acme.test', actor: 'ops@acme.test' }],
      records: [{ user: '[email]', principal: '[email]' }],
    });
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
    const fitted = fitToolOutput(big) as { entries: unknown[]; truncated: boolean; nextCursor: string | null };
    expect(fitted.truncated).toBe(true);
    // The page's cursor points past all 1,000; following it would skip what was cut.
    expect(fitted.nextCursor).toBeNull();
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

  it('cuts a list nested in a one-item list, rather than giving up on it', () => {
    const big = { entries: [{ id: 'f-1', evidence: Array.from({ length: 1_000 }, (_, i) => row(i)) }] };
    const fitted = fitToolOutput(big) as { entries: { evidence: unknown[] }[]; truncated: boolean };
    expect(fitted.truncated).toBe(true);
    expect(fitted.entries[0]!.evidence.length).toBeGreaterThan(0);
    expect(fitted.entries[0]!.evidence.length).toBeLessThan(1_000);
  });

  it('bounds a preview in bytes once serialized, and never splits a character', () => {
    const fitted = fitToolOutput({ blob: '漢"\\😀'.repeat(20_000) }) as { preview: string };
    expect(new TextEncoder().encode(JSON.stringify(fitted)).byteLength).toBeLessThanOrEqual(ASK_TOOL_OUTPUT_MAX);
    // A lone surrogate would serialize as an escape; a whole emoji serializes as itself.
    expect(JSON.stringify(fitted.preview)).not.toMatch(/\\ud[89ab]/i);
  });
});

describe('a failed read, as the person sees it', () => {
  it('is redacted, like everything the model reads', () => {
    const events = answeredTurn({
      question: 'q',
      steps: [{ text: '', toolCalls: [{ callId: 'c1', tool: 'list_apps', input: {} }], toolResults: [], toolErrors: [{ callId: 'c1', tool: 'list_apps', message: 'bad argument for ops@acme.example' }] }],
      text: 'a',
      producedAt: '2026-10-26T09:00:00.000Z',
      model: 'm',
      budgetExhausted: false,
    });
    expect(events.find((e) => e.t === 'tool-error')).toMatchObject({ message: 'bad argument for [email]' });
  });
});

describe('toolNameOf', () => {
  it('names a route’s tool the way a model accepts', () => {
    expect(toolNameOf('dashboard/app-observability-logs')).toBe('app_observability_logs');
  });
});
