/**
 * The conversation record (src/record.ts) over the REAL assistant engine in the
 * studio scope — what a turn leaves behind, read back the way the studio reads
 * it. The cases are the ones the record exists for: a turn that finished, one
 * that failed, one that died mid-turn and was never closed, and an event too
 * large for a row. Only the Cloudflare adapter class is shimmed (studio-shim.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantStreamEvent } from '@substrat-run/contracts/assistant-stream';
import { startStudio, stopStudio } from './studio-shim.js';

type RecordModule = typeof import('../src/record.js');
type StudioModule = typeof import('../src/studio.js');

vi.mock('@substrat-run/adapter-cloudflare', () => import('./studio-shim.js'));

const env = { SCOPE: {} } as unknown as import('../src/studio.js').StudioEnv;

/** Each event as `t`, with a host-event's kind beside it: what happened, in order. */
const shape = (events: AssistantStreamEvent[]) =>
	events.map((e) => (e.t === 'host-event' ? `host-event:${e.kind}` : e.t));

describe('the conversation record', () => {
	let rec: RecordModule;
	let studio: StudioModule;

	beforeEach(async () => {
		// The periodic flush is the clock's; each case flushes where it means to,
		// and the turn that "died" leaves no live interval behind.
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		startStudio();
		vi.resetModules();
		rec = await import('../src/record.js');
		studio = await import('../src/studio.js');
	});

	afterEach(() => {
		stopStudio();
		vi.useRealTimers();
	});

	const turn = (threadId: string | null, turnId: string, message: string) => ({
		threadId,
		title: 'Todo',
		projectId: 'P1',
		turnId,
		message,
		actor: 'auth0|anna',
		model: 'anthropic:claude-opus-5',
	});

	it('keeps a finished turn: the message, who sent it, the prose, what the studio did, and that it finished', async () => {
		const record = (await rec.TurnRecord.open(env, turn(null, 'T1', 'Build it')))!;
		record.event({ type: 'assistant-text', text: 'Writing ' });
		record.event({ type: 'assistant-text', text: 'the model.' });
		record.event({ type: 'thinking' });
		record.event({ type: 'tool-call', tool: 'write_file', summary: 'spec/model.ts' });
		record.event({ type: 'commit', sha: '68608398abcdef', summary: '1 files' });
		await record.finish({ kind: 'done' });

		const page = await rec.readRecord(env, record.threadId, 0);
		expect(shape(page.events)).toEqual([
			'user-message',
			'turn-start',
			'host-event:turn-context',
			'text-start',
			'text-delta',
			'text-delta',
			'text-end',
			'host-event:tool-call',
			'host-event:commit',
			'turn-finish',
		]);
		expect(page.events[0]).toMatchObject({ t: 'user-message', text: 'Build it' });
		expect(page.events[2]).toMatchObject({ data: { actor: 'auth0|anna', model: 'anthropic:claude-opus-5' } });
		expect(page.events[8]).toMatchObject({ text: '· commit 68608398 1 files', data: { sha: '68608398abcdef' } });
		expect(page.events.at(-1)).toMatchObject({ t: 'turn-finish', reason: 'done' });
	});

	it('keeps a failed turn with its error, and the next turn appends to the same thread', async () => {
		const first = (await rec.TurnRecord.open(env, turn(null, 'T1', 'Continue')))!;
		first.event({ type: 'truncated', steps: 21, maxSteps: 40 });
		await first.finish({ kind: 'error', message: 'The model provider refused the request.' });
		const second = (await rec.TurnRecord.open(env, turn(first.threadId, 'T2', 'What is the state?')))!;
		await second.finish({ kind: 'stopped' });

		const { events } = await rec.readRecord(env, first.threadId, 0);
		expect(shape(events)).toEqual([
			'user-message',
			'turn-start',
			'host-event:turn-context',
			'host-event:truncated',
			'turn-error',
			'user-message',
			'turn-start',
			'host-event:turn-context',
			'turn-finish',
		]);
		expect(events[4]).toMatchObject({ code: 'turn_failed', message: 'The model provider refused the request.' });
		expect(events.at(-1)).toMatchObject({ reason: 'stopped' });
	});

	it('closes a turn that died before it finished as interrupted, when the next turn opens', async () => {
		const died = (await rec.TurnRecord.open(env, turn(null, 'T1', 'Build it')))!;
		died.event({ type: 'assistant-text', text: 'Starting.' });
		await died.flush(); // what reached the record before the studio went away; finish never runs
		const next = (await rec.TurnRecord.open(env, {
			...turn(died.threadId, 'T2', 'Ok, what is the state?'),
			unfinishedTurnId: 'T1',
		}))!;
		await next.finish({ kind: 'done' });

		const { events } = await rec.readRecord(env, died.threadId, 0);
		expect(shape(events).slice(4)).toEqual([
			'text-delta',
			'turn-error',
			'user-message',
			'turn-start',
			'host-event:turn-context',
			'turn-finish',
		]);
		expect(events[5]).toMatchObject({ t: 'turn-error', code: 'interrupted' });
	});

	it('keeps an event too large for a row as a bounded preview rather than losing the turn', async () => {
		const record = (await rec.TurnRecord.open(env, turn(null, 'T1', 'Build it')))!;
		const output = 'x'.repeat(100_000);
		record.event({ type: 'check', result: { name: 'model', status: 'failed', output } as never });
		await record.finish({ kind: 'done' });

		const { events } = await rec.readRecord(env, record.threadId, 0);
		expect(shape(events).slice(3)).toEqual(['host-event:check', 'turn-finish']);
		expect(events[3]).toMatchObject({ data: { truncated: true, preview: expect.stringMatching(/^\{"type":"check"/) } });
	});

	it('leaves the assistant side to the turn loop: the recorder that owns the thread cannot append to it', async () => {
		const record = (await rec.TurnRecord.open(env, turn(null, 'T1', 'Build it')))!;
		const owner = await studio.studioScope(env);
		await expect(
			owner.invoke('assistant/append-events', {
				threadId: record.threadId,
				runId: 'T1',
				events: [{ t: 'text-start', pid: 'forged' }],
			}),
		).rejects.toThrow(/permission denied|forbidden/i);
		await record.finish({ kind: 'done' });
	});
});
