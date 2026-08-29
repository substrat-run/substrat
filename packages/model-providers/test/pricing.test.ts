/**
 * List-price math over the REAL generated rate card (rate-card.generated.ts) —
 * these double as a regression pin on the card itself: a regenerated card
 * that moves a served model's price fails here first, which is the point
 * (builder-harness.md §2.2 — a price change must be a reviewed diff, and a
 * reviewed diff includes the expected values below).
 */
import { describe, expect, it } from 'vitest';
import { listCostOf, listCostOfSteps, normalizeModelSpec, rateFor } from '../src/index.js';

describe('rateFor', () => {
	it('longest-prefix matches dated snapshots to their base model', () => {
		expect(rateFor('qwen:qwen3.8-max-2026-01-01')?.label).toBe('Qwen 3.8 Max');
	});

	it('returns null for unknown models and bare specs', () => {
		expect(rateFor('qwen:qwen99-ultra')).toBeNull();
		expect(rateFor('no-colon')).toBeNull();
	});
});

describe('normalizeModelSpec', () => {
	it('defaults the provider to anthropic', () => {
		expect(normalizeModelSpec('claude-opus-5')).toBe('anthropic:claude-opus-5');
		expect(normalizeModelSpec('qwen:qwen3.8-max')).toBe('qwen:qwen3.8-max');
	});
});

describe('listCostOfSteps — real card', () => {
	it('prices qwen3.8-max input+output at list', () => {
		// 1M in × $2/1M + 100k out × $6/1M = 2 + 0.6
		expect(listCostOfSteps('qwen:qwen3.8-max', [{ inputTokens: 1_000_000, outputTokens: 100_000 }])).toBe('2.6');
	});

	it('bills qwen3.8-max cache reads at the cache-read rate, not input rate', () => {
		// 1M input of which 800k cached: 200k × $2/1M + 800k × $0.25/1M = 0.4 + 0.2
		expect(
			listCostOfSteps('qwen:qwen3.8-max', [{ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 800_000 }]),
		).toBe('0.6');
	});

	it('bills claude-opus-5 cache writes at 1.25× input', () => {
		// 50k plain × $5/1M + 50k write × $6.25/1M + 10k out × $25/1M = 0.25 + 0.3125 + 0.25
		expect(
			listCostOfSteps('anthropic:claude-opus-5', [
				{ inputTokens: 100_000, outputTokens: 10_000, cacheWriteTokens: 50_000 },
			]),
		).toBe('0.8125');
	});

	it('bills cache slices at the input rate when the card has no cache rate', () => {
		// qwen3.6-flash publishes no cache_read rate: a cached slice must cost
		// exactly what a plain slice costs — a discount is never invented.
		const plain = listCostOfSteps('qwen:qwen3.6-flash', [{ inputTokens: 1_000_000, outputTokens: 0 }]);
		const cached = listCostOfSteps('qwen:qwen3.6-flash', [
			{ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 500_000 },
		]);
		expect(cached).toBe(plain);
	});

	it('sums steps exactly like separate calls', () => {
		const steps = [
			{ inputTokens: 123_456, outputTokens: 7_890 },
			{ inputTokens: 500_000, outputTokens: 0, cachedInputTokens: 400_000 },
		];
		const together = listCostOfSteps('anthropic:claude-sonnet-5', steps);
		const apart = steps.map((s) => listCostOfSteps('anthropic:claude-sonnet-5', [s])!);
		const sum = apart.reduce((acc, c) => acc + Number(c), 0);
		expect(Number(together)).toBeCloseTo(sum, 6);
	});

	it('returns null for unpriced models — never a guessed $0', () => {
		expect(listCostOfSteps('ollama:qwen3-coder', [{ inputTokens: 1000, outputTokens: 10 }])).toBeNull();
	});
});

describe('listCostOf — legacy totals fallback', () => {
	it('equals the single-pseudo-step price', () => {
		expect(listCostOf('qwen:qwen3.8-max', 1_000_000, 100_000)).toBe(
			listCostOfSteps('qwen:qwen3.8-max', [{ inputTokens: 1_000_000, outputTokens: 100_000 }]),
		);
	});
});
