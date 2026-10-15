import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  approvalDigest,
  dataSubjectId,
  platformActorId,
  type AssistantStreamBody,
  type AssistantStreamEvent,
  type Page,
  type PrincipalId,
} from '@substrat-run/contracts';
import { manualClock, ulid, type ScopeStub } from '@substrat-run/kernel';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import { ASSISTANT_PERM as PERM, MAX_EVENT_BYTES, assistantModule, type Thread } from '../src/index.js';

/**
 * engine-assistant, tested through its real operations: each principal is a stub holding
 * exactly the keys a role would, so what is asserted is what a caller could do, not what the
 * in-scope functions would allow if called directly.
 *
 * The run principal stands in for the assistant host. A person never holds `assistant:run`.
 */

const CLOCK_AT = '2030-02-01T00:00:00.000Z';

type Who = { principal: PrincipalId; stub: ScopeStub };

/** The `{ code, reason }` an invocation was refused with, or `null` if it succeeded. */
async function refusal(p: Promise<unknown>): Promise<{ code: string; reason: unknown } | null> {
  try {
    await p;
    return null;
  } catch (err) {
    const e = err as { code?: string; extensions?: { reason?: unknown } };
    return { code: e.code ?? 'unknown', reason: e.extensions?.reason };
  }
}

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

  /** Run a gated call as far as the approval request, and rest the turn on it. */
  const proposeGated = async (threadId: string, runId = 'r1', callId = 'c2') => {
    const digest = await approvalDigest(LOG);
    await append(threadId, runId, [
      { t: 'tool-input', callId, tool: 'logSet', input: LOG },
      { t: 'approval-request', callId, tool: 'logSet', input: LOG, digest, preview: 'Log squat: 5 x 105 kg' },
      { t: 'turn-finish', reason: 'awaiting-approval' },
    ]);
    return digest;
  };

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
      expect(e!.payload).toEqual({ threadId: t.id, subject: owner.principal });
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
        { t: 'turn-start', id: 2 },
      ]);
      const [e] = h.eventsOfType('assistant.turn-started');
      expect(JSON.stringify(e!.payload)).not.toContain('log my set');
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
        { t: 'turn-start' },
        { t: 'approval-resolved', callId: 'c2', approved: true },
      ] as AssistantStreamBody[]) {
        expect((await refusal(append(t.id, 'r1', [body])))?.reason, body.t).toBe('not_a_run_event');
      }
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

    it('an event over the size bound is refused, and one just under it is kept', async () => {
      const t = await openTurn();
      await append(t.id, 'r1', [{ t: 'tool-input', callId: 'c1', tool: 'getSessions', input: {} }]);
      const under = 'x'.repeat(MAX_EVENT_BYTES - 200);
      await append(t.id, 'r1', [{ t: 'tool-output', callId: 'c1', tool: 'getSessions', output: under }]);
      await append(t.id, 'r1', [{ t: 'tool-input', callId: 'c3', tool: 'getSessions', input: {} }]);
      const over = 'x'.repeat(MAX_EVENT_BYTES + 1);
      expect((await refusal(append(t.id, 'r1', [{ t: 'tool-output', callId: 'c3', tool: 'getSessions', output: over }])))?.code).toBe(
        'validation_failed',
      );
    });

    it('counts a multi-byte character as the bytes it is', async () => {
      const t = await openTurn();
      await append(t.id, 'r1', [{ t: 'tool-input', callId: 'c1', tool: 'getSessions', input: {} }]);
      // 3 bytes each: under the bound in characters, over it in bytes.
      const wide = '€'.repeat(Math.ceil(MAX_EVENT_BYTES / 3));
      expect((await refusal(append(t.id, 'r1', [{ t: 'tool-output', callId: 'c1', tool: 'getSessions', output: wide }])))?.code).toBe(
        'validation_failed',
      );
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

    it('an approval request must carry the digest of the input it shows', async () => {
      const t = await openTurn();
      await append(t.id, 'r1', [{ t: 'tool-input', callId: 'c2', tool: 'logSet', input: LOG }]);
      const wrong = await approvalDigest({ ...LOG, weightKg: 200 });
      const r = await refusal(
        append(t.id, 'r1', [{ t: 'approval-request', callId: 'c2', tool: 'logSet', input: LOG, digest: wrong, preview: 'p' }]),
      );
      expect(r?.reason).toBe('digest_mismatch');
      // And only for a call that was proposed.
      const ok = await approvalDigest(LOG);
      expect(
        (await refusal(append(t.id, 'r1', [{ t: 'approval-request', callId: 'nope', tool: 'logSet', input: LOG, digest: ok, preview: 'p' }])))?.reason,
      ).toBe('call_state');
    });

    it('the approval milestone names the call and its digest, never what was asked', async () => {
      const t = await openTurn();
      const digest = await proposeGated(t.id);
      const [e] = h.eventsOfType('assistant.approval-requested');
      expect(e!.payload).toEqual({ threadId: t.id, callId: 'c2', tool: 'logSet', digest });
      expect(JSON.stringify(e!.payload)).not.toContain('squat');
      expect(JSON.stringify(e!.payload)).not.toContain('105');
    });

    it('a turn rests awaiting approval only with one waiting, and finishes done only with none', async () => {
      const t = await openTurn();
      expect((await refusal(append(t.id, 'r1', [{ t: 'turn-finish', reason: 'awaiting-approval' }])))?.reason).toBe('no_approval_pending');
      const digest = await approvalDigest(LOG);
      await append(t.id, 'r1', [
        { t: 'tool-input', callId: 'c2', tool: 'logSet', input: LOG },
        { t: 'approval-request', callId: 'c2', tool: 'logSet', input: LOG, digest, preview: 'p' },
      ]);
      expect((await refusal(append(t.id, 'r1', [{ t: 'turn-finish', reason: 'done' }])))?.reason).toBe('approval_pending');
      await append(t.id, 'r1', [{ t: 'turn-finish', reason: 'awaiting-approval' }]);
      expect(h.eventsOfType('assistant.turn-finished').map((e) => (e.payload as { reason: string }).reason)).toEqual(['awaiting-approval']);
    });

    describe('resolving an approval', () => {
      it('is the owner’s, with the digest shown, and appends the user’s side of the record', async () => {
        const t = await openTurn();
        const digest = await proposeGated(t.id);
        const r = await owner.stub.invoke<{ seq: number }>('assistant/resolve-approval', { threadId: t.id, callId: 'c2', digest, approved: true });
        const events = (await read(owner, t.id)).events;
        expect(events[events.length - 1]).toEqual({ t: 'approval-resolved', callId: 'c2', approved: true, id: r.seq });
        const [e] = h.eventsOfType('assistant.approval-resolved');
        expect(e!.payload).toEqual({ threadId: t.id, callId: 'c2', tool: 'logSet', approved: true });
      });

      it('refuses a digest for a different input, and leaves the request waiting', async () => {
        const t = await openTurn();
        await proposeGated(t.id);
        const other256 = await approvalDigest({ ...LOG, weightKg: 200 });
        const r = await refusal(owner.stub.invoke('assistant/resolve-approval', { threadId: t.id, callId: 'c2', digest: other256, approved: true }));
        expect(r?.reason).toBe('digest_mismatch');
        expect((await refusal(owner.stub.invoke('assistant/send-message', { threadId: t.id, text: 'x' })))?.reason).toBe('approval_pending');
      });

      it("is not another principal's to give, even with audit", async () => {
        const t = await openTurn();
        const digest = await proposeGated(t.id);
        for (const who of [other, auditor]) {
          expect((await refusal(who.stub.invoke('assistant/resolve-approval', { threadId: t.id, callId: 'c2', digest, approved: true })))?.code).toBe('not_found');
        }
        expect(h.eventsOfType('assistant.approval-resolved')).toHaveLength(0);
      });

      it('can be given once', async () => {
        const t = await openTurn();
        const digest = await proposeGated(t.id);
        await owner.stub.invoke('assistant/resolve-approval', { threadId: t.id, callId: 'c2', digest, approved: false });
        expect((await refusal(owner.stub.invoke('assistant/resolve-approval', { threadId: t.id, callId: 'c2', digest, approved: true })))?.reason).toBe('already_resolved');
      });

      it('answers not_found for a call that was never proposed', async () => {
        const t = await openTurn();
        const digest = await approvalDigest(LOG);
        expect((await refusal(owner.stub.invoke('assistant/resolve-approval', { threadId: t.id, callId: 'zzz', digest, approved: true })))?.code).toBe('not_found');
      });
    });

    describe('executing a gated call', () => {
      /** Approve c2 and have the host start the next run. */
      const approveAndResume = async (approved = true) => {
        const t = await openTurn();
        const digest = await proposeGated(t.id);
        await host.stub.invoke('assistant/release-run', { threadId: t.id, runId: 'r1' });
        await owner.stub.invoke('assistant/resolve-approval', { threadId: t.id, callId: 'c2', digest, approved });
        await acquire(t.id, 'r2');
        return { t, digest };
      };
      const claim = (threadId: string, input: unknown, runId = 'r2') =>
        host.stub.invoke('assistant/claim-execution', { threadId, runId, callId: 'c2', input });
      const output = (threadId: string, runId = 'r2') =>
        append(threadId, runId, [{ t: 'tool-output', callId: 'c2', tool: 'logSet', output: { ok: true } }]);

      it('produces no output before it is approved, or when it was denied, or when nobody claimed it', async () => {
        const t = await openTurn();
        await proposeGated(t.id);
        // r1 rested on the approval and still holds the lease here; the output is what is refused.
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
          (await refusal(owner.stub.invoke('assistant/claim-execution', { threadId: t.id, runId: 'r2', callId: 'c2', input: LOG })))?.code,
        ).toBe('permission_denied');
      });

      it('an ungated call has nothing to claim', async () => {
        const t = await openTurn();
        await append(t.id, 'r1', [{ t: 'tool-input', callId: 'c1', tool: 'getSessions', input: {} }]);
        expect(
          (await refusal(host.stub.invoke('assistant/claim-execution', { threadId: t.id, runId: 'r1', callId: 'c1', input: {} })))?.reason,
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
      await proposeGated(t.id);
      const keep = await other.stub.invoke<Thread>('assistant/create-thread', {});
      await other.stub.invoke('assistant/send-message', { threadId: keep.id, text: 'mine' });

      const staff = platformActorId.parse(ulid());
      const receipt = await h.host.admin.shredSubject(staff, h.tenant, h.scope, dataSubjectId.parse(owner.principal));
      expect(receipt.verticalRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ entityType: 'assistant-thread', mode: 'delete', rows: 1 }),
          expect.objectContaining({ entityType: 'assistant-event', mode: 'delete' }),
          expect.objectContaining({ entityType: 'assistant-tool-call', mode: 'delete', rows: 1 }),
          expect.objectContaining({ entityType: 'assistant-run', mode: 'delete', rows: 1 }),
        ]),
      );
      expect(receipt.unreachedEntities ?? []).toEqual([]);

      expect((await refusal(auditor.stub.invoke('assistant/get-thread', { threadId: t.id })))?.code).toBe('not_found');
      expect((await read(other, keep.id)).events.map((e) => e.t)).toEqual(['user-message', 'turn-start']);
    });
  });
});
