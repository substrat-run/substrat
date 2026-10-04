/**
 * An executor's terminal refusal (#1184): what a handler RETURNS to refuse an event for good.
 *
 * Its own module so the journal's spelling of a refusal has one home that both the adapters
 * (which write it) and the kernel's reads (which recognise it) import, with no cycle.
 */

// `Symbol.for`, so an adapter built against one copy of the kernel recognises a refusal made
// by another — two installed copies is a state this repo has shipped before.
const REFUSAL = Symbol.for('substrat.delivery-refusal');

/** What an executor returns to refuse an event terminally (#1184). Build it with `refuseDelivery`. */
export interface DeliveryRefusal {
  readonly [REFUSAL]: true;
  readonly reason: string;
}

/** Refuse this delivery for good: journaled terminal with `reason`, never retried (#1184). */
export function refuseDelivery(reason: string): DeliveryRefusal {
  return Object.freeze({ [REFUSAL]: true as const, reason });
}

/** Whether a handler's result is a refusal. The adapters' one test for it. */
export function isDeliveryRefusal(value: unknown): value is DeliveryRefusal {
  return typeof value === 'object' && value !== null && (value as Partial<DeliveryRefusal>)[REFUSAL] === true;
}

/** The journal text a refusal is recorded under — one spelling, so a reader can match it. */
export const REFUSAL_JOURNAL_PREFIX = 'refused: ';
export const refusalJournalText = (refusal: DeliveryRefusal): string => `${REFUSAL_JOURNAL_PREFIX}${refusal.reason}`;

