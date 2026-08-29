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

export const modelUsageLine = z.object({
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
  /** USD list price from the rate card as a decimal string; null = the card does not know this model. */
  listUsd: z.string().nullable(),
  /** ISO 8601, from the host's clock. */
  at: instant,
  elapsedMs: z.number().int().nonnegative(),
});
export type ModelUsageLine = z.infer<typeof modelUsageLine>;
