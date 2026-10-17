import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { OUTBOUND_CALL_LOG_CAP } from '@substrat-run/kernel/invocation-line';
import { invocationLog, type InvocationLogLine, withInvocationLog } from '../src/invocation-log.js';
import {
  EGRESS_REFUSAL_HEADER,
  installOutboundRecorder,
  keepsSegment,
  markRequestStart,
  type OutboundRecording,
  recordingFetch,
  redactOutboundPath,
} from '../src/outbound-calls.js';

/**
 * #2192: the outbound calls a request made, on its invocation line. The two halves held here:
 * what a path is reduced to before it is written (a segment can be a credential), and the
 * wrapper the platform puts in front of `fetch` — which must never change what the vertical's
 * call does, inside a request or out of one.
 */

describe('redactOutboundPath — default-deny: a segment is kept only when it is a plain lowercase name', () => {
  const kept: Array<[string, string]> = [
    // [what it is, the path] — written exactly as it came
    ['a REST path with a small integer id', '/v1/users/42/messages'],
    ['an OAuth token endpoint', '/oauth/token'],
    ['a dotted file name', '/api/me.json'],
    ['underscore- and hyphen-joined words', '/v2.1/oauth_token/access-tokens'],
    ['an integer of 10 digits', '/chats/1234567890'],
    ['the root', '/'],
    ['a lowercase owner and repository', '/repos/owner/name'],
  ];
  it.each(kept)('keeps %s', (_what, path) => {
    expect(redactOutboundPath(path)).toBe(path);
  });

  const redacted: Array<[string, string, string]> = [
    // [what it is, the path, how it is written]
    ['a UUID', '/items/3f2b8c1e-9a4d-4e2f-b6a1-0c9d8e7f6a5b', '/items/[redacted]'],
    ['a ULID, upper case', '/things/01JZ0000000000000000TEN001', '/things/[redacted]'],
    ['a ULID, lower case', '/things/01jz0000000000000000ten001', '/things/[redacted]'],
    ['a 7-character letter-and-digit mix (a capability-URL token)', '/hooks/catch/123456/ab1cd2e/', '/hooks/catch/123456/[redacted]/'],
    ['an integer of 16 digits', '/card/4111111111111111', '/card/[redacted]'],
    ['an integer of 19 digits', '/channels/1234567890123456789', '/channels/[redacted]'],
    ['an integer of 11 digits', '/n/12345678901', '/n/[redacted]'],
    ['a base64url run', '/k/AbCdEfGhIjKlMnOp', '/k/[redacted]'],
    ['a 32-hex API key', '/api/0123456789abcdef0123456789abcdef/send', '/api/[redacted]/send'],
    ['a bot<id>:<token> segment', '/bot123456789:AAH4tQ_Zx9yPq2lM0nB7vC3kJ8hG1fD6sE/sendMessage', '/[redacted]/[redacted]'],
    ['a JWT-shaped segment', '/verify/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl', '/verify/[redacted]'],
    ['a letter-and-digit name', '/oauth2/token', '/[redacted]/token'],
    ['a mixed-case owner and repository', '/repos/Acme/Widgets', '/repos/[redacted]/[redacted]'],
    ['a digit-bearing repository', '/repos/owner/name2', '/repos/owner/[redacted]'],
    ['a key=value segment', '/x/key=abc', '/x/[redacted]'],
    ['a percent-encoded segment', '/files/a%2Fb', '/files/[redacted]'],
    ['an @ segment', '/mail/user@example', '/mail/[redacted]'],
    ['a word part past 16 letters', '/authorizationcodes', '/[redacted]'],
  ];
  it.each(redacted)('redacts %s', (_what, path, written) => {
    expect(redactOutboundPath(path)).toBe(written);
  });

  it('the limits, stated as the docs state them: these shapes are written as they are', () => {
    // A lowercase-letter word of up to 16 letters per part, and an integer of up to 10 digits.
    expect(keepsSegment('hunterhunterhunt')).toBe(true);
    // Even one that is all hex letters: the rule cannot tell it from a word.
    expect(keepsSegment('deadbeefcafebabe')).toBe(true);
    expect(keepsSegment('hunterhunterhunte')).toBe(false);
    expect(keepsSegment('1234567890')).toBe(true);
  });

  it('a very long path is cut after redaction', () => {
    const path = redactOutboundPath('/' + Array.from({ length: 60 }, () => 'segment').join('/'));
    expect(path.length).toBeLessThanOrEqual(201);
    expect(path.endsWith('…')).toBe(true);
  });
});

type Answer = { status: number; headers: Headers };

/** A stand-in for the runtime's `fetch` that records what it was called with. */
function runtimeFetch(answer: (input: unknown, init?: unknown) => Promise<Answer>) {
  const calls: Array<{ self: unknown; input: unknown; init: unknown }> = [];
  const fn = function (this: unknown, input: unknown, init?: unknown) {
    calls.push({ self: this, input, init });
    return answer(input, init);
  };
  return { fn, calls };
}

const ok = (status = 200, headers: Record<string, string> = {}) => async (): Promise<Answer> => ({ status, headers: new Headers(headers) });

describe('recordingFetch — the wrapper in front of the runtime’s fetch', () => {
  it('outside a request it is a pass-through: same arguments, same receiver, same answer, nothing recorded', async () => {
    const answer = { status: 204, headers: new Headers() };
    const runtime = runtimeFetch(async () => answer);
    const wrapped = recordingFetch(runtime.fn, () => undefined);
    const init = { method: 'POST', body: 'x' };
    expect(await wrapped('https://api.example.com/a?secret=1', init)).toBe(answer);
    expect(runtime.calls).toEqual([{ self: globalThis, input: 'https://api.example.com/a?secret=1', init }]);
  });

  it('inside a request it records the call and hands back the runtime’s own response', async () => {
    const answer = { status: 403, headers: new Headers() };
    const runtime = runtimeFetch(async () => answer);
    const recording: OutboundRecording = {};
    markRequestStart(recording, Date.now() - 50);
    const wrapped = recordingFetch(runtime.fn, () => recording);
    const res = await wrapped('https://User:pw@API.example.com:8443/v1/users/42/0123456789abcdef0123456789abcdef?token=abc#frag', { method: 'post' });
    expect(res).toBe(answer);
    expect(runtime.calls[0]?.self).toBe(globalThis);
    expect(recording.outboundCalls).toEqual([
      { host: 'api.example.com:8443', path: '/v1/users/42/[redacted]', method: 'POST', status: 403, outcome: 'http-error', durationMs: expect.any(Number), atMs: expect.any(Number) },
    ]);
    // Measured from the request's start, which is kept beside the record and never on it.
    expect(recording.outboundCalls?.[0]?.atMs).toBeGreaterThanOrEqual(50);
    expect(Object.keys(recording)).toEqual(['outboundCalls']);
    const written = JSON.stringify(recording);
    for (const secret of ['token', 'abc', 'frag', 'User', 'pw', '0123456789abcdef0123456789abcdef']) expect(written).not.toContain(secret);
  });

  it('passes a streaming body and the caller’s AbortSignal through untouched, and never reads the body', async () => {
    const runtime = runtimeFetch(ok());
    const recording: OutboundRecording = {};
    const wrapped = recordingFetch(runtime.fn, () => recording);
    const body = new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode('chunk')); c.close(); } });
    const controller = new AbortController();
    const init = { method: 'PUT', body, signal: controller.signal, duplex: 'half' };
    await wrapped('https://api.example.com/upload', init);
    expect(runtime.calls[0]?.init).toBe(init);
    expect((runtime.calls[0]?.init as typeof init).signal).toBe(controller.signal);
    expect(body.locked).toBe(false);
  });

  it('reads the method and URL off a Request without touching its body', async () => {
    const runtime = runtimeFetch(ok());
    const recording: OutboundRecording = {};
    const request = new Request('https://api.example.com/v1/items', { method: 'PATCH', body: 'payload' });
    await recordingFetch(runtime.fn, () => recording)(request);
    expect(runtime.calls[0]?.input).toBe(request);
    expect(request.bodyUsed).toBe(false);
    expect(recording.outboundCalls?.[0]).toMatchObject({ host: 'api.example.com', path: '/v1/items', method: 'PATCH', outcome: 'ok' });
  });

  it('the refusal mark it reads is the one the egress worker writes, spelled the same in both', () => {
    // The worker is not a package this one can import, so its literal is read off its source
    // (a `READS` row in tools/ci-scope.mjs runs this suite when that file changes).
    const worker = readFileSync(new URL('../../../apps/vertical-egress/src/worker.ts', import.meta.url), 'utf8');
    const header = /^const EGRESS_HEADER = '([^']+)';$/m.exec(worker)?.[1];
    expect(header).toBe(EGRESS_REFUSAL_HEADER);
    // …and the value it marks a refusal with.
    expect(worker).toContain("[EGRESS_HEADER]: 'refused'");
  });

  it('a platform refusal is recorded as refused, not as the destination’s 403', async () => {
    const recording: OutboundRecording = {};
    const wrapped = recordingFetch(runtimeFetch(ok(403, { 'x-substrat-egress': 'refused' })).fn, () => recording);
    await wrapped('https://undeclared.example.com/oauth/token');
    expect(recording.outboundCalls?.[0]).toMatchObject({ status: 403, outcome: 'refused' });
  });

  it('a rejection is rethrown as the same error, and recorded by its class only', async () => {
    const cases: Array<[unknown, Record<string, unknown>]> = [
      [new DOMException('The operation timed out: https://x/?k=secret', 'TimeoutError'), { outcome: 'timeout' }],
      [new DOMException('aborted', 'AbortError'), { outcome: 'aborted' }],
      [new TypeError('Network connection lost to https://x/?k=secret'), { outcome: 'failed', reason: 'TypeError' }],
      ['a bare string', { outcome: 'failed' }],
    ];
    for (const [error, expected] of cases) {
      const recording: OutboundRecording = {};
      const wrapped = recordingFetch(runtimeFetch(() => Promise.reject(error)).fn, () => recording);
      await expect(wrapped('https://api.example.com/a')).rejects.toBe(error);
      expect(recording.outboundCalls).toEqual([{ host: 'api.example.com', path: '/a', method: 'GET', status: null, durationMs: expect.any(Number), atMs: expect.any(Number), ...expected }]);
      expect(JSON.stringify(recording)).not.toContain('secret');
    }
  });

  it('a recorder that throws never fails the call — reading the recording, or adding to it', async () => {
    const answer = { status: 200, headers: new Headers() };
    const throwing = recordingFetch(runtimeFetch(async () => answer).fn, () => {
      throw new Error('recorder bug');
    });
    expect(await throwing('https://api.example.com/a')).toBe(answer);
    const frozen = Object.freeze({ outboundCalls: Object.freeze([]) }) as unknown as OutboundRecording;
    expect(await recordingFetch(runtimeFetch(async () => answer).fn, () => frozen)('https://api.example.com/a')).toBe(answer);
    const unreadable = { get status(): number { throw new Error('no status'); }, headers: new Headers() };
    expect(await recordingFetch(runtimeFetch(async () => unreadable).fn, () => ({}))('https://api.example.com/a')).toBe(unreadable);
  });

  it('names 16 calls and counts the rest', async () => {
    const recording: OutboundRecording = {};
    const wrapped = recordingFetch(runtimeFetch(ok()).fn, () => recording);
    for (let i = 0; i < OUTBOUND_CALL_LOG_CAP + 4; i++) await wrapped(`https://api.example.com/n/${i}`);
    expect(recording.outboundCalls).toHaveLength(OUTBOUND_CALL_LOG_CAP);
    expect(recording.outboundCallsDropped).toBe(4);
  });

  it('a scope-store call is not recorded twice: it is already on the line as a store call', async () => {
    const recording: OutboundRecording = {};
    await recordingFetch(runtimeFetch(ok()).fn, () => recording)('https://store.substrat.internal/invoke', { method: 'POST' });
    expect(recording.outboundCalls).toBeUndefined();
  });
});

describe('installOutboundRecorder — once per isolate', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('never wraps twice, however often it is installed', async () => {
    const runtime = runtimeFetch(ok());
    globalThis.fetch = runtime.fn as unknown as typeof fetch;
    const recording: OutboundRecording = {};
    installOutboundRecorder(() => recording);
    const once = globalThis.fetch;
    installOutboundRecorder(() => recording);
    installOutboundRecorder(() => undefined);
    expect(globalThis.fetch).toBe(once);
    await globalThis.fetch('https://api.example.com/a');
    expect(runtime.calls).toHaveLength(1);
    expect(recording.outboundCalls).toHaveLength(1);
  });

  it('a fetch replaced since (a mock) is wrapped in turn', () => {
    installOutboundRecorder(() => undefined);
    const mock = runtimeFetch(ok()).fn as unknown as typeof fetch;
    globalThis.fetch = mock;
    installOutboundRecorder(() => undefined);
    expect(globalThis.fetch).not.toBe(mock);
  });
});

/** The invocation lines written while `fn` runs. */
async function linesOf(fn: () => Promise<unknown>): Promise<InvocationLogLine[]> {
  const lines: InvocationLogLine[] = [];
  const log = console.log;
  console.log = (first: unknown, ...rest: unknown[]) => {
    try {
      const parsed = typeof first === 'string' ? JSON.parse(first) : null;
      if (parsed?.substrat === 'invocation') return void lines.push(parsed);
    } catch {
      /* not ours */
    }
    log(first, ...rest);
  };
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return lines;
}

const SECRET = 'router-sekret';
const routed = {
  'x-substrat-router': SECRET,
  'x-substrat-tenant': '01JZ0000000000000000TEN001',
  'x-substrat-scope': '01JZ0000000000000000SCP001',
  'x-substrat-vertical': 'acme/widgets',
  'x-substrat-surface': 'app',
};
type Env = { ROUTER_SECRET?: string };
const ENV: Env = { ROUTER_SECRET: SECRET };

describe('the line names the request’s outbound calls (#2192)', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('the platform’s stamp: each request names its own calls, and a request with none has neither key', async () => {
    globalThis.fetch = runtimeFetch(async (input) =>
      String(input).includes('undeclared')
        ? { status: 403, headers: new Headers({ 'x-substrat-egress': 'refused' }) }
        : { status: 200, headers: new Headers() },
    ).fn as unknown as typeof fetch;
    const worker = withInvocationLog<Env>(
      {
        async fetch(request) {
          if (request.url.endsWith('/callback')) {
            await fetch('https://undeclared.example.com/oauth/token/0123456789abcdef0123456789abcdef?code=sekret-code', { method: 'POST' });
          }
          return new Response('{}');
        },
      },
      { routerSecret: (env) => env.ROUTER_SECRET },
    );
    const lines = await linesOf(async () => {
      await worker.fetch!(new Request('https://acme.example/callback', { headers: routed }), ENV, {});
      await worker.fetch!(new Request('https://acme.example/plain', { headers: routed }), ENV, {});
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.outboundCalls).toEqual([
      { host: 'undeclared.example.com', path: '/oauth/token/[redacted]', method: 'POST', status: 403, outcome: 'refused', durationMs: expect.any(Number), atMs: expect.any(Number) },
    ]);
    // Redacted on the way to the line, not only in the rule's own table.
    expect(JSON.stringify(lines[0])).not.toContain('sekret-code');
    expect(JSON.stringify(lines[0])).not.toContain('0123456789abcdef0123456789abcdef');
    expect(lines[1]).not.toHaveProperty('outboundCalls');
    expect(lines[1]).not.toHaveProperty('outboundCallsDropped');
  });

  it('the middleware on a dev server records the same way, and a call after the request is not on its line', async () => {
    globalThis.fetch = runtimeFetch(ok()).fn as unknown as typeof fetch;
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', invocationLog<Env>({ routerSecret: (env) => env.ROUTER_SECRET }));
    app.get('/api/sync', async (c) => {
      await fetch('https://api.example.com/v1/sync/3f2b8c1e-9a4d-4e2f-b6a1-0c9d8e7f6a5b');
      return c.json({});
    });
    const lines = await linesOf(async () => {
      await app.request('/api/sync', { headers: routed }, ENV);
      await fetch('https://api.example.com/after');
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.outboundCalls).toEqual([
      { host: 'api.example.com', path: '/v1/sync/[redacted]', method: 'GET', status: 200, outcome: 'ok', durationMs: expect.any(Number), atMs: expect.any(Number) },
    ]);
  });
});
