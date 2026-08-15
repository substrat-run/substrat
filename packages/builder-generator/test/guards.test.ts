/**
 * Mechanical guards the prompt alone failed to hold (observed: a fast
 * interview model asking 11 questions in one turn, three duplicated; two
 * scaffold turns silently cut at the 40-step ceiling and read as finished).
 *
 * - ask_user: duplicate questions and the 5th call are REFUSED in the tool,
 *   with an instruction the model can act on inside the same turn.
 * - truncated: a clean stream end whose final step still wanted tools means
 *   stopWhen cut the loop — said out loud as an event, and spelled into
 *   durable history by `historyMarker` so the next turn knows too.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { LocalWorkspace } from '@substrat-run/builder-workspace';
import { AiSdkGenerator, collect, historyMarker, workspaceTools } from '../src/index.js';
import { MAX_QUESTIONS_PER_TURN } from '../src/tools.js';

async function scratchWorkspace(): Promise<LocalWorkspace> {
	const root = await mkdtemp(join(tmpdir(), 'builder-guards-'));
	const ws = new LocalWorkspace({ root });
	await ws.exec('git init -q');
	return ws;
}

const CALL_OPTS = { toolCallId: 't', messages: [] };

async function ask(
	tools: ReturnType<typeof workspaceTools>,
	question: string,
	header?: string,
): Promise<string> {
	return (await tools.ask_user.execute!(
		{ question, options: ['a', 'b'], ...(header ? { header } : {}) },
		CALL_OPTS,
	)) as string;
}

describe('ask_user guards', () => {
	it('refuses a repeated question and a repeated header, emitting neither', async () => {
		const ws = await scratchWorkspace();
		const emit = vi.fn();
		const tools = workspaceTools({ workspace: ws, emit });

		expect(await ask(tools, 'Who uses it?', 'Audience')).toContain('Question shown');
		// Same question, cosmetic differences — still a duplicate.
		expect(await ask(tools, '  who USES it??')).toContain('REFUSED: you already asked');
		// New question under an already-used tab label — also a duplicate.
		expect(await ask(tools, 'Which people are the users?', 'Audience')).toContain(
			'REFUSED: you already asked',
		);

		expect(emit.mock.calls.filter(([e]) => e.type === 'question')).toHaveLength(1);
		await ws.dispose();
	});

	it(`refuses question ${MAX_QUESTIONS_PER_TURN + 1} of a turn`, async () => {
		const ws = await scratchWorkspace();
		const emit = vi.fn();
		const tools = workspaceTools({ workspace: ws, emit });

		for (let i = 0; i < MAX_QUESTIONS_PER_TURN; i++) {
			expect(await ask(tools, `Question number ${i}?`)).toContain('Question shown');
		}
		expect(await ask(tools, 'One question too many?')).toContain('REFUSED: question limit');
		expect(emit.mock.calls.filter(([e]) => e.type === 'question')).toHaveLength(
			MAX_QUESTIONS_PER_TURN,
		);
		await ws.dispose();
	});
});

/** A model that calls a tool on EVERY step — it never finishes on its own. */
function insatiableModel(): MockLanguageModelV3 {
	let call = 0;
	return new MockLanguageModelV3({
		doStream: async () => {
			call += 1;
			return {
				stream: simulateReadableStream({
					chunks: [
						{ type: 'stream-start' as const, warnings: [] },
						{
							type: 'tool-call' as const,
							toolCallId: `t${call}`,
							toolName: 'list_files',
							input: JSON.stringify({ path: '.' }),
						},
						{
							type: 'finish' as const,
							// LanguageModelV3 shape: unified + raw, not a bare string.
							finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
							usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
						},
					],
				}),
			};
		},
	});
}

describe('step-ceiling truncation', () => {
	it('emits `truncated` when stopWhen cuts a turn mid-tool-call', async () => {
		const ws = await scratchWorkspace();
		const gen = new AiSdkGenerator({ model: insatiableModel(), label: 'mock/stub', maxSteps: 2 });
		const events = await collect(
			gen.run({ workspace: ws, verticalDir: '.', concept: 'c', message: 'm' }),
		);

		expect(events.find((e) => e.type === 'truncated')).toEqual({
			type: 'truncated',
			steps: 2,
			maxSteps: 2,
		});
		await ws.dispose();
	});

	it('historyMarker spells questions and truncation into history; nothing else', () => {
		expect(historyMarker({ type: 'truncated', steps: 40, maxSteps: 40 })).toContain(
			'cut off at the 40-step ceiling',
		);
		expect(
			historyMarker({ type: 'question', question: 'Who uses it?', options: [], header: 'Audience' }),
		).toBe('[asked Audience: Who uses it?]');
		expect(historyMarker({ type: 'assistant-text', text: 'hi' })).toBeNull();
	});
});
