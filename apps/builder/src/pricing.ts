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

export const MARKUP_PERCENT = 20;
const MARKUP_FACTOR = '1.2';

export interface UsageCost {
	/** Provider list price, USD decimal string. */
	listUsd: string;
	/** What the studio charges: list × 1.2 (MARKUP_PERCENT). */
	billedUsd: string;
}

/** List → billed. For pricing ledger-recorded list costs at read time. */
export function withMarkup(listUsd: string): string {
	return mulDecimal(listUsd, MARKUP_FACTOR);
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
