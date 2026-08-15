/**
 * Per-step usage collection (#663): the `stepUsage` array on the turn's usage
 * event is what lets the host price each request at its own tier and cache
 * rates at record time (apps/builder metering.ts — tier selection is
 * all-or-nothing PER REQUEST, so summed turn totals cannot be priced later).
 * These tests pin the mapping from the provider's usage shape — nested V3
 * `inputTokens.{total,cacheRead,cacheWrite}` — into StepUsage entries, and
 * that a tool-loop turn yields one entry per request.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { LocalWorkspace } from '@substrat-run/builder-workspace';
import { AiSdkGenerator, type BuildEvent } from '../src/index.js';

async function input() {
	const root = await mkdtemp(join(tmpdir(), 'builder-usage-'));
	return {
		workspace: new LocalWorkspace({ root }),
		verticalDir: 'demos/x',
		concept: 'a test vertical',
		message: 'do the thing',
	};
}

interface V3Usage {
	inputTokens: {
		total: number;
		noCache: number;
		cacheRead: number | undefined;
		cacheWrite: number | undefined;
	};
	outputTokens: { total: number; text: number; reasoning: undefined };
}

const usage = (
	total: number,
	output: number,
	cacheRead?: number,
	cacheWrite?: number,
): V3Usage => ({
	inputTokens: {
		total,
		noCache: total - (cacheRead ?? 0) - (cacheWrite ?? 0),
		cacheRead,
		cacheWrite,
	},
	outputTokens: { total: output, text: output, reasoning: undefined },
});

const textStream = (text: string, u: V3Usage) => ({
	stream: new ReadableStream({
		start(c) {
			c.enqueue({ type: 'stream-start' as const, warnings: [] });
			c.enqueue({ type: 'text-start' as const, id: '0' });
			c.enqueue({ type: 'text-delta' as const, id: '0', delta: text });
			c.enqueue({ type: 'text-end' as const, id: '0' });
			c.enqueue({ type: 'finish' as const, finishReason: 'stop' as const, usage: u });
			c.close();
		},
	}),
});

const toolCallStream = (u: V3Usage) => ({
	stream: new ReadableStream({
		start(c) {
			c.enqueue({ type: 'stream-start' as const, warnings: [] });
			c.enqueue({
				type: 'tool-call' as const,
				toolCallId: 't1',
				toolName: 'list_files',
				input: '{"path":"."}',
			});
			c.enqueue({ type: 'finish' as const, finishReason: 'tool-calls' as const, usage: u });
			c.close();
		},
	}),
});

async function collect(model: MockLanguageModelV3): Promise<BuildEvent[]> {
	const events: BuildEvent[] = [];
	for await (const e of new AiSdkGenerator({ model, label: 'mock/test' }).run(await input())) {
		events.push(e);
	}
	return events;
}

const usageEvent = (events: BuildEvent[]) => events.find((e) => e.type === 'usage');

describe('per-step usage collection', () => {
	it('maps cache slices into the usage event and its stepUsage entry', async () => {
		const model = new MockLanguageModelV3({
			doStream: async () => textStream('ok', usage(1_000, 50, 700, 100)),
		});
		const events = await collect(model);
		expect(usageEvent(events)).toMatchObject({
			inputTokens: 1_000,
			outputTokens: 50,
			cachedInputTokens: 700,
			cacheWriteTokens: 100,
			steps: 1,
			stepUsage: [
				{ inputTokens: 1_000, outputTokens: 50, cachedInputTokens: 700, cacheWriteTokens: 100 },
			],
		});
	});

	it('collects one stepUsage entry per request across a tool loop', async () => {
		let call = 0;
		const model = new MockLanguageModelV3({
			doStream: async () => {
				call += 1;
				return call === 1
					? toolCallStream(usage(100, 10))
					: textStream('done', usage(300, 20, 250));
			},
		});
		const events = await collect(model);
		// Two requests → two entries, each carrying its OWN counts; the event's
		// totals are their sum. A cache slice reported on one step never smears
		// onto the other — that per-step fidelity is what record-time tier and
		// cache pricing depends on.
		expect(usageEvent(events)).toMatchObject({
			inputTokens: 400,
			outputTokens: 30,
			cachedInputTokens: 250,
			steps: 2,
			stepUsage: [
				{ inputTokens: 100, outputTokens: 10 },
				{ inputTokens: 300, outputTokens: 20, cachedInputTokens: 250 },
			],
		});
		expect(usageEvent(events)?.stepUsage?.[0]?.cachedInputTokens).toBeUndefined();
	});
});
