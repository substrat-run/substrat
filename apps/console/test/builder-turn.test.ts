import { describe, expect, it } from 'vitest';
import type { AssistantStreamEvent } from '@substrat-run/contracts/assistant-stream';
import { metricsLine, timelineOf } from '../src/lib/builder-turn';

describe('a builder turn as the console shows it', () => {
  it("folds the model's deltas into paragraphs and lifts a red gate's output out of its event", () => {
    const events = [
      { id: 1, t: 'user-message', text: 'Build it' },
      { id: 2, t: 'turn-start', v: 1 },
      { id: 3, t: 'text-start', pid: 'p1' },
      { id: 4, t: 'text-delta', pid: 'p1', delta: 'Writing ' },
      { id: 5, t: 'text-delta', pid: 'p1', delta: 'the model.' },
      { id: 6, t: 'text-end', pid: 'p1' },
      { id: 7, t: 'host-event', kind: 'check', text: '✗ model-emit', data: { type: 'check', result: { name: 'model-emit', status: 'failed', output: 'model-diff: unreadable' } } },
      { id: 8, t: 'host-event', kind: 'check', text: '✓ model', data: { type: 'check', result: { name: 'model', status: 'passed', output: 'ok' } } },
      { id: 9, t: 'turn-error', code: 'turn_failed', message: 'provider down' },
    ] as AssistantStreamEvent[];

    expect(timelineOf(events)).toEqual([
      { kind: 'message', id: 1, text: 'Build it' },
      { kind: 'prose', id: 3, text: 'Writing the model.' },
      { kind: 'host', id: 7, event: 'check', text: '✗ model-emit', output: 'model-diff: unreadable' },
      { kind: 'host', id: 8, event: 'check', text: '✓ model' },
      { kind: 'end', id: 9, text: 'turn_failed · provider down', failed: true },
    ]);
  });
});

describe('metricsLine', () => {
  it('says what ran and where the time went, and nothing for a turn from before metrics', () => {
    const metrics = {
      resolvedModel: 'qwen:qwen3.8-max', toolchain: 'tc', skills: 'abc', cachedInputTokens: 50, cacheWriteTokens: 0,
      steps: 7, passes: 2, generatorMs: 90_000, gateMs: 4_000, questions: 0, filesWritten: 3, bytesWritten: 10,
      tools: { read_file: { calls: 4, errors: 1, ms: 9 } }, gates: [],
    };
    expect(metricsLine({ metrics, inputTokens: 100 })).toEqual([
      'ran qwen:qwen3.8-max', 'skills abc', '2 passes, 7 steps', '90s model, 4s gates', '50% cached',
      '4 tool calls, 1 failed', '3 files written',
    ]);
    expect(metricsLine({ metrics: null, inputTokens: 100 })).toEqual([]);
  });
});
