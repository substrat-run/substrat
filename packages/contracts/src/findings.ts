import { z } from 'zod';
import { instant, scopeId, tenantId } from './ids.js';
import { errorCode } from './errors.js';

/**
 * Findings (#1748): anomalies a tenant triages like email, in one inbox with one lifecycle.
 *
 * - `invariant`: a rule was broken — expected 0, observed N (a scheduled run that failed).
 * - `drift`: unusual against an expectation — a freshness expectation gone stale.
 * - `recurring`: one failure shape, seen again and again — the tenant's own projection of an
 *   `_substrat_issues` fingerprint (#1233), counted over that tenant's occurrences only.
 *
 * A finding is TENANT-scoped by construction: its counters, versions and evidence come from
 * that tenant's own rows, so the fleet aggregate it shares a fingerprint with is never visible
 * through it. It carries no free text from the evidence (no message, no upstream reference):
 * the evidence ref names where the rows are, and the reader reads them through its own
 * tenant-forced view.
 */
export const findingKind = z.enum(['invariant', 'drift', 'recurring']);
export type FindingKind = z.infer<typeof findingKind>;

/**
 * The lifecycle. `_substrat_issues` maps onto it 1:1 — new → `open`, regressed → `open` with
 * `regressed`, resolved → `resolved`, ignored → `suppressed` — and `acked` is the one state an
 * issue has no word for: "somebody is on it".
 */
export const findingStatus = z.enum(['open', 'acked', 'resolved', 'suppressed']);
export type FindingStatus = z.infer<typeof findingStatus>;

/**
 * What a verdict may SET. `suppressed` is never set directly: it is what a suppress RULE does,
 * because a suppression without a scope and an expiry is a finding nobody will ever see again.
 */
export const findingStatusInput = z.enum(['open', 'acked', 'resolved']);
export type FindingStatusInput = z.infer<typeof findingStatusInput>;

export const findingSeverity = z.enum(['info', 'warning', 'critical']);
export type FindingSeverity = z.infer<typeof findingSeverity>;

/** Where the occurrences behind a finding are read: the reader's own tenant-forced view of them. */
export const findingEvidence = z.discriminatedUnion('source', [
  /** `GET /ops-failures`, grouped by this fingerprint. */
  z.object({ source: z.literal('ops-failures'), fingerprint: z.string().min(1) }),
  /** `GET /sweep-runs?kind=…&unit=…`. */
  z.object({ source: z.literal('sweep-runs'), kind: z.enum(['schedule', 'freshness']), unit: z.string().min(1) }),
]);
export type FindingEvidence = z.infer<typeof findingEvidence>;

/**
 * Why the finding is believed to have started, with the reason stated. Only `deploy` today: a
 * finding that comes back under a version other than the one it was resolved under names the
 * new version. Nothing is claimed when nothing changed — no cause is better than an invented one.
 */
export const findingLikelyCause = z.object({
  kind: z.literal('deploy'),
  /** The version-registry id the finding was seen under. */
  version: z.string().min(1),
  reason: z.string().min(1),
});
export type FindingLikelyCause = z.infer<typeof findingLikelyCause>;

export const findingEntry = z.object({
  id: z.string().min(1),
  tenantId,
  kind: findingKind,
  /** The dedupe key within (tenant, kind): a fingerprint, or a sweep unit. */
  subject: z.string().min(1),
  status: findingStatus,
  /** A fresh occurrence reopened a resolved finding. Cleared by the next `resolved` verdict. */
  regressed: z.boolean(),
  severity: findingSeverity,
  title: z.string().min(1),
  operation: z.string().nullable(),
  /** The taxonomy codes seen on this finding, newest first, at most five. */
  codes: z.array(errorCode),
  vertical: z.string().nullable(),
  scopeId: scopeId.nullable(),
  /** This tenant's occurrences since the finding was first seen — never a fleet count. */
  count: z.number().int().positive(),
  firstSeen: instant,
  lastSeen: instant,
  lastVersion: z.string().nullable(),
  /** `lastVersion` when the last `resolved` landed — the X of "resolved under X, seen again under Y". */
  resolvedVersion: z.string().nullable(),
  resolvedAt: instant.nullable(),
  /**
   * How the last resolve happened: a person's `verdict`, or `stale` — an open finding that went
   * quiet for the whole retention window, resolved (and audited) by the retention pass rather
   * than deleted out from under whoever was watching it.
   */
  resolution: z.enum(['verdict', 'stale']).nullable(),
  acknowledgedAt: instant.nullable(),
  /** The suppress rule holding it, while `suppressed`. */
  ruleId: z.string().nullable(),
  evidence: findingEvidence,
  likelyCause: findingLikelyCause.nullable(),
});
export type FindingEntry = z.infer<typeof findingEntry>;

/** The longest a suppression may last. A permanent "never show me this" is not a rule; it is a blind spot. */
export const FINDING_RULE_MAX_DAYS = 90;

/**
 * A suppress rule (#1748): a scope plus an expiry. A matching occurrence is still COUNTED on its
 * finding, but the finding stays `suppressed` instead of opening. Each set field narrows; at
 * least one must be set, so a rule never silences a whole tenant.
 */
export const findingRuleInput = z
  .object({
    kind: findingKind.optional(),
    operation: z.string().min(1).optional(),
    code: errorCode.optional(),
    subject: z.string().min(1).optional(),
    expiresAt: instant,
    reason: z.string().min(1).max(500),
  })
  .refine((r) => r.kind !== undefined || r.operation !== undefined || r.code !== undefined || r.subject !== undefined, {
    message: 'a suppress rule names at least one of kind, operation, code or subject',
  });
export type FindingRuleInput = z.infer<typeof findingRuleInput>;

export const findingRuleEntry = z.object({
  id: z.string().min(1),
  tenantId,
  kind: findingKind.nullable(),
  operation: z.string().nullable(),
  code: errorCode.nullable(),
  subject: z.string().nullable(),
  expiresAt: instant,
  reason: z.string(),
  createdBy: z.string(),
  createdAt: instant,
});
export type FindingRuleEntry = z.infer<typeof findingRuleEntry>;

/** Filter for `listFindings`. `tenantId` absent is the staff fleet read; a tenant's read is forced to it. */
export interface FindingFilter {
  tenantId?: z.infer<typeof tenantId>;
  status?: FindingStatus;
  kind?: FindingKind;
  limit?: number;
}
