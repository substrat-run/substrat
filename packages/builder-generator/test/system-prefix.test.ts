/**
 * The system prefix per dialect: two blocks where each carries its own cache
 * marker (Anthropic, qwen), one joined block everywhere else. Workers AI's Qwen
 * refuses a request with a second system message ("System message must be at
 * the beginning"), so a split prefix there fails every request of the build.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { LocalWorkspace } from '@substrat-run/builder-workspace';
import { AiSdkGenerator, type BuildEvent } from '../src/index.js';

const done = () => ({
	stream: new ReadableStream({
		start(c) {
			c.enqueue({ type: 'stream-start' as const, warnings: [] });
			c.enqueue({
				type: 'finish' as const,
				finishReason: { unified: 'stop' as const, raw: 'stop' },
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
					outputTokens: { total: 1, text: 1, reasoning: undefined },
				},
			});
			c.close();
		},
	}),
});

describe('system prefix', () => {
	it.each([
		['anthropic/claude-opus-5', 2],
		['qwen/qwen3.8-max', 2],
		['cloudflare/@cf/qwen/qwen3.8-27b', 1],
	])('%s sends %i system message(s), stable prefix first', async (label, count) => {
		const model = new MockLanguageModelV3({ doStream: async () => done() });
		const root = await mkdtemp(join(tmpdir(), 'builder-system-'));
		const gen = new AiSdkGenerator({ model, label, system: 'STABLE-PREFIX' });
		const events: BuildEvent[] = [];
		for await (const e of gen.run({
			workspace: new LocalWorkspace({ root }),
			verticalDir: 'demos/x',
			concept: 'CONCEPT-TEXT',
			message: 'go',
		})) {
			events.push(e);
		}
		expect(events.some((e) => e.type === 'error')).toBe(false);

		const prompt = model.doStreamCalls[0]!.prompt;
		const system = prompt.filter((m) => m.role === 'system').map((m) => m.content as string);
		expect(system).toHaveLength(count);
		expect(prompt.slice(0, count).every((m) => m.role === 'system')).toBe(true);
		const text = system.join('\n');
		expect(text.indexOf('STABLE-PREFIX')).toBeGreaterThanOrEqual(0);
		expect(text.indexOf('CONCEPT-TEXT')).toBeGreaterThan(text.indexOf('STABLE-PREFIX'));
	});
});
