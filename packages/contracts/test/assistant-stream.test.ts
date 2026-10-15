/**
 * The assistant's stream protocol: what a client may rely on when it folds events, how it
 * reads a newer producer's stream, and the one function that binds an approval to who
 * approved what.
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_DIGEST_TAG,
  ASSISTANT_STREAM_VERSION,
  ASSISTANT_TEXT_DELTA_MAX,
  ASSISTANT_TOOL_INPUT_MAX_BYTES,
  ASSISTANT_TOOL_OUTPUT_MAX_BYTES,
  type ApprovalBinding,
  approvalDigest,
  approvalEncoding,
  assistantStreamBody,
  assistantStreamEvent,
  isRestingEvent,
  readAssistantStreamEvent,
} from '../src/assistant-stream.js';
import { canonicalJson, requestFingerprint } from '../src/idempotency.js';

const DIGEST = 'a'.repeat(64);
const PRINCIPAL = '01J9ZQ4V6M8K2N3P5R7T9W1X3Y';

/** One valid body per event type. A new type added to the union without a row here fails below. */
const VALID = [
  { t: 'user-message', text: 'log my set' },
  { t: 'turn-start', v: ASSISTANT_STREAM_VERSION },
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
  {
    t: 'approval-request',
    callId: 'c2',
    step: 'propose',
    tool: 'logSet',
    operation: 'todo/log-set',
    version: '0.3.1',
    input: { reps: 5 },
    expiresAt: '2026-10-15T10:15:00.000Z',
    nonce: '0123456789abcdef',
    digest: DIGEST,
    preview: 'Log 5 reps',
  },
  { t: 'approval-resolved', callId: 'c2', approved: false, approver: PRINCIPAL, digest: DIGEST },
  { t: 'source', sid: 's1', title: 'Deploys', url: 'https://substrat.net/concepts/deploys' },
  { t: 'data-provenance', producedAt: '2026-10-15T10:00:00.000Z', model: 'cloudflare:@cf/meta/llama', sources: 3 },
  { t: 'budget-notice', exhausted: true, resetsAt: '2026-10-16T00:00:00.000Z' },
] as const;

const ok = (body: unknown) => assistantStreamBody.safeParse(body).success;
const approvalRequest = VALID.find((v) => v.t === 'approval-request')!;

describe('assistantStreamBody', () => {
  it('has a valid example for every event type in the union', () => {
    const declared = assistantStreamBody.options.map((o) => o.shape.t.value).sort();
    const exampled = VALID.map((v) => v.t).sort();
    expect(exampled).toEqual(declared);
  });

  it.each(VALID.map((v) => [v.t, v] as const))('accepts a %s event', (_name, body) => {
    expect(ok(body)).toBe(true);
  });

  it('refuses a type it does not know, so a typo is not silently a different event', () => {
    expect(ok({ t: 'text-delat', pid: 'p1', delta: 'x' })).toBe(false);
  });

  it('refuses a delta with no part to belong to', () => {
    expect(ok({ t: 'text-delta', delta: 'x' })).toBe(false);
  });

  it('refuses an approval request whose digest is not 64 lower-case hex characters', () => {
    for (const digest of ['', 'abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)]) {
      expect(ok({ ...approvalRequest, digest })).toBe(false);
    }
  });

  it('refuses an approval request missing any binding the digest covers', () => {
    for (const field of ['step', 'operation', 'version', 'expiresAt', 'nonce'] as const) {
      const { [field]: _dropped, ...rest } = approvalRequest;
      expect(ok(rest), field).toBe(false);
    }
  });

  it('refuses a nonce too short to be single-use, or outside its alphabet', () => {
    expect(ok({ ...approvalRequest, nonce: 'a'.repeat(15) })).toBe(false);
    expect(ok({ ...approvalRequest, nonce: `${'a'.repeat(15)} ` })).toBe(false);
    expect(ok({ ...approvalRequest, nonce: 'a'.repeat(16) })).toBe(true);
  });

  it('refuses an approval resolution that does not say who approved and what', () => {
    const resolved = { t: 'approval-resolved', callId: 'c2', approved: true, approver: PRINCIPAL, digest: DIGEST };
    expect(ok(resolved)).toBe(true);
    const { approver: _a, ...noApprover } = resolved;
    const { digest: _d, ...noDigest } = resolved;
    expect(ok(noApprover)).toBe(false);
    expect(ok(noDigest)).toBe(false);
    expect(ok({ ...resolved, approver: 'the-assistant' })).toBe(false);
  });

  it('refuses a turn finishing for a reason it does not name', () => {
    expect(ok({ t: 'turn-finish', reason: 'because' })).toBe(false);
  });

  it('needs the version a turn speaks on turn-start', () => {
    expect(ok({ t: 'turn-start' })).toBe(false);
    expect(ok({ t: 'turn-start', v: 0 })).toBe(false);
  });

  it('ignores a field it does not read, so an additive field is not a break', () => {
    const parsed = assistantStreamBody.parse({ t: 'turn-start', v: 1, addedLater: 1 });
    expect(parsed).toEqual({ t: 'turn-start', v: 1 });
  });

  describe('sizes, since every event is a row in the record', () => {
    it('bounds a text delta', () => {
      expect(ok({ t: 'text-delta', pid: 'p', delta: 'x'.repeat(ASSISTANT_TEXT_DELTA_MAX) })).toBe(true);
      expect(ok({ t: 'text-delta', pid: 'p', delta: 'x'.repeat(ASSISTANT_TEXT_DELTA_MAX + 1) })).toBe(false);
    });

    /** A string whose serialized JSON (`"…"`) is exactly `bytes` long. */
    const ofBytes = (bytes: number) => 'x'.repeat(bytes - 2);

    it('bounds a tool input and an approval input by serialized bytes', () => {
      const max = ASSISTANT_TOOL_INPUT_MAX_BYTES;
      const input = (n: number) => ({ t: 'tool-input', callId: 'c', tool: 't', input: ofBytes(n) });
      expect(ok(input(max))).toBe(true);
      expect(ok(input(max + 1))).toBe(false);
      expect(ok({ ...approvalRequest, input: ofBytes(max) })).toBe(true);
      expect(ok({ ...approvalRequest, input: ofBytes(max + 1) })).toBe(false);
    });

    it('counts UTF-8 bytes, not characters', () => {
      // 'ö' is two bytes: half as many fit.
      const half = 'ö'.repeat(ASSISTANT_TOOL_INPUT_MAX_BYTES / 2);
      expect(ok({ t: 'tool-input', callId: 'c', tool: 't', input: half })).toBe(false);
    });

    it('bounds a tool output, and lets a larger result go by reference', () => {
      const max = ASSISTANT_TOOL_OUTPUT_MAX_BYTES;
      const out = (output: unknown) => ({ t: 'tool-output', callId: 'c', tool: 't', output });
      expect(ok(out(ofBytes(max)))).toBe(true);
      expect(ok(out(ofBytes(max + 1)))).toBe(false);
      expect(ok({ t: 'tool-output', callId: 'c', tool: 't', ref: 'sessions/2026-10' })).toBe(true);
    });

    it('refuses an input JSON cannot carry, and a missing one', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(ok({ t: 'tool-input', callId: 'c', tool: 't', input: cyclic })).toBe(false);
      expect(ok({ t: 'tool-input', callId: 'c', tool: 't', input: 1n })).toBe(false);
      expect(ok({ t: 'tool-input', callId: 'c', tool: 't' })).toBe(false);
    });
  });

  describe('source.url, which a client renders as a link', () => {
    const source = (url: string) => ({ t: 'source', sid: 's', title: 'x', url });

    it('takes http and https', () => {
      expect(ok(source('https://substrat.net/a'))).toBe(true);
      expect(ok(source('http://localhost:8879/a'))).toBe(true);
    });

    it('refuses every other scheme, and what is not a URL at all', () => {
      for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '/relative', 'not a url']) {
        expect(ok(source(url)), url).toBe(false);
      }
    });
  });
});

describe('assistantStreamEvent', () => {
  it('needs the id the record assigned', () => {
    expect(assistantStreamEvent.safeParse({ t: 'turn-start', v: 1 }).success).toBe(false);
    expect(assistantStreamEvent.safeParse({ t: 'turn-start', v: 1, id: 1 }).success).toBe(true);
  });

  it('refuses an id that is not a positive integer, since it is the resume cursor', () => {
    for (const id of [0, -1, 1.5, '3', null]) {
      expect(assistantStreamEvent.safeParse({ t: 'turn-start', v: 1, id }).success).toBe(false);
    }
  });

  it('keeps the body fields alongside the id', () => {
    const e = assistantStreamEvent.parse({ t: 'text-delta', pid: 'p1', delta: 'hi', id: 7 });
    expect(e).toEqual({ t: 'text-delta', pid: 'p1', delta: 'hi', id: 7 });
  });
});

describe('readAssistantStreamEvent, how a client reads a newer producer', () => {
  it('hands back a known event parsed', () => {
    expect(readAssistantStreamEvent({ t: 'text-delta', pid: 'p1', delta: 'hi', id: 7 })).toEqual({
      known: true,
      event: { t: 'text-delta', pid: 'p1', delta: 'hi', id: 7 },
    });
  });

  it('passes an event type it does not know through, with the id to resume after', () => {
    const raw = { t: 'reasoning-delta', id: 3, delta: 'x' };
    expect(readAssistantStreamEvent(raw)).toEqual({ known: false, t: 'reasoning-delta', id: 3, raw });
  });

  it('passes a known type with an enum value it does not know through, rather than throwing', () => {
    const raw = { t: 'turn-finish', reason: 'handed-off', id: 9 };
    const read = readAssistantStreamEvent(raw);
    expect(read).toEqual({ known: false, t: 'turn-finish', id: 9, raw });
    // Still a resting event: a client knows the run ended even without the reason.
    expect(isRestingEvent(read.known ? read.event : { t: read.t })).toBe(true);
  });

  it('throws on a known event that is broken, not newer', () => {
    expect(() => readAssistantStreamEvent({ t: 'text-delta', pid: 'p1', id: 4 })).toThrow();
    expect(() => readAssistantStreamEvent({ t: 'text-delta', pid: 'p1', delta: 5, id: 4 })).toThrow();
    // A wrong value AND an unknown enum value is still broken.
    expect(() => readAssistantStreamEvent({ t: 'approval-resolved', callId: 'c', approved: 'yes', approver: PRINCIPAL, digest: 'nope', id: 4 })).toThrow();
  });

  it('throws on an enum field that is missing, a number or null: broken, not newer', () => {
    // Zod reports each of these as `invalid_value`, the same code as an unknown string.
    for (const reason of [undefined, 5, null, ['done']]) {
      const raw = reason === undefined ? { t: 'turn-finish', id: 2 } : { t: 'turn-finish', reason, id: 2 };
      expect(() => readAssistantStreamEvent(raw), JSON.stringify(reason)).toThrow();
    }
  });

  it('throws when the event cannot even be skipped: no type, or no valid id', () => {
    expect(() => readAssistantStreamEvent({ id: 1 })).toThrow();
    expect(() => readAssistantStreamEvent({ t: 'reasoning-delta' })).toThrow();
    expect(() => readAssistantStreamEvent({ t: 'reasoning-delta', id: 0 })).toThrow();
    expect(() => readAssistantStreamEvent('turn-start')).toThrow();
  });
});

describe('isRestingEvent', () => {
  it('is true for the two events a run ends on, and for nothing else', () => {
    const resting = VALID.filter((v) => isRestingEvent(v)).map((v) => v.t);
    expect(resting.sort()).toEqual(['turn-error', 'turn-finish']);
  });
});

describe('approvalEncoding', () => {
  // Each expected string is written out by hand, not produced by the encoder under test.
  it.each([
    ['nested keys sort at every level', { b: { d: 1, c: [true, null] }, a: 'x' }, '{"a":"x","b":{"c":[true,null],"d":1}}'],
    ['keys sort by UTF-16 code unit', { 'é': 'ü', z: '日本', Z: 1 }, '{"Z":1,"z":"日本","é":"ü"}'],
    ['numbers as Number#toString writes them', [0.1, 1e21, -0, 1e-7, 100, -2.5], '[0.1,1e+21,0,1e-7,100,-2.5]'],
    ['strings as JSON.stringify escapes them', 'a"b\\\n\t', '"a\\"b\\\\\\n\\t"'],
    ['a lone surrogate escaped, never replaced', '\ud800', '"\\ud800"'],
    ['an undefined member left out', { a: 1, b: undefined }, '{"a":1}'],
    ['an object with no prototype', Object.assign(Object.create(null), { k: false }), '{"k":false}'],
  ])('%s', (_name, value, expected) => {
    expect(approvalEncoding(value)).toBe(expected);
  });

  it.each([
    ['undefined', undefined],
    ['undefined in an array', [undefined]],
    ['an array hole', [, 1]], // eslint-disable-line no-sparse-arrays
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', { x: Number.NEGATIVE_INFINITY }],
    ['a bigint', 1n],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a Set', new Set()],
    ['a class instance', new (class Thing {})()],
    ['a symbol key', { a: 1, [Symbol('k')]: 2 }],
    ['a non-enumerable property', Object.defineProperty({ a: 1 }, 'hidden', { value: 2, enumerable: false })],
    ['a named property on an array', Object.assign([1], { x: 2 })],
  ])('refuses %s rather than collapsing it into another value', (_name, value) => {
    expect(() => approvalEncoding(value)).toThrow(TypeError);
  });

  it('refuses a cycle, and accepts the same object twice where it is not one', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => approvalEncoding(cyclic)).toThrow(TypeError);
    const shared = { n: 1 };
    expect(approvalEncoding([shared, shared])).toBe('[{"n":1},{"n":1}]');
  });

  it('is not the idempotency encoding, so that one can change without moving approvals', () => {
    // Where canonicalJson collapses, this refuses.
    expect(canonicalJson({ at: new Date(0) })).toBe(canonicalJson({ at: new Date(1) }));
    expect(() => approvalEncoding({ at: new Date(0) })).toThrow();
  });
});

describe('approvalDigest', () => {
  const BINDING = {
    version: '0.3.1',
    approver: PRINCIPAL,
    thread: 'th1',
    step: 'propose',
    call: 'c1',
    operation: 'todo/archive',
    expiresAt: '2026-10-15T10:15:00.000Z',
    nonce: '0123456789abcdef',
    input: { id: 'x' },
  } satisfies ApprovalBinding;

  describe('fixed vectors, computed independently (printf … | shasum -a 256)', () => {
    // If one of these changes, every approval pending in production stops matching. A new
    // encoding is a new APPROVAL_DIGEST_TAG, never an edit to this one.
    it('pins the tag', () => {
      expect(APPROVAL_DIGEST_TAG).toBe('substrat.approval/v1');
    });

    it('pins the tuple and its order', async () => {
      // ["substrat.approval/v1","0.3.1","01J9ZQ4V6M8K2N3P5R7T9W1X3Y","th1","propose","c1","todo/archive",
      //  "2026-10-15T10:15:00.000Z","0123456789abcdef",{"id":"x"}]
      expect(await approvalDigest(BINDING)).toBe('9b0e04b44be64daf1a5b10510f570fb6a5694eaaabe5cba5b32c9d11408b48cb');
    });

    it('pins the operation into it', async () => {
      // The same tuple with "todo/delete".
      expect(await approvalDigest({ ...BINDING, operation: 'todo/delete' })).toBe(
        'c91c653f59bea24f527d28b185d8205f89d441ce282cec23fd0cea3fc4c65f1a',
      );
    });

    it('pins nested keys, non-ASCII text and numbers', async () => {
      // … "todo/rename", …, {"amounts":[0.1,1e+21,0],"notes":{"Z":1,"z":"日本","é":"ü"},"title":"knäböj"}]
      const input = {
        title: 'knäböj',
        notes: { 'é': 'ü', z: '日本', Z: 1 },
        amounts: [0.1, 1e21, -0],
      };
      expect(await approvalDigest({ ...BINDING, operation: 'todo/rename', input })).toBe(
        '9426edd69e90cc8823343e3df4cc0204a10d1740953c693feeae3d82aa137b6e',
      );
    });
  });

  it('differs whenever any one binding differs', async () => {
    const base = await approvalDigest(BINDING);
    const variants: ApprovalBinding[] = [
      { ...BINDING, version: '0.3.2' },
      { ...BINDING, approver: '01J9ZQ4V6M8K2N3P5R7T9W1X3Z' },
      { ...BINDING, thread: 'th2' },
      { ...BINDING, step: 'confirm' },
      { ...BINDING, call: 'c2' },
      { ...BINDING, operation: 'todo/delete' },
      { ...BINDING, expiresAt: '2026-10-15T10:15:00.001Z' },
      { ...BINDING, nonce: '0123456789abcdeg' },
      { ...BINDING, input: { id: 'y' } },
    ];
    const digests = await Promise.all(variants.map((v) => approvalDigest(v)));
    for (const d of digests) expect(d).not.toBe(base);
    expect(new Set(digests).size).toBe(variants.length);
  });

  it('does not let a value slide from one position to the next', async () => {
    // Without positions, `thread: 'a', step: 'b'` and a tuple shifted by one could agree.
    expect(await approvalDigest({ ...BINDING, thread: 'propose', step: 'th1' })).not.toBe(await approvalDigest(BINDING));
  });

  it('is the same whatever order the input keys arrive in', async () => {
    const a = await approvalDigest({ ...BINDING, input: { exercise: 'squat', reps: 5, weightKg: 105 } });
    const b = await approvalDigest({ ...BINDING, input: { weightKg: 105, reps: 5, exercise: 'squat' } });
    expect(a).toBe(b);
  });

  it('agrees whether an optional input member is unset or undefined', async () => {
    expect(await approvalDigest({ ...BINDING, input: { a: 1, b: undefined } })).toBe(
      await approvalDigest({ ...BINDING, input: { a: 1 } }),
    );
  });

  it('keeps array order and tells a number from the same digits as a string', async () => {
    expect(await approvalDigest({ ...BINDING, input: [1, 2] })).not.toBe(await approvalDigest({ ...BINDING, input: [2, 1] }));
    expect(await approvalDigest({ ...BINDING, input: { reps: 5 } })).not.toBe(
      await approvalDigest({ ...BINDING, input: { reps: '5' } }),
    );
  });

  it('is never the idempotency fingerprint of the same operation and input', async () => {
    const fingerprint = await requestFingerprint(BINDING.operation, BINDING.input);
    expect(await approvalDigest(BINDING)).not.toBe(fingerprint);
  });

  it('refuses an input the encoding cannot carry, rather than digesting it as something else', async () => {
    await expect(approvalDigest({ ...BINDING, input: { at: new Date(0) } })).rejects.toThrow(TypeError);
    await expect(approvalDigest({ ...BINDING, input: Number.NaN })).rejects.toThrow(TypeError);
    await expect(approvalDigest({ ...BINDING, input: undefined })).rejects.toThrow(TypeError);
  });

  it('takes the expiry only as toISOString writes it, so one moment has one digest', async () => {
    for (const expiresAt of ['2026-10-15T10:15:00Z', '2026-10-15T12:15:00.000+02:00', '2026-10-15', 'soon']) {
      await expect(approvalDigest({ ...BINDING, expiresAt }), expiresAt).rejects.toThrow();
    }
  });

  it('refuses an expiry the approval-request event would refuse, by the same rule', async () => {
    // Both round-trip through toISOString(); `instant` refuses an expanded year.
    for (const expiresAt of ['+275760-09-13T00:00:00.000Z', '-000001-01-01T00:00:00.000Z']) {
      expect(ok({ ...approvalRequest, expiresAt }), expiresAt).toBe(false);
      await expect(approvalDigest({ ...BINDING, expiresAt }), expiresAt).rejects.toThrow();
    }
  });

  it('refuses a short nonce and an approver that is not a principal', async () => {
    await expect(approvalDigest({ ...BINDING, nonce: 'short' })).rejects.toThrow();
    await expect(approvalDigest({ ...BINDING, approver: 'assistant' })).rejects.toThrow();
  });

  it('produces a string the stream schema accepts on both approval events', async () => {
    const digest = await approvalDigest(BINDING);
    expect(ok({ ...approvalRequest, digest })).toBe(true);
    expect(ok({ t: 'approval-resolved', callId: 'c1', approved: true, approver: PRINCIPAL, digest })).toBe(true);
  });
});

describe('ASSISTANT_STREAM_VERSION', () => {
  it('is 1 until a change that is not additive ships', () => {
    expect(ASSISTANT_STREAM_VERSION).toBe(1);
  });
});
