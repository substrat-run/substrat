/**
 * List-price math over the generated rate card — QUANTITIES × LIST RATES, and
 * nothing more. Margin is vocabulary: the builder studio charges list × 1.2
 * for its own spend, the platform will charge list × (1 + its margin) for
 * inference it provides (#1054), and the metering engine owns neither (D-E).
 * Each of those is a one-line wrapper over `listCostOfSteps`; the tier and
 * cache semantics below are the part that must not be re-derived twice.
 *
 * The rate card itself is GENERATED (rate-card.generated.ts) from models.dev ×
 * LiteLLM with a failing cross-check, and reviewed as a PR diff — the billing
 * checkpoint of docs/architecture/builder/harness.md §2.2. This file owns the math:
 *
 *   - Tier selection is ALL-OR-NOTHING by a request's total input tokens
 *     (DashScope/Anthropic threshold semantics): the whole request bills at
 *     the tier its input lands in. That makes pricing inherently PER-STEP — a
 *     turn is dozens of requests, and summing them before selecting a tier
 *     would land the sum in a tier no single request reached. `listCostOfSteps`
 *     is the correct path; `listCostOf` over totals is the legacy fallback for
 *     entries recorded before per-step usage existed.
 *   - Cache reads/writes bill at their own rates when the card has them; a
 *     missing cache rate bills that slice at the plain input rate — the
 *     provider's own behavior when it publishes no cache pricing. A discount
 *     is only ever applied when a catalog actually states one.
 *
 * Decimal strings end to end (K-14). Token counts convert to exact millions
 * (an integer / 1e6 is at most 6 dp), so mulDecimal's 6 dp micro-unit scale
 * never truncates — which is also why rates are multiplied per-MILLION, never
 * pre-divided to a per-token rate ($0.19/1M per-token would be 1.9e-7, below
 * the 6 dp floor).
 */
import { addDecimal, mulDecimal } from '@substrat-run/contracts';
import { RATE_CARD } from './rate-card.generated.js';
import { parseModelSpec } from './spec.js';

export interface RateTier {
	/**
	 * Inclusive upper bound on the request's total input tokens for this tier;
	 * null = top (or only) tier. Tiers are ordered ascending.
	 */
	readonly upToInputTokens: number | null;
	/** Provider list price in USD per 1M tokens, decimal strings. */
	readonly inputPer1M: string;
	readonly outputPer1M: string;
	/** null = provider publishes no cache pricing; that slice bills at input rate. */
	readonly cacheReadPer1M: string | null;
	readonly cacheWritePer1M: string | null;
}

export interface ModelRate {
	readonly provider: string;
	/** Longest-prefix match on the model id, so dated snapshots (`qwen3.8-max-2026-01-01`) price as their base model. */
	readonly idPrefix: string;
	readonly label: string;
	/** Smallest context both catalogs agree on; null when neither reports one. */
	readonly contextTokens: number | null;
	readonly tiers: readonly RateTier[];
	/** Where the numbers came from, for the audit trip back to the price page. */
	readonly sources: readonly string[];
}

/**
 * One provider request's token counts. `inputTokens` is the TOTAL input the
 * provider reported, INCLUDING the cached slices — the AI SDK's usage shape —
 * so the non-cached remainder is computed here, in one place.
 */
export interface StepTokens {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedInputTokens?: number;
	readonly cacheWriteTokens?: number;
}

/** The card entry for a `provider:model`, by longest id prefix; null = unpriced. */
export function rateFor(model: string): ModelRate | null {
	if (model.indexOf(':') === -1) return null;
	const { provider, modelId } = parseModelSpec(model);
	let best: ModelRate | null = null;
	for (const rate of RATE_CARD) {
		if (rate.provider !== provider || !modelId.startsWith(rate.idPrefix)) continue;
		if (!best || rate.idPrefix.length > best.idPrefix.length) best = rate;
	}
	return best;
}

/** An integer token count as an exact millions decimal (12_345 → '0.012345'). */
function tokensInMillions(tokens: number): string {
	const s = String(Math.max(0, Math.round(tokens))).padStart(7, '0');
	const frac = s.slice(-6).replace(/0+$/, '');
	return `${s.slice(0, -6)}${frac ? `.${frac}` : ''}`;
}

/** All-or-nothing: first tier whose bound holds the request's total input. */
function tierFor(rate: ModelRate, inputTokens: number): RateTier {
	for (const tier of rate.tiers) {
		if (tier.upToInputTokens === null || inputTokens <= tier.upToInputTokens) return tier;
	}
	// Unreachable for a well-formed card (last tier is unbounded); the generator
	// guarantees it, but a fallback beats a throw in the billing path.
	return rate.tiers[rate.tiers.length - 1] as RateTier;
}

/**
 * Price a turn from its per-request steps — the correct path (see header).
 * USD list price as a decimal string; null when the model has no rate card
 * entry — unpriced, never guessed.
 */
export function listCostOfSteps(model: string, steps: readonly StepTokens[]): string | null {
	const rate = rateFor(model);
	if (!rate) return null;
	let listUsd = '0';
	for (const step of steps) {
		const tier = tierFor(rate, step.inputTokens);
		const cacheRead = Math.min(step.cachedInputTokens ?? 0, step.inputTokens);
		const cacheWrite = Math.min(step.cacheWriteTokens ?? 0, step.inputTokens - cacheRead);
		const plainInput = step.inputTokens - cacheRead - cacheWrite;
		listUsd = addDecimal(listUsd, mulDecimal(tokensInMillions(plainInput), tier.inputPer1M));
		listUsd = addDecimal(listUsd, mulDecimal(tokensInMillions(step.outputTokens), tier.outputPer1M));
		if (cacheRead > 0) {
			listUsd = addDecimal(listUsd, mulDecimal(tokensInMillions(cacheRead), tier.cacheReadPer1M ?? tier.inputPer1M));
		}
		if (cacheWrite > 0) {
			listUsd = addDecimal(
				listUsd,
				mulDecimal(tokensInMillions(cacheWrite), tier.cacheWritePer1M ?? tier.inputPer1M),
			);
		}
	}
	return listUsd;
}

/**
 * Legacy totals path: ledger entries recorded before per-step usage carry only
 * turn totals, with no step split and no cache breakdown. Priced as ONE
 * pseudo-request — for a single-tier card this equals the per-step price
 * exactly; for a tiered card it can only over-select the tier, so a read side
 * uses recorded costs whenever they exist and falls back here only for old rows.
 */
export function listCostOf(model: string, inputTokens: number, outputTokens: number): string | null {
	return listCostOfSteps(model, [{ inputTokens, outputTokens }]);
}
