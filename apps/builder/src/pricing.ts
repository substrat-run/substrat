/**
 * The studio's pricing vocabulary. The metering engine owns QUANTITIES and
 * never prices (engine-metering D-E) — pricing is vertical vocabulary, and for
 * the studio's own spend the studio is the vertical. The list-price math and
 * the generated rate card live in `@substrat-run/model-providers`, and the markup
 * is the platform's markup schedule (#3316) — one mechanism, not a studio constant.
 */
import {
	listCostOfSteps,
	normalizeModelSpec,
	rateFor,
	type ModelRate,
	type RateTier,
	type StepTokens,
} from '@substrat-run/model-providers';
import { marginFactor, markupPercentFor, mulDecimal, type MarkupRow } from '@substrat-run/contracts';

export { normalizeModelSpec, rateFor, type ModelRate, type RateTier, type StepTokens };

/**
 * The markup on model tokens, in whole percent of the provider's list price, on one UTC day: the
 * platform's `model-calls` row of the markup schedule (#3316), the same row the control plane's
 * model ledger prices at. Seeded at 30% (owner, 2026-11-21); staff change it with a dated row,
 * never here. The studio's usage is still studio-wide, so it reads the platform's rate and no
 * team's own row. Throws when no row covers the day: the seed covers every day, so a schedule
 * without one is not the platform's.
 */
export function modelMarkupPercent(schedule: readonly MarkupRow[], day: string): number {
	const percent = markupPercentFor(schedule, { tenantId: null, dimension: 'model-calls', kind: 'live', day });
	if (percent === null) throw new Error(`the markup schedule prices no model call on ${day}`);
	return percent;
}

/** List → billed, at the percent in force. For pricing ledger-recorded list costs at read time. */
export function withMarkup(listUsd: string, percent: number): string {
	return mulDecimal(listUsd, marginFactor(percent));
}

/** A turn's list price from its per-request steps. Null when the model is unpriced — never guessed. */
export function costOfSteps(model: string, steps: readonly StepTokens[]): string | null {
	return listCostOfSteps(model, steps);
}

/** Legacy totals path (pre-#663 rows): one pseudo-request. */
export function costOf(model: string, inputTokens: number, outputTokens: number): string | null {
	return costOfSteps(model, [{ inputTokens, outputTokens }]);
}
