/**
 * The studio's pricing vocabulary. The metering engine owns QUANTITIES and
 * never prices (engine-metering D-E) — pricing is vertical vocabulary, and for
 * the studio's own spend the studio is the vertical. The list-price math and
 * the generated rate card live in `@substrat-run/model-providers`; what is the
 * studio's alone is the markup.
 */
import {
	listCostOfSteps,
	normalizeModelSpec,
	rateFor,
	type ModelRate,
	type RateTier,
	type StepTokens,
} from '@substrat-run/model-providers';
import { mulDecimal } from '@substrat-run/contracts';

export { normalizeModelSpec, rateFor, type ModelRate, type RateTier, type StepTokens };

/**
 * The markup on model tokens, in whole percent of the provider's list price: 30%, set by the
 * owner on 2026-11-21 (#3316). Until #3316's markup schedule exists this is the one rate for
 * every team; the schedule replaces it with a default plus per-tenant overrides, which is why
 * `withMarkup` takes the percent rather than reading this constant.
 */
export const MARKUP_PERCENT = 30;

/**
 * `30` → `"1.30"`: the list-to-billed factor for a whole percent, as exact decimal text. Derived,
 * never written beside the percent, so the two cannot disagree (they were `20` and `'1.2'`).
 */
export function markupFactor(percent: number): string {
	if (!Number.isInteger(percent) || percent < 0) {
		throw new Error(`a markup is a whole, non-negative percent, got ${percent}`);
	}
	const total = 100 + percent;
	return `${Math.trunc(total / 100)}.${String(total % 100).padStart(2, '0')}`;
}

export interface UsageCost {
	/** Provider list price, USD decimal string. */
	listUsd: string;
	/** What the studio charges: list plus the markup (MARKUP_PERCENT). */
	billedUsd: string;
}

/** List → billed. For pricing ledger-recorded list costs at read time. */
export function withMarkup(listUsd: string, percent: number = MARKUP_PERCENT): string {
	return mulDecimal(listUsd, markupFactor(percent));
}

/** Price a turn from its per-request steps. Null when the model is unpriced — never guessed. */
export function costOfSteps(model: string, steps: readonly StepTokens[]): UsageCost | null {
	const listUsd = listCostOfSteps(model, steps);
	return listUsd === null ? null : { listUsd, billedUsd: withMarkup(listUsd) };
}

/** Legacy totals path (pre-#663 rows): one pseudo-request. */
export function costOf(model: string, inputTokens: number, outputTokens: number): UsageCost | null {
	return costOfSteps(model, [{ inputTokens, outputTokens }]);
}
