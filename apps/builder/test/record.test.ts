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
		tenantId: 'TEAM1',
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
		first.event({ type: 'error', message: 'The model provider refused the request.', fatal: true });
		await first.finish({ kind: 'error' });
		const second = (await rec.TurnRecord.open(env, turn(first.threadId, 'T2', 'What is the state?')))!;
		await second.finish({ kind: 'stopped' });

		const { events } = await rec.readRecord(env, first.threadId, 0);
		expect(shape(events)).toEqual([
			'user-message',
			'turn-start',
			'host-event:turn-context',
			'host-event:truncated',
			'host-event:error',
			'turn-error',
			'user-message',
			'turn-start',
			'host-event:turn-context',
			'turn-finish',
		]);
		expect(events[5]).toMatchObject({ code: 'turn_failed', message: 'The model provider refused the request.' });
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
		record.event({ type: 'command', cmd: 'x'.repeat(100_000), exitCode: 0 });
		await record.finish({ kind: 'done' });

		const { events } = await rec.readRecord(env, record.threadId, 0);
		expect(shape(events).slice(3)).toEqual(['host-event:command', 'turn-finish']);
		expect(events[3]).toMatchObject({ data: { truncated: true, preview: expect.stringMatching(/^\{"type":"command"/) } });
	});

	it.each([
		['over the character cap', 'x'.repeat(16_000)],
		['under it, over the row in multi-byte text', '界'.repeat(8_000)],
		['under it, over the row in JSON escapes', '\u001b'.repeat(5_000)],
	])('keeps both ends of a gate output %s, and the outputs only once', async (_name, middle) => {
		const record = (await rec.TurnRecord.open(env, turn(null, 'T1', 'Build it')))!;
		const output = `first line\n${middle}\nthe verdict`;
		const result = { name: 'typecheck', status: 'failed', exitCode: 1, durationMs: 9, output } as const;
		record.event({ type: 'check', result });
		record.event({ type: 'gates', run: { ok: false, durationMs: 9, results: [result] } });
		await record.finish({ kind: 'done' });

		const { events } = await rec.readRecord(env, record.threadId, 0);
		expect(events[3]).toMatchObject({
			data: { result: { output: expect.stringMatching(/^first line[\s\S]*characters cut[\s\S]*the verdict$/) } },
		});
		expect(events[4]).toMatchObject({ data: { run: { results: [{ name: 'typecheck', status: 'failed' }] } } });
		expect(JSON.stringify((events[4] as { data?: unknown }).data)).not.toContain('first line');
	});

	it.each([
		['over the character bound', 'a'.repeat(40_000)],
		['over the byte bound only', 'ä'.repeat(20_000)],
	])('records a message %s, cut to fit with a note saying so', async (_name, message) => {
		const record = (await rec.TurnRecord.open(env, turn(null, 'T1', message)))!;
		await record.finish({ kind: 'done' });

		const [sent] = (await rec.readRecord(env, record.threadId, 0)).events;
		expect(sent).toMatchObject({ t: 'user-message', text: expect.stringMatching(/…\[cut: the message was (?:40000|20000) characters\]$/) });
		expect(rec.fitMessage(message)).toBe((sent as { text: string }).text);
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
