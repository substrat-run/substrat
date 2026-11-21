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
import { marginFactor, mulDecimal } from '@substrat-run/contracts';

export { normalizeModelSpec, rateFor, type ModelRate, type RateTier, type StepTokens };

/**
 * The markup on model tokens, in whole percent of the provider's list price: 30%, set by the
 * owner on 2026-11-21 (#3316), the same rate the platform's model ledger bills vertical calls at
 * (`DEFAULT_MODEL_MARGIN_PERCENT`). Until #3316's markup schedule exists this is the one rate for
 * every team; the schedule replaces it with a default plus per-tenant overrides, which is why
 * `withMarkup` takes the percent. The factor is contracts' `marginFactor`, the ledger's own.
 */
export const MARKUP_PERCENT = 30;

export interface UsageCost {
	/** Provider list price, USD decimal string. */
	listUsd: string;
	/** What the studio charges: list plus the markup (MARKUP_PERCENT). */
	billedUsd: string;
}

/** List → billed. For pricing ledger-recorded list costs at read time. */
export function withMarkup(listUsd: string, percent: number = MARKUP_PERCENT): string {
	return mulDecimal(listUsd, marginFactor(percent));
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
