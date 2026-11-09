import { describe, expect, it, vi } from 'vitest';
import {
  AssistantModel,
  answerOf,
  historyOf,
  scriptedSource,
  turnChange,
  type AssistantEvent,
  type AssistantSend,
  type AssistantSnapshot,
  type AssistantSource,
  type AssistantTurn,
} from '../src/assistant-model.js';
import { COMPOSITION_GRACE_MS, isComposingEnter } from '../src/internal/composing.js';

const tick = () => new Promise((resolve) => setTimeout(resolve));
const done: AssistantEvent = { t: 'turn-finish', reason: 'done' };
const say = (text: string, pid = 'a'): AssistantEvent => ({ t: 'text-delta', pid, delta: text });

/** A source driven by hand, so a test can look at the model between two events. */
function piped(cancel?: () => Promise<void>) {
  const queue: Array<AssistantEvent | Error | null> = [];
  let wake: (() => void) | undefined;
  const sent: AssistantSend[] = [];
  const signals: AbortSignal[] = [];
  const source: AssistantSource = {
    async *send(turn, { signal }) {
      sent.push(turn);
      signals.push(signal);
      for (;;) {
        if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
        const next = queue.shift();
        if (next === null || next === undefined) return;
        if (next instanceof Error) throw next;
        yield next;
      }
    },
    ...(cancel ? { cancel } : {}),
  };
  const push = async (...items: Array<AssistantEvent | Error | null>) => {
    queue.push(...items);
    wake?.();
    await tick();
  };
  return { source, push, sent, signals };
}

const last = (model: AssistantModel) => model.snapshot.turns[model.snapshot.turns.length - 1]!;

async function answered(script: AssistantEvent[]): Promise<AssistantModel> {
  const model = new AssistantModel({ source: scriptedSource(script) });
  model.send('why?');
  await tick();
  return model;
}

describe('AssistantModel', () => {
  it('draws the question at once and takes one question at a time', async () => {
    const pipe = piped();
    const model = new AssistantModel({ source: pipe.source });
    expect(model.send('  why?  ')).toBe(true);
    expect(last(model)).toMatchObject({ question: 'why?', status: 'running' });
    expect(model.snapshot.running).toBe(true);
    expect(model.send('and?')).toBe(false);
    expect(model.send('   ')).toBe(false);
    expect(model.snapshot.turns).toHaveLength(1);
    await pipe.push(done);
    expect(model.snapshot.running).toBe(false);
    expect(model.send('and?')).toBe(true);
  });

  it('keeps a turn in the order it happened, text by its part and a tool by its call', async () => {
    const model = await answered([
      { t: 'user-message', text: 'why?' },
      { t: 'step-start', step: 'look' },
      { t: 'tool-input', callId: 'c1', tool: 'list_findings', input: {} },
      { t: 'tool-output', callId: 'c1', tool: 'list_findings', output: [] },
      { t: 'tool-error', callId: 'c2', tool: 'get_deploy', message: 'no' },
      { t: 'step-end', step: 'look' },
      { t: 'text-start', pid: 'a' },
      say('Two '),
      say('open.'),
      { t: 'text-end', pid: 'a' },
      { t: 'host-event', kind: 'applied', text: 'Updated the canvas' },
      say('Done.', 'b'),
      { t: 'source', sid: 's1', title: 'old title', ref: 'file/1' },
      { t: 'source', sid: 's1', title: 'lease.pdf', ref: 'file/1' },
      { t: 'data-provenance', producedAt: '2026-11-09T10:00:00.000Z', model: 'm', sources: 2 },
      { t: 'budget-notice', exhausted: true },
      done,
    ]);
    const turn = last(model);
    expect(turn.parts.map((p) => (p.kind === 'text' ? p.text : p.kind === 'tool' ? `${p.tool}:${p.status}` : p.text))).toEqual([
      'list_findings:done',
      'get_deploy:failed',
      'Two open.',
      'Updated the canvas',
      'Done.',
    ]);
    expect(answerOf(turn)).toBe('Two open.Done.');
    expect(turn.citations).toEqual([{ sid: 's1', title: 'lease.pdf', url: null, ref: 'file/1' }]);
    expect(turn).toMatchObject({ provenance: { model: 'm', sources: 2 }, budgetExhausted: true, status: 'done' });
  });

  it('drops the partial text of a restarted step and nothing else', async () => {
    const model = await answered([
      { t: 'step-start', step: 'one' },
      say('kept ', 'p1'),
      { t: 'step-end', step: 'one' },
      { t: 'step-start', step: 'two' },
      say('half', 'p2'),
      { t: 'tool-output', callId: 'c1', tool: 't', output: 1 },
      { t: 'step-restart', step: 'two' },
      say('whole', 'p2'),
      done,
    ]);
    expect(answerOf(last(model))).toBe('kept whole');
    expect(last(model).parts.filter((p) => p.kind === 'tool')).toHaveLength(1);
  });

  it('skips an event it does not know, and rests an unknown finish reason as done', async () => {
    const model = await answered([
      { t: 'from-the-future' } as unknown as AssistantEvent,
      say('hello'),
      { t: 'turn-finish', reason: 'from-the-future' } as unknown as AssistantEvent,
    ]);
    expect(last(model)).toMatchObject({ status: 'done' });
    expect(answerOf(last(model))).toBe('hello');
  });

  it.each([
    ['a stream that closes without an ending', [say('partial')], 'ended-early', null],
    ['a turn the server failed', [say('partial'), { t: 'turn-error', code: 'model', message: 'Too busy.' }], 'failed', { code: 'model', message: 'Too busy.' }],
    ['a spent budget', [{ t: 'turn-finish', reason: 'budget' }], 'budget', null],
    ['a server-side stop', [{ t: 'turn-finish', reason: 'stopped' }], 'stopped', null],
    ['a pause for an approval', [{ t: 'turn-finish', reason: 'awaiting-approval' }], 'needs-approval', null],
  ] as [string, AssistantEvent[], string, unknown][])('says how a turn ended: %s', async (_name, script, status, failure) => {
    const model = await answered(script);
    expect(last(model)).toMatchObject({ status, failure });
    expect(model.snapshot.running).toBe(false);
  });

  it.each([
    [new TypeError('Failed to fetch'), { code: 'transport', message: null }],
    [Object.assign(new Error('Not yours'), { status: 403 }), { code: 'refused', message: 'Not yours' }],
    [Object.assign(new Error('Slow down'), { status: 429 }), { code: 'rate-limited', message: 'Slow down' }],
    [Object.assign(new Error('Down'), { status: 503 }), { code: 'unavailable', message: 'Down' }],
    [Object.assign(new Error('Bad'), { status: 400 }), { code: 'failed', message: 'Bad' }],
  ])('reads a thrown %s by its status, and keeps a network error out of the words', async (error, failure) => {
    const pipe = piped();
    const model = new AssistantModel({ source: pipe.source });
    model.send('why?');
    await pipe.push(say('partial'), error);
    expect(last(model)).toMatchObject({ status: 'failed', failure });
    expect(answerOf(last(model))).toBe('partial');
  });

  it('stop ends the work on the server, keeps what was written and drops what lands after', async () => {
    const cancel = vi.fn(() => Promise.reject(new Error('already over')));
    const pipe = piped(cancel);
    const model = new AssistantModel({ source: pipe.source });
    model.send('why?');
    await pipe.push(say('partial'));
    expect(model.snapshot.canStop).toBe(true);
    model.stop();
    expect(pipe.signals[0]!.aborted).toBe(true);
    await pipe.push(say(' and late'), done);
    expect(cancel).toHaveBeenCalledOnce();
    expect(last(model)).toMatchObject({ status: 'stopped' });
    expect(answerOf(last(model))).toBe('partial');
    expect(model.snapshot).toMatchObject({ running: false, canStop: false });
  });

  it('detach stops listening and leaves the server to it, and offers no Stop on a source that cannot', async () => {
    const pipe = piped();
    const model = new AssistantModel({ source: pipe.source });
    model.send('why?');
    await tick();
    expect(model.snapshot.canStop).toBe(false);
    model.detach();
    expect(pipe.signals[0]!.aborted).toBe(true);
    expect(last(model).status).toBe('stopped');
  });

  it('retries in place, without the failed turn in what it sends', async () => {
    const pipe = piped();
    const model = new AssistantModel({ source: pipe.source });
    expect(model.retry()).toBe(false);
    model.send('first');
    await pipe.push(say('one'), done);
    expect(model.retry()).toBe(false);
    model.send('second');
    await pipe.push(say('half'), new TypeError('gone'));
    const id = last(model).id;
    expect(model.retry()).toBe(true);
    expect(last(model)).toMatchObject({ id, question: 'second', status: 'running', parts: [], failure: null });
    await tick();
    expect(pipe.sent[2]).toEqual({
      text: 'second',
      history: [
        { role: 'user', text: 'first' },
        { role: 'assistant', text: 'one' },
      ],
    });
    expect(model.snapshot.turns).toHaveLength(2);
  });

  it('leaves a turn with no answer, or one that failed part way, out of the history', () => {
    const turn = (question: string, status: AssistantTurn['status'], text: string): AssistantTurn => ({
      id: 1,
      question,
      parts: text ? [{ kind: 'text', id: 'a', step: null, text }] : [],
      citations: [],
      provenance: null,
      budgetExhausted: false,
      status,
      failure: null,
      step: null,
    });
    expect(historyOf([turn('a', 'done', '1'), turn('b', 'failed', 'half'), turn('c', 'ended-early', 'half'), turn('d', 'done', ''), turn('e', 'stopped', '2')])).toEqual([
      { role: 'user', text: 'a' },
      { role: 'assistant', text: '1' },
      { role: 'user', text: 'e' },
      { role: 'assistant', text: '2' },
    ]);
  });

  it('calls a subscriber at once and on every change, until it leaves', async () => {
    const model = new AssistantModel({ source: scriptedSource([done]) });
    const seen: AssistantSnapshot[] = [];
    const leave = model.subscribe((s) => seen.push(s));
    expect(seen).toEqual([model.snapshot]);
    model.send('why?');
    await tick();
    expect(seen.length).toBeGreaterThan(1);
    const count = seen.length;
    leave();
    model.send('and?');
    await tick();
    expect(seen).toHaveLength(count);
  });

  it('never keeps a citation link that is not http', async () => {
    const model = await answered([
      { t: 'source', sid: 'a', title: 'bad', url: 'javascript:alert(1)' },
      { t: 'source', sid: 'b', title: 'odd', url: 'not a url' },
      { t: 'source', sid: 'c', title: 'good', url: 'https://example.com/a' },
      done,
    ]);
    expect(last(model).citations.map((c) => c.url)).toEqual([null, null, 'https://example.com/a']);
  });
});

describe('turnChange', () => {
  const turn = (id: number, status: AssistantTurn['status']) => ({ id, status }) as AssistantTurn;
  const snap = (...turns: AssistantTurn[]) => ({ turns, running: false, activity: 0, canStop: false });

  it.each([
    ['a first look', null, snap(turn(1, 'running')), null],
    ['nothing yet', snap(), snap(), null],
    ['a new turn', snap(turn(1, 'done')), snap(turn(1, 'done'), turn(2, 'running')), 'started'],
    ['a retry', snap(turn(1, 'failed')), snap(turn(1, 'running')), 'started'],
    ['a delta', snap(turn(1, 'running')), snap(turn(1, 'running')), null],
    ['an answer', snap(turn(1, 'running')), snap(turn(1, 'done')), 'answered'],
    ['a failure', snap(turn(1, 'running')), snap(turn(1, 'failed')), 'failed'],
    ['a stop', snap(turn(1, 'running')), snap(turn(1, 'stopped')), 'stopped'],
    ['an old end, seen again', snap(turn(1, 'done')), snap(turn(1, 'done')), null],
  ])('%s', (_name, before, after, change) => {
    expect(turnChange(before, after)).toBe(change);
  });
});

describe('isComposingEnter', () => {
  const key = (over: Partial<Pick<KeyboardEvent, 'isComposing' | 'keyCode'>> = {}) => ({ isComposing: false, keyCode: 13, timeStamp: 1000, ...over });

  it.each([
    ['a plain Enter', key(), { composing: false, endedAt: null }, false],
    ['while composing', key({ isComposing: true }), { composing: false, endedAt: null }, true],
    ['an IME keydown', key({ keyCode: 229 }), { composing: false, endedAt: null }, true],
    ['between the composition events', key(), { composing: true, endedAt: null }, true],
    ['just after compositionend', key(), { composing: false, endedAt: 1000 - COMPOSITION_GRACE_MS + 1 }, true],
    ['once the grace has passed', key(), { composing: false, endedAt: 1000 - COMPOSITION_GRACE_MS }, false],
  ])('%s', (_name, event, state, expected) => {
    expect(isComposingEnter(event, state)).toBe(expected);
  });
});
