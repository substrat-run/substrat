import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataSubjectId, platformActorId, type Page, type PrincipalId } from '@substrat-run/contracts';
import {
  approvalDigest,
  type AssistantStreamBody,
  type AssistantStreamEvent,
} from '@substrat-run/contracts/assistant-stream';
import { manualClock, ulid, type ScopeStub } from '@substrat-run/kernel';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  ASSISTANT_PERM as PERM,
  MAX_EVENT_BYTES,
  MAX_MESSAGE_BYTES,
  acquireRun,
  appendEvents,
  assistantModule,
  claimExecution,
  createThread,
  resolveApproval,
  sendMessage,
  type Thread,
} from '../src/index.js';

/**
 * engine-assistant, tested through its real operations: each principal is a stub holding
 * exactly the keys a role would, so what is asserted is what a caller could do, not what the
 * in-scope functions would allow if called directly.
 *
 * The run principal stands in for the assistant host. A person never holds `assistant:run`.
 */

const CLOCK_AT = '2030-02-01T00:00:00.000Z';

type Who = { principal: PrincipalId; stub: ScopeStub };

/** The `{ code, reason, message }` an invocation was refused with, or `null` if it succeeded. */
async function refusal(p: Promise<unknown>): Promise<{ code: string; reason: unknown; message: string } | null> {
  try {
    await p;
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string; extensions?: { reason?: unknown } };
    return { code: e.code ?? 'unknown', reason: e.extensions?.reason, message: e.message ?? '' };
  }
}

/** The deployed version the requests in these tests are made, answered and run under. */
const VERSION = 'v-2030.1';
/** An hour after the clock starts. */
const EXPIRES_AT = '2030-02-01T01:00:00.000Z';
const NONCE = 'nonce_0123456789abcdef';
const OP = 'fit/log-set';

describe('engine-assistant', () => {
  let h: EngineHarness;
  let clock: ReturnType<typeof manualClock>;
  let owner: Who;
  let other: Who;
  let auditor: Who;
  let host: Who;
  let nobody: Who;

  const read = async (who: Who, threadId: string, after = 0) =>
    who.stub.invoke<{ events: AssistantStreamEvent[]; lastSeq: number }>('assistant/read-events', { threadId, after });
  const types = async (threadId: string) => (await read(owner, threadId)).events.map((e) => e.t);

  /** The host takes the lease and appends. */
  const acquire = (threadId: string, runId: string, staleMs?: number) =>
    host.stub.invoke<{ tookOver: boolean }>('assistant/acquire-run', { threadId, runId, ...(staleMs ? { staleMs } : {}) });
  const append = (threadId: string, runId: string, events: AssistantStreamBody[]) =>
    host.stub.invoke<{ events: AssistantStreamEvent[] }>('assistant/append-events', { threadId, runId, events });

  /** A thread with one user turn open and the host holding the lease on run `r1`. */
  const openTurn = async () => {
    const t = await owner.stub.invoke<Thread>('assistant/create-thread', { title: 'Squat' });
    await owner.stub.invoke('assistant/send-message', { threadId: t.id, text: 'log my set' });
    await acquire(t.id, 'r1');
    return t;
  };

  const LOG = { exercise: 'squat', reps: 5, weightKg: 105 };

  type RequestOptions = {
    callId?: string;
    tool?: string;
    operation?: string;
    input?: unknown;
    version?: string;
    expiresAt?: string;
    nonce?: string;
    approver?: string;
  };

  /** An approval request for `threadId`, with the digest the producer computes for it. */
  const request = async (threadId: string, o: RequestOptions = {}) => {
    const b = {
      callId: o.callId ?? 'c2',
      tool: o.tool ?? 'logSet',
      operation: o.operation ?? OP,
      input: o.input ?? LOG,
      version: o.version ?? VERSION,
      expiresAt: o.expiresAt ?? EXPIRES_AT,
      nonce: o.nonce ?? NONCE,
      step: 'propose',
    };
    const digest = await approvalDigest({
      version: b.version,
      approver: o.approver ?? owner.principal,
      thread: threadId,
      step: b.step,
      call: b.callId,
      operation: b.operation,
      expiresAt: b.expiresAt,
      nonce: b.nonce,
      input: b.input,
    });
    // The test's strings stand in for an instant; the engine parses them as the protocol does.
    const body = { t: 'approval-request', ...b, digest, preview: 'Log squat: 5 x 105 kg' } as AssistantStreamBody;
    return { body, digest };
  };

  /** Run a gated call as far as the approval request, and (by default) rest the turn on it. */
  const proposeGated = async (threadId: string, o: RequestOptions & { runId?: string; rest?: boolean } = {}) => {
    const { body, digest } = await request(threadId, o);
    const callId = o.callId ?? 'c2';
    await append(threadId, o.runId ?? 'r1', [
      { t: 'tool-input', callId, tool: o.tool ?? 'logSet', input: o.input ?? LOG },
      body,
      ...(o.rest === false ? [] : [{ t: 'turn-finish', reason: 'awaiting-approval' } as AssistantStreamBody]),
    ]);
    return digest;
  };

  /** The owner answers c2 (by default) under VERSION (by default). */
  const resolve = (who: Who, threadId: string, digest: string, approved: boolean, o: { callId?: string; version?: string } = {}) =>
    who.stub.invoke<{ seq: number }>('assistant/resolve-approval', {
      threadId,
      callId: o.callId ?? 'c2',
      digest,
      approved,
      version: o.version ?? VERSION,
    });

  beforeEach(async () => {
    clock = manualClock(CLOCK_AT);
    h = await engineHarness({ modules: [assistantModule], clock: clock.read });
    owner = await h.mintPrincipal([PERM.use]);
    other = await h.mintPrincipal([PERM.use]);
    auditor = await h.mintPrincipal([PERM.use, PERM.audit]);
    host = await h.mintPrincipal([PERM.run]);
    nobody = await h.mintPrincipal([]);
  });

  afterEach(async () => {
    await h.close();
  });

  // -------------------------------------------------------------------------
  // Threads, and whose they are
  // -------------------------------------------------------------------------

  describe('threads', () => {
    it('a thread belongs to the caller who opened it, and announces itself without any text', async () => {
      const t = await owner.stub.invoke<Thread>('assistant/create-thread', { title: 'Squat' });
      expect(t).toMatchObject({ subject: owner.principal, title: 'Squat', status: 'open', closedAt: null });
      const [e] = h.eventsOfType('assistant.thread-created');
      // Whose thread it is, is the envelope's pseudonymous key, so an erasure reaches it.
      expect(e!.payload).toEqual({ threadId: t.id });
      expect(e).toMatchObject({ piiClass: 'pseudonymous', subjectId: owner.principal });
      expect(JSON.stringify(e!.payload)).not.toContain('Squat');
    });

    it("lists only the caller's own threads, newest activity first", async () => {
      const a = await owner.stub.invoke<Thread>('assistant/create-thread', {});
      const b = await owner.stub.invoke<Thread>('assistant/create-thread', {});
      await other.stub.invoke('assistant/create-thread', {});
      clock.advance(1000);
      await owner.stub.invoke('assistant/send-message', { threadId: a.id, text: 'hi' });
      const page = await owner.stub.invoke<Page<Thread>>('assistant/list-threads', {});
      expect(page.entries.map((x) => x.id)).toEqual([a.id, b.id]);
    });

    it("another principal's threads need audit, and an auditor can read but never write", async () => {
      const t = await owner.stub.invoke<Thread>('assistant/create-thread', {});
      await owner.stub.invoke('assistant/send-message', { threadId: t.id, text: 'private' });

      expect((await refusal(other.stub.invoke('assistant/list-threads', { subject: owner.principal })))?.code).toBe('permission_denied');
      const seen = await auditor.stub.invoke<Page<Thread>>('assistant/list-threads', { subject: owner.principal });
      expect(seen.entries.map((x) => x.id)).toEqual([t.id]);
      expect((await read(auditor, t.id)).events.map((e) => e.t)).toEqual(['user-message', 'turn-start']);

      // Reading is what audit grants. Writing to somebody else's thread is not.
      expect((await refusal(auditor.stub.invoke('assistant/send-message', { threadId: t.id, text: 'x' })))?.code).toBe('not_found');
      expect((await refusal(auditor.stub.invoke('assistant/close-thread', { threadId: t.id })))?.code).toBe('not_found');
    });

    it("a stranger is told a thread does not exist, not that it is not theirs", async () => {
      const t = await owner.stub.invoke<Thread>('assistant/create-thread', {});
      for (const call of [
        other.stub.invoke('assistant/get-thread', { threadId: t.id }),
        other.stub.invoke('assistant/read-events', { threadId: t.id }),
        other.stub.invoke('assistant/send-message', { threadId: t.id, text: 'x' }),
      ]) {
        expect((await refusal(call))?.code).toBe('not_found');
      }
    });

    it('audit alone writes nothing and reads nothing: every operation checks use first', async () => {
      const auditOnly = await h.mintPrincipal([PERM.audit]);
      const t = await openTurn();
      const digest = await proposeGated(t.id);
      const calls: [string, unknown][] = [
        ['assistant/create-thread', {}],
        ['assistant/list-threads', { subject: owner.principal }],
        ['assistant/get-thread', { threadId: t.id }],
        ['assistant/read-events', { threadId: t.id }],
        ['assistant/send-message', { threadId: t.id, text: 'x' }],
        ['assistant/resolve-approval', { threadId: t.id, callId: 'c2', digest, approved: true, version: VERSION }],
        ['assistant/close-thread', { threadId: t.id }],
        ['assistant/acquire-run', { threadId: t.id, runId: 'r9' }],
        ['assistant/release-run', { threadId: t.id, runId: 'r1' }],
        ['assistant/append-events', { threadId: t.id, runId: 'r1', events: [{ t: 'step-start', step: 's' }] }],
        ['assistant/claim-execution', { threadId: t.id, runId: 'r1', callId: 'c2', operation: OP, version: VERSION, input: LOG }],
      ];
      for (const [op, input] of calls) {
        expect((await refusal(auditOnly.stub.invoke(op, input)))?.code, op).toBe('permission_denied');
      }
      expect(h.eventsOfType('assistant.approval-resolved')).toHaveLength(0);
    });

    it('a principal holding nothing is refused every operation', async () => {
      const t = await owner.stub.invoke<Thread>('assistant/create-thread', {});
      const calls: [string, unknown][] = [
        ['assistant/create-thread', {}],
        ['assistant/list-threads', {}],
        ['assistant/get-thread', { threadId: t.id }],
        ['assistant/read-events', { threadId: t.id }],
        ['assistant/send-message', { threadId: t.id, text: 'x' }],
        ['assistant/close-thread', { threadId: t.id }],
        ['assistant/acquire-run', { threadId: t.id, runId: 'r' }],
        ['assistant/release-run', { threadId: t.id, runId: 'r' }],
        ['assistant/append-events', { threadId: t.id, runId: 'r', events: [{ t: 'step-start', step: 's' }] }],
      ];
      for (const [op, input] of calls) {
        expect((await refusal(nobody.stub.invoke(op, input)))?.code, op).toBe('permission_denied');
      }
    });

    it('a closed thread takes nothing more, and closing twice is quiet', async () => {
      const t = await owner.stub.invoke<Thread>('assistant/create-thread', {});
      const closed = await owner.stub.invoke<Thread>('assistant/close-thread', { threadId: t.id });
      expect(closed.status).toBe('closed');
      await owner.stub.invoke('assistant/close-thread', { threadId: t.id });
      expect(h.eventsOfType('assistant.thread-closed')).toHaveLength(1);
      expect((await refusal(owner.stub.invoke('assistant/send-message', { threadId: t.id, text: 'x' })))?.reason).toBe('thread_closed');
      expect((await refusal(acquire(t.id, 'r1')))?.reason).toBe('thread_closed');
    });
  });

  // -------------------------------------------------------------------------
  // The record: append-only, numbered, resumable
  // -------------------------------------------------------------------------

  describe('the record', () => {
    it('a message is two numbered events, and a turn-started milestone with no text', async () => {
      const t = await owner.stub.invoke<Thread>('assistant/create-thread', {});
      const sent = await owner.stub.invoke('assistant/send-message', { threadId: t.id, text: 'log my set' });
      expect(sent).toEqual({ firstSeq: 1, lastSeq: 2 });
      expect((await read(owner, t.id)).events).toEqual([
        { t: 'user-message', text: 'log my set', id: 1 },
        { t: 'turn-start', v: 1, id: 2 },
      ]);
      const [e] = h.eventsOfType('assistant.turn-started');
      expect(JSON.stringify(e!.payload)).not.toContain('log my set');
      expect(e).toMatchObject({ piiClass: 'pseudonymous', subjectId: owner.principal });
    });

    it('a message is bounded in bytes, and a refusal of one speaks of the message', async () => {
      const t = await owner.stub.invoke<Thread>('assistant/create-thread', {});
      // 22 000 CJK characters: under the protocol's 32 000 characters, 66 000 bytes.
      const wide = await refusal(owner.stub.invoke('assistant/send-message', { threadId: t.id, text: '中'.repeat(22_000) }));
      // Refused by the input schema (an HTTP caller sees `validation_failed`), as a message.
      expect(wide?.message).toContain('the message is 66002 bytes; a message may be at most 32768 bytes');
      expect(wide?.message).not.toContain('tool result');
      // Escapes count: 6 000 control characters are 36 002 bytes once serialised.
      expect(
        (await refusal(owner.stub.invoke('assistant/send-message', { threadId: t.id, text: '\u0001'.repeat(6_000) })))?.message,
      ).toContain('the message is 36002 bytes');
      expect(await types(t.id)).toEqual([]);
      // At the bound it is kept, whole.
      const fits = '中'.repeat(Math.floor((MAX_MESSAGE_BYTES - 2) / 3));
      await owner.stub.invoke('assistant/send-message', { threadId: t.id, text: fits });
      expect((await read(owner, t.id)).events[0]).toMatchObject({ t: 'user-message', text: fits });
    });

    it('reads after a cursor, exactly, and reports where it got to', async () => {
      const t = await openTurn();
      await append(t.id, 'r1', [
        { t: 'text-start', pid: 'p1' },
        { t: 'text-delta', pid: 'p1', delta: 'Hello' },
        { t: 'text-end', pid: 'p1' },
      ]);
      const page = await read(owner, t.id, 2);
      expect(page.events.map((e) => e.id)).toEqual([3, 4, 5]);
      expect(page.lastSeq).toBe(5);
      expect(await read(owner, t.id, 5)).toEqual({ events: [], lastSeq: 5 });
    });

    it('a message is refused while the assistant is still answering the last one', async () => {
      const t = await openTurn();
      expect((await refusal(owner.stub.invoke('assistant/send-message', { threadId: t.id, text: 'again' })))?.reason).toBe('turn_in_progress');
      await append(t.id, 'r1', [{ t: 'turn-finish', reason: 'done' }]);
      await owner.stub.invoke('assistant/send-message', { threadId: t.id, text: 'again' });
    });

    it('assistant events cannot be written without the run key, by a person or by nobody', async () => {
      const t = await openTurn();
      const ev = [{ t: 'text-start', pid: 'p1' }];
      expect((await refusal(owner.stub.invoke('assistant/append-events', { threadId: t.id, runId: 'r1', events: ev })))?.code).toBe('permission_denied');
      expect((await refusal(owner.stub.invoke('assistant/acquire-run', { threadId: t.id, runId: 'x' })))?.code).toBe('permission_denied');
      expect(await types(t.id)).toEqual(['user-message', 'turn-start']);
    });

    it("the run cannot write the user's side of the record", async () => {
      const t = await openTurn();
      for (const body of [
        { t: 'user-message', text: 'I agree' },
        { t: 'turn-start', v: 1 },
        { t: 'approval-resolved', callId: 'c2', approved: true, approver: owner.principal, digest: 'a'.repeat(64) },
      ] as AssistantStreamBody[]) {
        expect((await refusal(append(t.id, 'r1', [body])))?.reason, body.t).toBe('not_a_run_event');
      }
    });

    it('a run writes only inside an open turn, so it cannot hold a resting thread', async () => {
      // A thread nobody has spoken in has no turn.
      const fresh = await owner.stub.invoke<Thread>('assistant/create-thread', {});
      await acquire(fresh.id, 'r1');
      expect((await refusal(append(fresh.id, 'r1', [{ t: 'step-start', step: 's' }])))?.reason).toBe('no_turn_open');

      const t = await openTurn();
      // Resting the turn and writing on in the same batch is refused whole.
      expect(
        (await refusal(append(t.id, 'r1', [{ t: 'turn-finish', reason: 'done' }, { t: 'step-start', step: 's' }])))?.reason,
      ).toBe('no_turn_open');
      expect(await types(t.id)).toEqual(['user-message', 'turn-start']);
      // After the turn rests, nothing more, and the owner can speak.
      await append(t.id, 'r1', [{ t: 'turn-finish', reason: 'done' }]);
      expect((await refusal(append(t.id, 'r1', [{ t: 'step-start', step: 's' }])))?.reason).toBe('no_turn_open');
      await owner.stub.invoke('assistant/send-message', { threadId: t.id, text: 'next' });
      // The same after a turn-error.
      await append(t.id, 'r1', [{ t: 'turn-error', code: 'model_down', message: 'Try again.' }]);
      expect((await refusal(append(t.id, 'r1', [{ t: 'step-start', step: 's' }])))?.reason).toBe('no_turn_open');
    });

    it('an answer to an approval reopens the turn for the run', async () => {
      const t = await openTurn();
      const digest = await proposeGated(t.id);
      expect((await refusal(append(t.id, 'r1', [{ t: 'step-start', step: 's' }])))?.reason).toBe('no_turn_open');
      await resolve(owner, t.id, digest, false);
      await append(t.id, 'r1', [{ t: 'turn-finish', reason: 'done' }]);
    });

    it('a batch is all or nothing', async () => {
      const t = await openTurn();
      const before = await types(t.id);
      const bad = await refusal(
        append(t.id, 'r1', [{ t: 'text-start', pid: 'p1' }, { t: 'user-message', text: 'forged' }]),
      );
      expect(bad?.reason).toBe('not_a_run_event');
      expect(await types(t.id)).toEqual(before);
    });

    // The protocol bounds each field (a text delta at 16 000 characters, a tool output at
    // 32 KiB), but a delta of characters JSON escapes is still more bytes than that, which is
    // the event bound's work.
    it('an event over the size bound is refused, and one just under it is kept', async () => {
      const t = await openTurn();
      // 10 000 × 6 bytes escaped: 60 000 bytes, kept.
      await append(t.id, 'r1', [{ t: 'text-delta', pid: 'p1', delta: '\u0001'.repeat(10_000) }]);
      // 11 000 × 6 bytes: 66 000, over MAX_EVENT_BYTES.
      const over = await refusal(append(t.id, 'r1', [{ t: 'text-delta', pid: 'p1', delta: '\u0001'.repeat(11_000) }]));
      expect(over?.code).toBe('validation_failed');
      expect(over?.message).toContain(`a text-delta event is over ${MAX_EVENT_BYTES} bytes`);
    });

    it('counts a multi-byte character as the bytes it is', async () => {
      const t = await openTurn();
      // 6 000 escaped (36 000 bytes) and 10 000 '€' (3 bytes each, 30 000): 46 000 characters
      // serialised, but over 64 KiB in bytes.
      const wide = '\u0001'.repeat(6_000) + '€'.repeat(10_000);
      expect((await refusal(append(t.id, 'r1', [{ t: 'text-delta', pid: 'p1', delta: wide }])))?.code).toBe('validation_failed');
    });
  });

  // -------------------------------------------------------------------------
  // The lease: one writer, and a zombie is fenced
  // -------------------------------------------------------------------------

  describe('the run lease', () => {
    it('only the holder appends', async () => {
      const t = await openTurn();
      expect((await refusal(append(t.id, 'someone-else', [{ t: 'step-start', step: 's' }])))?.reason).toBe('run_fenced');
      const none = await owner.stub.invoke<Thread>('assistant/create-thread', {});
      expect((await refusal(append(none.id, 'r1', [{ t: 'step-start', step: 's' }])))?.reason).toBe('run_fenced');
    });

    it('a second run is refused while the first keeps beating, and replaces it once it stops', async () => {
      const t = await openTurn();
      expect((await refusal(acquire(t.id, 'r2')))?.reason).toBe('run_in_progress');
      // The holder beats by appending.
      clock.advance(10_000);
      await append(t.id, 'r1', [{ t: 'step-start', step: 's' }]);
      clock.advance(10_000);
      expect((await refusal(acquire(t.id, 'r2')))?.reason).toBe('run_in_progress');
      // It stops. After the stale window another run may take over.
      clock.advance(20_000);
      expect(await acquire(t.id, 'r2')).toEqual({ tookOver: true });
    });

    it('the same run asking again is not a takeover', async () => {
      const t = await openTurn();
      expect(await acquire(t.id, 'r1')).toEqual({ tookOver: false });
    });

    it('a holder that was replaced while still running cannot write (a zombie is fenced)', async () => {
      const t = await openTurn();
      clock.advance(60_000);
      await acquire(t.id, 'r2');
      expect((await refusal(append(t.id, 'r1', [{ t: 'text-start', pid: 'late' }])))?.reason).toBe('run_fenced');
      await append(t.id, 'r2', [{ t: 'text-start', pid: 'p1' }]);
      expect((await types(t.id)).filter((x) => x === 'text-start')).toHaveLength(1);
    });

    it('release gives the lease back once; a run that lost it releases nothing', async () => {
      const t = await openTurn();
      clock.advance(60_000);
      await acquire(t.id, 'r2');
      expect(await host.stub.invoke('assistant/release-run', { threadId: t.id, runId: 'r1' })).toEqual({ released: false });
      expect(await host.stub.invoke('assistant/release-run', { threadId: t.id, runId: 'r2' })).toEqual({ released: true });
      expect(await acquire(t.id, 'r3')).toEqual({ tookOver: false });
    });
  });

  // -------------------------------------------------------------------------
  // Tool calls, and the approval that gates a write
  // -------------------------------------------------------------------------

  describe('tool calls', () => {
    it('an ungated call runs input then output; output with no input is refused', async () => {
      const t = await openTurn();
      expect((await refusal(append(t.id, 'r1', [{ t: 'tool-output', callId: 'c1', tool: 'getSessions', output: {} }])))?.reason).toBe('call_state');
      await append(t.id, 'r1', [
        { t: 'tool-input', callId: 'c1', tool: 'getSessions', input: { limit: 4 } },
        { t: 'tool-output', callId: 'c1', tool: 'getSessions', output: { sessions: [] } },
      ]);
      // A finished call cannot be finished again, nor restarted.
      expect((await refusal(append(t.id, 'r1', [{ t: 'tool-output', callId: 'c1', tool: 'getSessions', output: {} }])))?.reason).toBe('call_state');
      expect((await refusal(append(t.id, 'r1', [{ t: 'tool-input', callId: 'c1', tool: 'getSessions', input: {} }])))?.reason).toBe('call_state');
    });

    it('a step restart may repeat a call that is still running', async () => {
      const t = await openTurn();
      await append(t.id, 'r1', [{ t: 'tool-input', callId: 'c1', tool: 'getSessions', input: {} }]);
      await append(t.id, 'r1', [
        { t: 'step-restart', step: 'lookup' },
        { t: 'tool-input', callId: 'c1', tool: 'getSessions', input: {} },
      ]);
      expect((await refusal(append(t.id, 'r1', [{ t: 'tool-input', callId: 'c1', tool: 'otherTool', input: {} }])))?.reason).toBe('call_state');
    });

    it('a failed call is recorded as failed and cannot then succeed', async () => {
      const t = await openTurn();
      await append(t.id, 'r1', [
        { t: 'tool-input', callId: 'c1', tool: 'getSessions', input: {} },
        { t: 'tool-error', callId: 'c1', tool: 'getSessions', message: 'You may not do that.' },
      ]);
      expect((await refusal(append(t.id, 'r1', [{ t: 'tool-output', callId: 'c1', tool: 'getSessions', output: {} }])))?.reason).toBe('call_state');
    });

    it("an approval request must carry the digest of its own bindings, with the thread's subject as approver", async () => {
      const t = await openTurn();
      await append(t.id, 'r1', [{ t: 'tool-input', callId: 'c2', tool: 'logSet', input: LOG }]);
      const { body } = await request(t.id);
      // The digest of another input, another approver, another thread: each refused.
      for (const wrong of [
        (await request(t.id, { input: { ...LOG, weightKg: 200 } })).digest,
        (await request(t.id, { approver: other.principal })).digest,
        (await request('01JOTHERTHREAD0000000000000')).digest,
      ]) {
        expect((await refusal(append(t.id, 'r1', [{ ...body, digest: wrong } as AssistantStreamBody])))?.reason).toBe('digest_mismatch');
      }
      // And only for a call that was proposed.
      const nope = await request(t.id, { callId: 'nope' });
      expect((await refusal(append(t.id, 'r1', [nope.body])))?.reason).toBe('call_state');
    });

    it('an approval request that has already expired is refused', async () => {
      const t = await openTurn();
      await append(t.id, 'r1', [{ t: 'tool-input', callId: 'c2', tool: 'logSet', input: LOG }]);
      const { body } = await request(t.id, { expiresAt: CLOCK_AT });
      expect((await refusal(append(t.id, 'r1', [body])))?.reason).toBe('approval_expired');
    });

    it('the approval milestone names the call, never what was asked nor its digest', async () => {
      const t = await openTurn();
      const digest = await proposeGated(t.id);
      const [e] = h.eventsOfType('assistant.approval-requested');
      expect(e!.payload).toEqual({ threadId: t.id, callId: 'c2', tool: 'logSet' });
      expect(e).toMatchObject({ piiClass: 'pseudonymous', subjectId: owner.principal });
      // Judged by shape, never by a substring: the ids in the payload are random, so a short
      // literal such as the weight can occur in one by chance (a shard once failed on `…W105`).
      const payload = e!.payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['callId', 'threadId', 'tool']);
      expect(JSON.stringify(payload)).not.toContain(digest); // 64 hex characters: no id can contain it
      for (const [field, value] of Object.entries(LOG)) {
        expect(Object.values(payload), field).not.toContain(value);
      }
      expect(JSON.stringify(payload)).not.toContain(JSON.stringify(LOG));
    });

    it('a turn rests awaiting approval only with one waiting, and finishes done only with none', async () => {
      const t = await openTurn();
      expect((await refusal(append(t.id, 'r1', [{ t: 'turn-finish', reason: 'awaiting-approval' }])))?.reason).toBe('no_approval_pending');
      await proposeGated(t.id, { rest: false });
      expect((await refusal(append(t.id, 'r1', [{ t: 'turn-finish', reason: 'done' }])))?.reason).toBe('approval_pending');
      await append(t.id, 'r1', [{ t: 'turn-finish', reason: 'awaiting-approval' }]);
      expect(h.eventsOfType('assistant.turn-finished').map((e) => (e.payload as { reason: string }).reason)).toEqual(['awaiting-approval']);
    });

    describe('resolving an approval', () => {
      it('is the owner’s, with the digest shown, and appends the user’s side of the record', async () => {
        const t = await openTurn();
        const digest = await proposeGated(t.id);
        const r = await resolve(owner, t.id, digest, true);
        const events = (await read(owner, t.id)).events;
        // The record names who answered and echoes what they agreed to.
        expect(events[events.length - 1]).toEqual({
          t: 'approval-resolved',
          callId: 'c2',
          approved: true,
          approver: owner.principal,
          digest,
          id: r.seq,
        });
        const [e] = h.eventsOfType('assistant.approval-resolved');
        expect(e!.payload).toEqual({ threadId: t.id, callId: 'c2', tool: 'logSet', approved: true });
        expect(e).toMatchObject({ piiClass: 'pseudonymous', subjectId: owner.principal });
      });

      it('refuses a digest for a different input, and leaves the request waiting', async () => {
        const t = await openTurn();
        await proposeGated(t.id);
        const { digest: other256 } = await request(t.id, { input: { ...LOG, weightKg: 200 } });
        expect((await refusal(resolve(owner, t.id, other256, true)))?.reason).toBe('digest_mismatch');
        expect((await refusal(owner.stub.invoke('assistant/send-message', { threadId: t.id, text: 'x' })))?.reason).toBe('approval_pending');
      });

      it('binds the thread and the operation: one input approved for archive on A is not an approval for delete on B', async () => {
        const id = { id: '01JTODO0000000000000000000' };
        const a = await openTurn();
        const onA = await proposeGated(a.id, { tool: 'archive', operation: 'todo/archive', input: id });
        const b = await openTurn();
        const onB = await proposeGated(b.id, { tool: 'delete', operation: 'todo/delete', input: id });
        expect(onA).not.toBe(onB);
        expect((await refusal(resolve(owner, b.id, onA, true)))?.reason).toBe('digest_mismatch');
        // A's own approval still works, on A.
        await resolve(owner, a.id, onA, true);
      });

      it('is refused under another deployed version than the request was made under', async () => {
        const t = await openTurn();
        const digest = await proposeGated(t.id);
        expect((await refusal(resolve(owner, t.id, digest, true, { version: 'v-2030.2' })))?.reason).toBe('digest_mismatch');
        expect(h.eventsOfType('assistant.approval-resolved')).toHaveLength(0);
      });

      it('is refused under another version even with the digest recomputed for that version', async () => {
        // Every binding is in the request event, so a client can compute the digest the
        // request WOULD have had under the version now served. That is not what was shown.
        const t = await openTurn();
        const shown = await proposeGated(t.id);
        const { digest: forV2 } = await request(t.id, { version: 'v-2030.2' });
        expect(forV2).not.toBe(shown);
        expect((await refusal(resolve(owner, t.id, forV2, true, { version: 'v-2030.2' })))?.reason).toBe('digest_mismatch');
        expect(h.eventsOfType('assistant.approval-resolved')).toHaveLength(0);
        // Still waiting, so nothing can be claimed under either version.
        await host.stub.invoke('assistant/release-run', { threadId: t.id, runId: 'r1' });
        await acquire(t.id, 'r2');
        for (const version of [VERSION, 'v-2030.2']) {
          expect(
            (await refusal(
              host.stub.invoke('assistant/claim-execution', { threadId: t.id, runId: 'r2', callId: 'c2', operation: OP, version, input: LOG }),
            ))?.reason,
          ).toBe('approval_required');
        }
      });

      it('a denial ends the wait, not the turn: the host runs after it and rests the turn', async () => {
        const t = await openTurn();
        const digest = await proposeGated(t.id);
        await resolve(owner, t.id, digest, false);
        expect((await refusal(owner.stub.invoke('assistant/send-message', { threadId: t.id, text: 'x' })))?.reason).toBe('turn_in_progress');
        await append(t.id, 'r1', [{ t: 'turn-finish', reason: 'done' }]);
        await owner.stub.invoke('assistant/send-message', { threadId: t.id, text: 'x' });
      });

      it('is refused at and after the expiry, and a lapsed request can still be denied', async () => {
        const t = await openTurn();
        const digest = await proposeGated(t.id);
        clock.advance(60 * 60 * 1000); // exactly EXPIRES_AT
        expect((await refusal(resolve(owner, t.id, digest, true)))?.reason).toBe('approval_expired');
        // Saying no runs nothing, so a lapsed request (or one a deploy made stale) is cleared by
        // a denial, under any version, and the thread is not held by it.
        await resolve(owner, t.id, digest, false, { version: 'v-2030.2' });
        expect((await read(owner, t.id)).events.at(-1)).toMatchObject({ t: 'approval-resolved', approved: false });
      });

      it('a denial must still name the request it denies', async () => {
        const t = await openTurn();
        await proposeGated(t.id);
        const { digest: other256 } = await request(t.id, { input: { ...LOG, weightKg: 200 } });
        expect((await refusal(resolve(owner, t.id, other256, false)))?.reason).toBe('digest_mismatch');
      });

      it("is not another principal's to give, even with audit", async () => {
        const t = await openTurn();
        const digest = await proposeGated(t.id);
        for (const who of [other, auditor]) {
          expect((await refusal(resolve(who, t.id, digest, true)))?.code).toBe('not_found');
        }
        expect(h.eventsOfType('assistant.approval-resolved')).toHaveLength(0);
      });

      it('can be given once', async () => {
        const t = await openTurn();
        const digest = await proposeGated(t.id);
        await resolve(owner, t.id, digest, false);
        expect((await refusal(resolve(owner, t.id, digest, true)))?.reason).toBe('already_resolved');
      });

      it('is single-use by its own write: two answers that both read it waiting record one', async () => {
        // Both answers read the call as waiting before either writes (each awaits the digest
        // between its read and its write), which no queue in front of the engine prevents
        // when a host composes these calls itself. Only the conditional write tells them apart.
        const outcome = await h.run(async (ctx) => {
          const t = createThread(ctx);
          sendMessage(ctx, { threadId: t.id, text: 'log my set' });
          acquireRun(ctx, { threadId: t.id, runId: 'r1' });
          const { body, digest } = await request(t.id, { approver: String(ctx.principal) });
          await appendEvents(ctx, { threadId: t.id, runId: 'r1', events: [{ t: 'tool-input', callId: 'c2', tool: 'logSet', input: LOG }, body] });
          const answer = { threadId: t.id, callId: 'c2', digest, approved: true, version: VERSION };
          const settled = await Promise.allSettled([resolveApproval(ctx, answer), resolveApproval(ctx, answer)]);
          return settled.map((s) => (s.status === 'fulfilled' ? 'ok' : (s.reason as { extensions?: { reason?: string } }).extensions?.reason));
        }, [PERM.use]);
        // The property is that exactly one answer wins, not which: the two promises race.
        expect([...outcome].sort()).toEqual(['already_resolved', 'ok']);
        expect(h.eventsOfType('assistant.approval-resolved')).toHaveLength(1);
      });

      it('answers not_found for a call that was never proposed', async () => {
        const t = await openTurn();
        const { digest } = await request(t.id);
        expect((await refusal(resolve(owner, t.id, digest, true, { callId: 'zzz' })))?.code).toBe('not_found');
      });
    });

    describe('executing a gated call', () => {
      /** Approve c2 and have the host start the next run. */
      const approveAndResume = async (approved = true, o: RequestOptions = {}) => {
        const t = await openTurn();
        const digest = await proposeGated(t.id, o);
        await host.stub.invoke('assistant/release-run', { threadId: t.id, runId: 'r1' });
        await resolve(owner, t.id, digest, approved);
        await acquire(t.id, 'r2');
        return { t, digest };
      };
      const claim = (threadId: string, input: unknown, runId = 'r2', o: { operation?: string; version?: string } = {}) =>
        host.stub.invoke('assistant/claim-execution', {
          threadId,
          runId,
          callId: 'c2',
          operation: o.operation ?? OP,
          version: o.version ?? VERSION,
          input,
        });
      const output = (threadId: string, runId = 'r2') =>
        append(threadId, runId, [{ t: 'tool-output', callId: 'c2', tool: 'logSet', output: { ok: true } }]);

      it('produces no output before it is approved, or when it was denied, or when nobody claimed it', async () => {
        const t = await openTurn();
        await proposeGated(t.id, { rest: false });
        // r1 still holds the lease and the turn is open; the output is what is refused.
        expect((await refusal(output(t.id, 'r1')))?.reason).toBe('approval_required');
        expect((await refusal(claim(t.id, LOG, 'r1')))?.reason).toBe('approval_required');

        const denied = await approveAndResume(false);
        expect((await refusal(claim(denied.t.id, LOG)))?.reason).toBe('approval_denied');
        expect((await refusal(output(denied.t.id)))?.reason).toBe('approval_denied');

        const approved = await approveAndResume(true);
        expect((await refusal(output(approved.t.id)))?.reason).toBe('execution_not_claimed');
      });

      it('is claimed with the input the user saw, and no other', async () => {
        const { t } = await approveAndResume();
        expect((await refusal(claim(t.id, { ...LOG, weightKg: 200 })))?.reason).toBe('digest_mismatch');
        expect((await refusal(claim(t.id, { ...LOG, extra: true })))?.reason).toBe('digest_mismatch');
        // Key order is not content.
        expect(await claim(t.id, { weightKg: 105, reps: 5, exercise: 'squat' })).toEqual({ claimed: true });
      });

      it('is claimed for the operation the user approved, and no other', async () => {
        const id = { id: '01JTODO0000000000000000000' };
        const { t } = await approveAndResume(true, { tool: 'archive', operation: 'todo/archive', input: id });
        expect((await refusal(claim(t.id, id, 'r2', { operation: 'todo/delete' })))?.reason).toBe('digest_mismatch');
        expect(await claim(t.id, id, 'r2', { operation: 'todo/archive' })).toEqual({ claimed: true });
      });

      it('is claimed under the deployed version the user approved, and no other', async () => {
        const { t } = await approveAndResume();
        expect((await refusal(claim(t.id, LOG, 'r2', { version: 'v-2030.2' })))?.reason).toBe('digest_mismatch');
        expect(await claim(t.id, LOG)).toEqual({ claimed: true });
      });

      it('is not claimed once the approval has expired: an approval not spent in time runs nothing', async () => {
        const { t } = await approveAndResume();
        clock.advance(60 * 60 * 1000); // exactly EXPIRES_AT
        await acquire(t.id, 'r2');
        expect((await refusal(claim(t.id, LOG)))?.reason).toBe('approval_expired');
        expect((await refusal(output(t.id)))?.reason).toBe('execution_not_claimed');
      });

      it('is claimed once by its own write: two claims that both read it approved run one', async () => {
        const outcome = await h.run(async (ctx) => {
          const t = createThread(ctx);
          sendMessage(ctx, { threadId: t.id, text: 'log my set' });
          acquireRun(ctx, { threadId: t.id, runId: 'r1' });
          const { body, digest } = await request(t.id, { approver: String(ctx.principal) });
          await appendEvents(ctx, { threadId: t.id, runId: 'r1', events: [{ t: 'tool-input', callId: 'c2', tool: 'logSet', input: LOG }, body] });
          await resolveApproval(ctx, { threadId: t.id, callId: 'c2', digest, approved: true, version: VERSION });
          const go = { threadId: t.id, runId: 'r1', callId: 'c2', operation: OP, version: VERSION, input: LOG };
          const settled = await Promise.allSettled([claimExecution(ctx, go), claimExecution(ctx, go)]);
          return settled.map((s) => (s.status === 'fulfilled' ? 'ok' : (s.reason as { extensions?: { reason?: string } }).extensions?.reason));
        }, [PERM.use, PERM.run]);
        // The property is that exactly one claim wins, not which: the two promises race.
        expect([...outcome].sort()).toEqual(['already_executed', 'ok']);
      });

      it('is claimed once: a restarted loop cannot run the write twice', async () => {
        const { t } = await approveAndResume();
        await claim(t.id, LOG);
        expect((await refusal(claim(t.id, LOG)))?.reason).toBe('already_executed');
        await output(t.id);
        expect((await refusal(claim(t.id, LOG)))?.reason).toBe('already_executed');
        expect((await refusal(output(t.id)))?.reason).toBe('call_state');
      });

      it('is fenced by the lease', async () => {
        const { t } = await approveAndResume();
        expect((await refusal(claim(t.id, LOG, 'r1')))?.reason).toBe('run_fenced');
      });

      it('needs the run key to claim', async () => {
        const { t } = await approveAndResume();
        expect(
          (await refusal(
            owner.stub.invoke('assistant/claim-execution', { threadId: t.id, runId: 'r2', callId: 'c2', operation: OP, version: VERSION, input: LOG }),
          ))?.code,
        ).toBe('permission_denied');
      });

      it('an ungated call has nothing to claim', async () => {
        const t = await openTurn();
        await append(t.id, 'r1', [{ t: 'tool-input', callId: 'c1', tool: 'getSessions', input: {} }]);
        expect(
          (await refusal(
            host.stub.invoke('assistant/claim-execution', { threadId: t.id, runId: 'r1', callId: 'c1', operation: OP, version: VERSION, input: {} }),
          ))?.reason,
        ).toBe('call_state');
      });

      it('a full approved turn ends done, with the milestones in order', async () => {
        const { t } = await approveAndResume();
        await claim(t.id, LOG);
        await append(t.id, 'r2', [
          { t: 'tool-output', callId: 'c2', tool: 'logSet', output: { ok: true } },
          { t: 'turn-finish', reason: 'done' },
        ]);
        await owner.stub.invoke('assistant/send-message', { threadId: t.id, text: 'thanks' });
        expect(h.eventsOfType('assistant.turn-finished').map((e) => (e.payload as { reason: string }).reason)).toEqual([
          'awaiting-approval',
          'done',
        ]);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Erasure
  // -------------------------------------------------------------------------

  describe('erasing a person', () => {
    it('deletes their threads, events, calls and lease, and leaves other people’s alone', async () => {
      const t = await openTurn();
      const digest = await proposeGated(t.id);
      await resolve(owner, t.id, digest, false);
      await owner.stub.invoke('assistant/close-thread', { threadId: t.id });
      // A second thread of theirs, with the lease still held on it.
      const t2 = await openTurn();
      const keep = await other.stub.invoke<Thread>('assistant/create-thread', {});
      await other.stub.invoke('assistant/send-message', { threadId: keep.id, text: 'mine' });

      const staff = platformActorId.parse(ulid());
      const receipt = await h.host.admin.shredSubject(staff, h.tenant, h.scope, dataSubjectId.parse(owner.principal));
      expect(receipt.verticalRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ entityType: 'assistant-thread', mode: 'delete', rows: 2 }),
          expect.objectContaining({ entityType: 'assistant-event', mode: 'delete' }),
          expect.objectContaining({ entityType: 'assistant-tool-call', mode: 'delete', rows: 1 }),
          expect.objectContaining({ entityType: 'assistant-run', mode: 'delete', rows: 1 }),
        ]),
      );
      expect(receipt.unreachedEntities ?? []).toEqual([]);

      expect((await refusal(auditor.stub.invoke('assistant/get-thread', { threadId: t.id })))?.code).toBe('not_found');
      expect((await read(other, keep.id)).events.map((e) => e.t)).toEqual(['user-message', 'turn-start']);

      // The outbox: every milestone about the erased person's thread is redacted. What stays is
      // the envelope (§5.3 keeps the pseudonymous key and the fact something happened): no
      // payload names the thread, the person or an input digest.
      const types6 = [
        'assistant.thread-created',
        'assistant.turn-started',
        'assistant.turn-finished',
        'assistant.approval-requested',
        'assistant.approval-resolved',
        'assistant.thread-closed',
      ];
      const theirs = types6.flatMap((type) => h.eventsOfType(type)).filter((e) => e.entity.entityId === t.id || e.entity.entityId === t2.id);
      expect(new Set(theirs.map((e) => e.type))).toEqual(new Set(types6));
      for (const e of theirs) {
        expect(e.payload, e.type).toBeNull();
      }
      const everything = JSON.stringify(types6.flatMap((type) => h.eventsOfType(type)).map((e) => e.payload));
      expect(everything).not.toContain(owner.principal);
      expect(everything).not.toContain(digest);
      // The other person's milestones are untouched.
      const [kept] = h.eventsOfType('assistant.thread-created').filter((e) => e.entity.entityId === keep.id);
      expect(kept!.payload).toEqual({ threadId: keep.id });
    });
  });
});
