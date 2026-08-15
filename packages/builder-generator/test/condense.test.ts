/**
 * Context-overflow recovery (builder-harness.md H3, #663 row 5): the
 * mechanical condenser in isolation, and the full loop over a mock model —
 * an overflow mid-turn drops old tool payloads and the turn completes with
 * the same model calls it would otherwise have made.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { LocalWorkspace } from '@substrat-run/builder-workspace';
import { AiSdkGenerator, type BuildEvent } from '../src/index.js';
import { CONDENSE_STUB, condenseTranscript } from '../src/condense.js';

const BIG = 'x'.repeat(5_000);

const writeCall = (id: string, content: string): ModelMessage => ({
	role: 'assistant',
	content: [
		{ type: 'tool-call', toolCallId: id, toolName: 'write_file', input: { path: 'a.ts', content } },
	],
});
const toolResult = (id: string, value: string): ModelMessage => ({
	role: 'tool',
	content: [
		{ type: 'tool-result', toolCallId: id, toolName: 'write_file', output: { type: 'text', value } },
	],
});

describe('condenseTranscript', () => {
	const transcript: ModelMessage[] = [
		{ role: 'system', content: BIG },
		{ role: 'user', content: 'build it' },
		writeCall('w1', BIG),
		toolResult('w1', BIG),
		writeCall('w2', BIG),
		toolResult('w2', 'wrote a.ts'),
		{ role: 'assistant', content: 'done' },
		{ role: 'user', content: 'continue' },
	];

	it('stubs old tool payloads, keeps the tail and non-tool messages verbatim', () => {
		const r = condenseTranscript(transcript, { keepTail: 4 });
		expect(r).not.toBeNull();
		const msgs = r!.messages;
		// System and user untouched — even the huge system prefix.
		expect(msgs[0]!.content).toBe(BIG);
		expect(msgs[1]!.content).toBe('build it');
		// Old write body + result stubbed; pairing intact.
		const w1 = (msgs[2]!.content as Array<{ input: { content: string } }>)[0]!;
		expect(w1.input.content).toBe(CONDENSE_STUB);
		const r1 = (msgs[3]!.content as Array<{ output: { value: string } }>)[0]!;
		expect(r1.output.value).toBe(CONDENSE_STUB);
		// Tail (last 4) verbatim — w2's big body survives.
		const w2 = (msgs[4]!.content as Array<{ input: { content: string } }>)[0]!;
		expect(w2.input.content).toBe(BIG);
		expect(r!.savedChars).toBeGreaterThan(9_000);
		// Input untouched.
		expect((transcript[2]!.content as Array<{ input: { content: string } }>)[0]!.input.content).toBe(BIG);
	});

	it('returns null when there is nothing to drop', () => {
		expect(
			condenseTranscript([
				{ role: 'system', content: BIG },
				{ role: 'user', content: 'hi' },
			]),
		).toBeNull();
	});
});

describe('overflow recovery in the loop', () => {
	it('condenses and completes the turn; the retried request lacks the old payload', async () => {
		let call = 0;
		const model = new MockLanguageModelV3({
			doStream: async () => {
				call += 1;
				if (call === 1) {
					// Step 1: a big write_file tool call, so the transcript carries a payload.
					return {
						stream: new ReadableStream({
							start(c) {
								c.enqueue({ type: 'stream-start' as const, warnings: [] });
								c.enqueue({
									type: 'tool-call' as const,
									toolCallId: 'w1',
									toolName: 'write_file',
									input: JSON.stringify({ path: 'src/big.ts', content: BIG }),
								});
								c.enqueue({
									type: 'finish' as const,
									finishReason: 'tool-calls' as const,
									usage: {
										inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
										outputTokens: { total: 5, text: 5, reasoning: undefined },
									},
								});
								c.close();
							},
						}),
					};
				}
				if (call === 2) throw Object.assign(new Error('prompt is too long'), { statusCode: 400 });
				return {
					stream: new ReadableStream({
						start(c) {
							c.enqueue({ type: 'stream-start' as const, warnings: [] });
							c.enqueue({ type: 'text-start' as const, id: '0' });
							c.enqueue({ type: 'text-delta' as const, id: '0', delta: 'recovered' });
							c.enqueue({ type: 'text-end' as const, id: '0' });
							c.enqueue({
								type: 'finish' as const,
								finishReason: 'stop' as const,
								usage: {
									inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
									outputTokens: { total: 7, text: 7, reasoning: undefined },
								},
							});
							c.close();
						},
					}),
				};
			},
		});

		const root = await mkdtemp(join(tmpdir(), 'builder-condense-'));
		const gen = new AiSdkGenerator({ model, label: 'mock/test' });
		const events: BuildEvent[] = [];
		for await (const e of gen.run({
			workspace: new LocalWorkspace({ root }),
			verticalDir: 'demos/x',
			concept: 'test',
			message: 'go',
		})) {
			events.push(e);
		}

		const retries = events.filter(
			(e): e is Extract<BuildEvent, { type: 'retry' }> => e.type === 'retry',
		);
		expect(retries).toHaveLength(1);
		expect(retries[0]!.reason).toContain('condensed');
		expect(events.some((e) => e.type === 'error')).toBe(false);
		expect(
			events
				.filter((e): e is Extract<BuildEvent, { type: 'assistant-text' }> => e.type === 'assistant-text')
				.map((e) => e.text)
				.join(''),
		).toContain('recovered');

		// The retried request's prompt carries the stub, not the 5KB body.
		expect(call).toBe(3);
		const retriedPrompt = JSON.stringify(model.doStreamCalls[2]!.prompt);
		expect(retriedPrompt).toContain(CONDENSE_STUB.slice(1, 20));
		expect(retriedPrompt).not.toContain(BIG);
	});

	it('stays fatal when the overflow has nothing to condense (first request)', async () => {
		const model = new MockLanguageModelV3({
			doStream: async () => {
				throw Object.assign(new Error('prompt is too long'), { statusCode: 400 });
			},
		});
		const root = await mkdtemp(join(tmpdir(), 'builder-condense-fatal-'));
		const gen = new AiSdkGenerator({ model, label: 'mock/test' });
		const events: BuildEvent[] = [];
		for await (const e of gen.run({
			workspace: new LocalWorkspace({ root }),
			verticalDir: 'demos/x',
			concept: 'test',
			message: 'go',
		})) {
			events.push(e);
		}
		expect(events.filter((e) => e.type === 'retry')).toHaveLength(0);
		expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
	});
});
