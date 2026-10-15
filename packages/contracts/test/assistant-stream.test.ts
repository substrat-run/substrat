/**
 * The assistant's stream protocol: what a client may rely on when it folds events, and the
 * one function that binds an approval to the input the user saw.
 */
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_STREAM_VERSION,
  approvalDigest,
  assistantStreamBody,
  assistantStreamEvent,
  isRestingEvent,
} from '../src/assistant-stream.js';

const DIGEST = 'a'.repeat(64);

/** One valid body per event type. A new type added to the union without a row here fails below. */
const VALID = [
  { t: 'user-message', text: 'log my set' },
  { t: 'turn-start' },
  { t: 'turn-finish', reason: 'awaiting-approval' },
  { t: 'turn-error', code: 'budget_exhausted', message: 'You have reached today’s limit.' },
  { t: 'step-start', step: 'lookup' },
  { t: 'step-end', step: 'lookup' },
  { t: 'step-restart', step: 'lookup' },
  { t: 'text-start', pid: 'p1' },
  { t: 'text-delta', pid: 'p1', delta: 'Hello ' },
  { t: 'text-end', pid: 'p1' },
  { t: 'tool-input', callId: 'c1', tool: 'getSessions', input: { limit: 4 } },
  { t: 'tool-output', callId: 'c1', tool: 'getSessions', output: { sessions: [] } },
  { t: 'tool-error', callId: 'c1', tool: 'getSessions', message: 'You may not do that.' },
  { t: 'approval-request', callId: 'c2', tool: 'logSet', input: { reps: 5 }, digest: DIGEST, preview: 'Log 5 reps' },
  { t: 'approval-resolved', callId: 'c2', approved: false },
  { t: 'source', sid: 's1', title: 'Deploys', url: 'https://substrat.net/concepts/deploys' },
  { t: 'data-provenance', producedAt: '2026-10-15T10:00:00.000Z', model: 'cloudflare:@cf/meta/llama', sources: 3 },
  { t: 'budget-notice', exhausted: true, resetsAt: '2026-10-16T00:00:00.000Z' },
] as const;

describe('assistantStreamBody', () => {
  it('has a valid example for every event type in the union', () => {
    const declared = assistantStreamBody.options.map((o) => o.shape.t.value).sort();
    const exampled = VALID.map((v) => v.t).sort();
    expect(exampled).toEqual(declared);
  });

  it.each(VALID.map((v) => [v.t, v] as const))('accepts a %s event', (_name, body) => {
    expect(assistantStreamBody.safeParse(body).success).toBe(true);
  });

  it('refuses a type it does not know, so a typo is not silently a different event', () => {
    expect(assistantStreamBody.safeParse({ t: 'text-delat', pid: 'p1', delta: 'x' }).success).toBe(false);
  });

  it('refuses a delta with no part to belong to', () => {
    expect(assistantStreamBody.safeParse({ t: 'text-delta', delta: 'x' }).success).toBe(false);
  });

  it('refuses an approval request whose digest is not 64 lower-case hex characters', () => {
    const req = { t: 'approval-request', callId: 'c', tool: 't', input: {}, preview: 'p' };
    for (const digest of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)]) {
      expect(assistantStreamBody.safeParse({ ...req, digest }).success).toBe(false);
    }
  });

  it('refuses a turn finishing for a reason it does not name', () => {
    expect(assistantStreamBody.safeParse({ t: 'turn-finish', reason: 'because' }).success).toBe(false);
  });

  it('ignores a field it does not read, so an additive field is not a break', () => {
    const parsed = assistantStreamBody.parse({ t: 'turn-start', addedLater: 1 });
    expect(parsed).toEqual({ t: 'turn-start' });
  });
});

describe('assistantStreamEvent', () => {
  it('needs the id the record assigned', () => {
    expect(assistantStreamEvent.safeParse({ t: 'turn-start' }).success).toBe(false);
    expect(assistantStreamEvent.safeParse({ t: 'turn-start', id: 1 }).success).toBe(true);
  });

  it('refuses an id that is not a positive integer, since it is the resume cursor', () => {
    for (const id of [0, -1, 1.5, '3', null]) {
      expect(assistantStreamEvent.safeParse({ t: 'turn-start', id }).success).toBe(false);
    }
  });

  it('keeps the body fields alongside the id', () => {
    const e = assistantStreamEvent.parse({ t: 'text-delta', pid: 'p1', delta: 'hi', id: 7 });
    expect(e).toEqual({ t: 'text-delta', pid: 'p1', delta: 'hi', id: 7 });
  });
});

describe('isRestingEvent', () => {
  it('is true for the two events a run ends on, and for nothing else', () => {
    const resting = VALID.filter((v) => isRestingEvent(v)).map((v) => v.t);
    expect(resting.sort()).toEqual(['turn-error', 'turn-finish']);
  });
});

describe('approvalDigest', () => {
  it('is the same whatever order the keys arrive in', async () => {
    const a = await approvalDigest({ exercise: 'squat', reps: 5, weightKg: 105 });
    const b = await approvalDigest({ weightKg: 105, reps: 5, exercise: 'squat' });
    expect(a).toBe(b);
  });

  it('agrees whether an optional member is unset or undefined', async () => {
    expect(await approvalDigest({ a: 1, b: undefined })).toBe(await approvalDigest({ a: 1 }));
  });

  it('keeps array order, since in an input order is meaning', async () => {
    expect(await approvalDigest({ sets: [1, 2] })).not.toBe(await approvalDigest({ sets: [2, 1] }));
  });

  it('changes when any value changes, which is what makes an approval specific', async () => {
    const base = await approvalDigest({ exercise: 'squat', reps: 5, weightKg: 105 });
    expect(await approvalDigest({ exercise: 'squat', reps: 5, weightKg: 106 })).not.toBe(base);
    expect(await approvalDigest({ exercise: 'squat', reps: 6, weightKg: 105 })).not.toBe(base);
    expect(await approvalDigest({ exercise: 'bench', reps: 5, weightKg: 105 })).not.toBe(base);
  });

  it('tells a number from the same digits as a string', async () => {
    expect(await approvalDigest({ reps: 5 })).not.toBe(await approvalDigest({ reps: '5' }));
  });

  it('produces a string the stream schema accepts', async () => {
    const digest = await approvalDigest({ x: 1 });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      assistantStreamBody.safeParse({ t: 'approval-request', callId: 'c', tool: 't', input: { x: 1 }, digest, preview: 'p' })
        .success,
    ).toBe(true);
  });

  it('matches a known SHA-256, so it is the algorithm it says it is', async () => {
    // sha256('{}') computed independently.
    expect(await approvalDigest({})).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  });
});

describe('ASSISTANT_STREAM_VERSION', () => {
  it('is 1 until a change that is not additive ships', () => {
    expect(ASSISTANT_STREAM_VERSION).toBe(1);
  });
});
