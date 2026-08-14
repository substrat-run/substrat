/**
 * The token-economy helpers in isolation: the moving Anthropic breakpoint and
 * stale-payload pruning for OpenAI-compatible dialects. These guard billing
 * behavior, so the assertions are about EXACT placement — a breakpoint on the
 * wrong message silently costs real money without failing anything else.
 */
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { pruneStalePayloads, withMovingBreakpoint } from '../src/ai-sdk.js';

const CACHE = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };
const marked = (m: ModelMessage): boolean =>
	Boolean((m.providerOptions as typeof CACHE | undefined)?.anthropic?.cacheControl);

describe('withMovingBreakpoint', () => {
	it('keeps system marks, strips old per-step marks, marks only the last message', () => {
		const messages: ModelMessage[] = [
			{ role: 'system', content: 'stable', providerOptions: CACHE },
			{ role: 'system', content: 'concept', providerOptions: CACHE },
			{ role: 'user', content: 'turn 1', providerOptions: CACHE }, // previous step's mark
			{ role: 'assistant', content: 'did things' },
			{ role: 'user', content: 'turn 2' },
		];
		const out = withMovingBreakpoint(messages);
		expect(out.map(marked)).toEqual([true, true, false, false, true]);
		// Never more than 3 concurrent breakpoints (Anthropic allows 4).
		expect(out.filter(marked).length).toBeLessThanOrEqual(3);
		// Input untouched — the helper must not mutate what the SDK handed it.
		expect(marked(messages[3] as ModelMessage)).toBe(false);
		expect(marked(messages[2] as ModelMessage)).toBe(true);
	});
});

function writeCall(id: string, path: string, content: string): ModelMessage {
	return {
		role: 'assistant',
		content: [{ type: 'tool-call', toolCallId: id, toolName: 'write_file', input: { path, content } }],
	};
}
function result(id: string, toolName: string, value: string): ModelMessage {
	return {
		role: 'tool',
		content: [{ type: 'tool-result', toolCallId: id, toolName, output: { type: 'text', value } }],
	};
}
const BIG = 'x'.repeat(500);

describe('pruneStalePayloads', () => {
	it('stubs superseded write bodies and read results, keeps the newest per target', () => {
		const readCall: ModelMessage = {
			role: 'assistant',
			content: [
				{ type: 'tool-call', toolCallId: 'r1', toolName: 'read_file', input: { path: 'a.ts' } },
			],
		};
		const messages: ModelMessage[] = [
			writeCall('w1', 'a.ts', BIG),
			result('w1', 'write_file', 'wrote a.ts'),
			readCall,
			result('r1', 'read_file', BIG),
			writeCall('w2', 'a.ts', BIG),
			result('w2', 'write_file', 'wrote a.ts'),
			writeCall('w3', 'b.ts', BIG),
			result('w3', 'write_file', 'wrote b.ts'),
		];
		const out = pruneStalePayloads(messages);
		const callContent = (m: ModelMessage): string =>
			((m.content as Array<{ input?: { content?: string } }>)[0]?.input?.content ?? '');
		const resultValue = (m: ModelMessage): string =>
			((m.content as Array<{ output?: { value?: string } }>)[0]?.output?.value ?? '');

		expect(callContent(out[0] as ModelMessage)).toContain('superseded'); // w1: older write of a.ts
		expect(resultValue(out[3] as ModelMessage)).toContain('superseded'); // r1: read before the last write
		expect(callContent(out[4] as ModelMessage)).toBe(BIG); // w2: newest a.ts write keeps its body
		expect(callContent(out[6] as ModelMessage)).toBe(BIG); // w3: only write of b.ts — untouched
		// Input messages must not be mutated.
		expect(callContent(messages[0] as ModelMessage)).toBe(BIG);
	});

	it('stubs the older result when the same command runs twice', () => {
		const cmd = (id: string): ModelMessage => ({
			role: 'assistant',
			content: [
				{ type: 'tool-call', toolCallId: id, toolName: 'run_command', input: { cmd: 'pnpm test' } },
			],
		});
		const messages: ModelMessage[] = [
			cmd('c1'),
			result('c1', 'run_command', `exit 1\n${BIG}`),
			cmd('c2'),
			result('c2', 'run_command', `exit 0\n${BIG}`),
		];
		const out = pruneStalePayloads(messages);
		const val = (m: ModelMessage): string =>
			((m.content as Array<{ output?: { value?: string } }>)[0]?.output?.value ?? '');
		expect(val(out[1] as ModelMessage)).toContain('superseded');
		expect(val(out[3] as ModelMessage)).toContain(BIG);
	});
});
