import { z } from 'zod';
import { instant, scopeId, tenantId } from './ids.js';

/**
 * Model usage — the kernel-owned half of "the governance is kernel, the model is not"
 * (master plan §5.7 / D-18, built as #1054).
 *
 * Every call a host makes to a language model on the platform's behalf yields exactly one
 * of these. It is provider-neutral by construction: quantities come from the AI SDK usage
 * shape whichever provider ran, and `listUsd` is computed on OUR side from the generated
 * rate card — a provider's own cost field is a reconciliation source, never the ledger.
 *
 * `attribution` is FIXED at five keys, because the smallest per-request metadata limit
 * among the providers we route through is five. Pick once, never drift: a sixth key
 * silently drops on the wire and the reconciliation join breaks for that provider only.
 */
export const modelAttribution = z
  .object({
    tenant: tenantId,
    scope: scopeId,
    /** The vertical's package name — `@substrat-run/demo-ticket0`. */
    vertical: z.string().min(1),
    /** The vertical version that made the call — what a cost change correlates with. */
    version: z.string().min(1),
    /** The operation or job on whose behalf the model ran — `ticket0/answer`. */
    operation: z.string().min(1),
  })
  .strict();
export type ModelAttribution = z.infer<typeof modelAttribution>;

const modelUsageLineFields = z.object({
  attribution: modelAttribution,
  /** Normalized `provider:modelId`. */
  model: z.string().min(1),
  provider: z.string().min(1),
  modelId: z.string().min(1),
  /**
   * Token counts as the provider REPORTED them. `reported: false` means it reported
   * none and the counts are zero — never an estimate that quietly became a bill.
   */
  reported: z.boolean(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  /**
   * USD list price from the rate card; null = the card does not know this model.
   *
   * Shaped like `moneyAmount` (6 dp, K-14) because it IS money: the fold adds it with
   * `addDecimal`, and an empty string or a stray word would survive a bare `z.string()`
   * and land in the ledger as a price.
   */
  listUsd: z
    .string()
    .regex(/^-?\d+(\.\d{1,6})?$/, 'listUsd must be a decimal string with at most 6 decimal places')
    .nullable(),
  /** ISO 8601, from the host's clock. */
  at: instant,
  elapsedMs: z.number().int().nonnegative(),
});

/**
 * `reported: false` means the provider reported NO usage — so the counts are zero and
 * there is nothing to price.
 *
 * Enforced rather than merely documented because this payload is parsed from a VERTICAL
 * at the platform boundary: without the check, `{ reported: false, inputTokens: 9_000_000 }`
 * is a well-formed line and the ledger would take it. That is an estimate becoming a
 * bill, which is the single thing the `reported` flag exists to prevent.
 */
export const unreportedIsEmpty = (line: z.infer<typeof modelUsageLineFields>): boolean =>
  line.reported ||
  (line.inputTokens === 0 &&
    line.outputTokens === 0 &&
    line.cachedInputTokens === 0 &&
    line.cacheWriteTokens === 0 &&
    line.listUsd === null);

export const UNREPORTED_MESSAGE =
  'reported: false means the provider reported no usage — every token count must be 0 and listUsd null';

/** The line's own fields, unrefined — for schemas that extend it (a refined schema cannot). */
export { modelUsageLineFields };

export const modelUsageLine = modelUsageLineFields.refine(unreportedIsEmpty, {
  message: UNREPORTED_MESSAGE,
});
export type ModelUsageLine = z.infer<typeof modelUsageLine>;

/**
 * The platform intent a vertical raises to hand a line to the platform's ledger
 * (`ctx.requestPlatform({ kind: MODEL_USAGE_KIND, payload: line })`). The drain parses
 * the payload as `modelUsageLine`, refuses a line whose attribution names a different
 * tenant or scope than the one being drained, and records it under the intent's own id
 * — which is what makes a retried drain write nothing twice.
 */
export const MODEL_USAGE_KIND = 'model-usage';

/** A line as the platform's ledger holds it: the line plus the platform's two stamps. */
export const modelUsageEntry = modelUsageLineFields
  .extend({
    /** ULID, stamped platform-side; sortable = chronological in ledger order. */
    id: z.string().min(1),
    /** The intent it arrived as — the dedupe key. */
    requestId: z.string().min(1),
  })
  // Extends the FIELDS, not `modelUsageLine`: a refined schema cannot be extended. The
  // same invariant is re-applied so it also holds on the way back OUT of the ledger —
  // a row written before the check existed cannot be read as a priced one.
  .refine(unreportedIsEmpty, { message: UNREPORTED_MESSAGE });
export type ModelUsageEntry = z.infer<typeof modelUsageEntry>;

/**
 * Meter 3, at last computable — for model usage. D-30 said meters 3 and 4 were
 * uncomputable because the outbox has no cross-tenant fan-in; a line drained into the
 * directory is exactly that fan-in, for this one kind of usage.
 *
 * One row per (tenant, vertical, model). Token sums are integers; money is folded with
 * `addDecimal`, never floated, and `billedUsd` is `listUsd × marginFactor(marginPercent)`
 * — the platform's rate applied at READ time, so a margin change re-prices history
 * consistently rather than leaving two rates in one table. `unpriced` counts calls whose
 * model the rate card did not know: shown beside the money, never folded into it as $0.
 */
export const modelUsageSummaryRow = z.object({
  tenantId,
  vertical: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().min(1),
  modelId: z.string().min(1),
  calls: z.number().int().nonnegative(),
  unpriced: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  listUsd: z.string(),
  billedUsd: z.string(),
});
export type ModelUsageSummaryRow = z.infer<typeof modelUsageSummaryRow>;

export const modelUsageSummary = z.object({
  readAt: instant,
  since: instant,
  until: instant,
  /** The platform's margin over list, whole percent. */
  marginPercent: z.number().int().nonnegative(),
  rows: z.array(modelUsageSummaryRow),
  totals: z.object({
    calls: z.number().int().nonnegative(),
    unpriced: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    listUsd: z.string(),
    billedUsd: z.string(),
  }),
});
export type ModelUsageSummary = z.infer<typeof modelUsageSummary>;

/**
 * `20` → `'1.2'`, `7` → `'1.07'`, `125` → `'2.25'`: a whole-percent margin as the exact
 * decimal factor `mulDecimal` takes. Whole percents only — a fractional margin would need
 * a factor the 6-dp decimal scale cannot always carry, and nobody prices at 12.5%.
 */
export function marginFactor(percent: number): string {
  if (!Number.isInteger(percent) || percent < 0) {
    throw new RangeError(`margin percent must be a non-negative integer, got ${percent}`);
  }
  const whole = 1 + Math.floor(percent / 100);
  const frac = String(percent % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}
