/**
 * The studio's pricing over the list math (which is pinned in
 * packages/model-providers/test): list × (1 + the markup schedule's model-calls rate, #3316).
 */
import { describe, expect, it } from 'vitest';
import { MARKUP_SEED, type MarkupRow } from '@substrat-run/contracts';
import { costOf, costOfSteps, modelMarkupPercent, withMarkup } from '../src/pricing.js';

describe('costOfSteps', () => {
	it('prices the list, and returns null for unpriced models — never a guessed $0', () => {
		// 1M in × $2/1M + 100k out × $6/1M = 2.6 list
		expect(costOfSteps('qwen:qwen3.8-max', [{ inputTokens: 1_000_000, outputTokens: 100_000 }])).toBe('2.6');
		expect(costOfSteps('ollama:qwen3-coder', [{ inputTokens: 1000, outputTokens: 10 }])).toBeNull();
		expect(costOf('qwen:qwen3.8-max', 1_000_000, 100_000)).toBe('2.6');
	});
});

describe('the markup', () => {
	it('is the schedule\'s model-calls row on the day — 30% from the seed — applied exactly', () => {
		const percent = modelMarkupPercent(MARKUP_SEED, '2026-11-21');
		expect(percent).toBe(30);
		expect(withMarkup('2.6', percent)).toBe('3.38');
		expect(withMarkup('0', percent)).toBe('0');
		const later: MarkupRow = { ...MARKUP_SEED[2]!, id: 'later', effectiveFrom: '2027-01-01', percent: 100 };
		expect(modelMarkupPercent([...MARKUP_SEED, later], '2027-01-01')).toBe(100);
		expect(() => modelMarkupPercent([], '2026-11-21')).toThrow(/prices no model call/);
	});
});
