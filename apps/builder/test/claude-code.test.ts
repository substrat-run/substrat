/**
 * `--max-tokens` binds a Claude Code pass as it binds an API pass: the pass is
 * stopped once its uncached-equivalent spend reaches the budget, and says so with
 * a token-reason `truncated` event.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LocalWorkspace } from '@substrat-run/builder-workspace';
import type { BuildEvent } from '@substrat-run/builder-generator';

const assistant = (id: string, input: number, cacheRead: number, output: number) => ({
	type: 'assistant',
	parent_tool_use_id: null,
	message: {
		id,
		content: [],
		usage: { input_tokens: input, cache_read_input_tokens: cacheRead, output_tokens: output },
	},
});

const script = vi.hoisted(() => ({ messages: null as unknown[] | null }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
	createSdkMcpServer: () => ({}),
	tool: () => ({}),
	// Three requests of 1,000 uncached-equivalent tokens each (cache reads excluded);
	// a pass that honoured a 1,500 budget never reaches the third.
	query: async function* ({ options }: { options: { abortController: AbortController } }) {
		if (script.messages) return yield* script.messages;
		for (const id of ['a', 'b', 'c']) {
			if (options.abortController.signal.aborted) return;
			yield assistant(id, 900, 5_000, 100);
		}
	},
}));

describe('ClaudeCodeGenerator usage', () => {
	it('takes the highest streamed count per request, and the result\'s total for the pass', async () => {
		// One request streamed as two blocks, the first with a partial count, and a
		// second whose output the stream never carried: only `result` holds the total.
		script.messages = [
			assistant('a', 900, 0, 2),
			assistant('a', 900, 0, 40),
			assistant('b', 900, 0, 3),
			{ type: 'result', subtype: 'success', is_error: false, result: '', usage: { output_tokens: 100 } },
		];
		const { ClaudeCodeGenerator } = await import('../src/claude-code.js');
		const root = await mkdtemp(join(tmpdir(), 'claude-code-usage-'));
		const events: BuildEvent[] = [];
		for await (const e of new ClaudeCodeGenerator({ model: 'sonnet', cwd: root }).run({
			workspace: new LocalWorkspace({ root }),
			verticalDir: 'demos/x',
			concept: 'a test vertical',
			message: 'go',
		})) {
			events.push(e);
		}
		script.messages = null;
		expect(events.find((e) => e.type === 'usage')).toMatchObject({
			steps: 2,
			outputTokens: 100,
			stepUsage: [expect.objectContaining({ outputTokens: 40 }), expect.objectContaining({ outputTokens: 60 })],
		});
	});
});

describe('ClaudeCodeGenerator --max-tokens', () => {
	it('stops the pass at the budget with a token truncation, counting cache reads at nothing', async () => {
		const { ClaudeCodeGenerator } = await import('../src/claude-code.js');
		const root = await mkdtemp(join(tmpdir(), 'claude-code-budget-'));
		const gen = new ClaudeCodeGenerator({ model: 'sonnet', cwd: root, maxTokens: 1_500 });
		const events: BuildEvent[] = [];
		for await (const e of gen.run({
			workspace: new LocalWorkspace({ root }),
			verticalDir: 'demos/x',
			concept: 'a test vertical',
			message: 'go',
		})) {
			events.push(e);
		}
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'truncated', reason: 'tokens', spent: 2_000, budget: 1_500 }),
		);
		expect(events.find((e) => e.type === 'usage')).toMatchObject({ steps: 2 });
		expect(events.some((e) => e.type === 'error')).toBe(false);
	});

	it('stops once, on the repeat that crosses the budget', async () => {
		const { ClaudeCodeGenerator } = await import('../src/claude-code.js');
		const root = await mkdtemp(join(tmpdir(), 'claude-code-budget-'));
		const gen = new ClaudeCodeGenerator({ model: 'sonnet', cwd: root, maxTokens: 1_500 });
		script.messages = [assistant('a', 900, 0, 100), assistant('a', 900, 0, 600), assistant('a', 900, 0, 700)];
		const events: BuildEvent[] = [];
		for await (const e of gen.run({
			workspace: new LocalWorkspace({ root }),
			verticalDir: 'demos/x',
			concept: 'a test vertical',
			message: 'go',
		})) {
			events.push(e);
		}
		script.messages = null;
		expect(events.filter((e) => e.type === 'truncated')).toEqual([
			expect.objectContaining({ reason: 'tokens', spent: 1_500, budget: 1_500 }),
		]);
	});
});
