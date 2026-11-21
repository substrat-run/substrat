/**
 * The studio's markup over the list math (which is pinned in
 * packages/model-providers/test). What is the studio's alone: list × 1.2.
 */
import { describe, expect, it } from 'vitest';
import { costOf, costOfSteps, markupFactor, withMarkup } from '../src/pricing.js';

describe('costOfSteps', () => {
	it('carries list and billed together', () => {
		// 1M in × $2/1M + 100k out × $6/1M = 2.6 list
		const c = costOfSteps('qwen:qwen3.8-max', [{ inputTokens: 1_000_000, outputTokens: 100_000 }]);
		expect(c).toEqual({ listUsd: '2.6', billedUsd: '3.38' });
	});

	it('returns null for unpriced models — never a guessed $0', () => {
		expect(costOfSteps('ollama:qwen3-coder', [{ inputTokens: 1000, outputTokens: 10 }])).toBeNull();
	});

	it('costOf equals the single-pseudo-step price', () => {
		expect(costOf('qwen:qwen3.8-max', 1_000_000, 100_000)).toEqual(
			costOfSteps('qwen:qwen3.8-max', [{ inputTokens: 1_000_000, outputTokens: 100_000 }]),
		);
	});
});

describe('withMarkup', () => {
	it('applies exactly the 30% markup, or the percent it is given', () => {
		expect(withMarkup('2.6')).toBe('3.38');
		expect(withMarkup('0')).toBe('0');
		expect(withMarkup('2.6', 100)).toBe('5.2');
		expect(withMarkup('2.6', 0)).toBe('2.6');
	});

	it('takes whole, non-negative percents only', () => {
		expect(markupFactor(30)).toBe('1.30');
		expect(markupFactor(150)).toBe('2.50');
		expect(() => markupFactor(12.5)).toThrow(/whole/);
		expect(() => markupFactor(-10)).toThrow(/non-negative/);
	});
});
