import { addDecimal, compareDecimal, marginFactor, mulDecimal, platformActorId, type EntitlementGrant, type ModelUsageEntry, type ScopeId, type TenantId } from '@substrat-run/contracts';

/**
 * The per-tenant review spend limit (hosted-review-runner.md Q1c, shape decided on #2365 on
 * 2026-11-16).
 *
 * - **What is counted:** the would-be cost of the tenant's review lines, list price ×
 *   (1 + `MODEL_MARGIN_PERCENT`): the number the ledger summary bills at. Reviews are zero-rated
 *   in phases 1–2, so nothing is charged, but the limit already means what it will mean at phase 3.
 * - **The window:** one UTC day, summed from the ledger (`_substrat_model_usage`). Every review
 *   line is filed under the platform's sentinel scope, which no vertical's drain can file into, so
 *   the tenant's lines in that scope are exactly its reviews.
 * - **Who sets it:** staff, per tenant, as the `quota` of the tenant's `review` entitlement, in
 *   whole US cents (audited by the entitlement store, set from the console); otherwise the
 *   plane's default, `REVIEW_DAILY_SPEND_LIMIT_USD`. The tenant's own setting arrives with the
 *   enable surface (Q2).
 * - **Unset fails closed:** with neither, no customer review calls the model.
 *
 * A staff review of this repository is not a customer review and has no limit here: it is
 * bounded by the per-person intake caps.
 */

/** Reads the ledger and the entitlement store for the limit: audited reads under this actor. */
export const REVIEW_SPEND_READER = platformActorId.parse('01JZ00000000000000000000RS');

/**
 * The most lines one day's read takes. A tenant's reviews are capped far below it at intake
 * (`MAX_KEPT_REVIEWS_PER_TENANT` in 30 days), so a full page means the read cannot be trusted
 * and the limit reads as reached.
 */
export const REVIEW_SPEND_READ_MAX = 500;

/** A decimal amount of US dollars, at most 6 places: the shape the ledger's `listUsd` has. */
const USD = /^\d+(\.\d{1,6})?$/;

/** A whole-cents quota as dollars: `250` → `'2.5'`. Integer arithmetic, never a float. */
export function centsToUsd(cents: number): string {
  return addDecimal(String(Math.trunc(cents / 100)), `0.${String(cents % 100).padStart(2, '0')}`);
}

/** `'2.5'` → `'$2.50'`; an amount over two places keeps them (`'$0.000412'`). */
export function usdLabel(amount: string): string {
  const [whole, frac = ''] = amount.split('.');
  return `$${whole}.${frac.padEnd(2, '0')}`;
}

/** The plane's default limit, or null when it is unset or not a positive dollar amount. */
export function defaultLimitUsd(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || !USD.test(value) || compareDecimal(value, '0') <= 0) return null;
  return value;
}

/** The UTC day `at` falls in, as the half-open window the ledger read takes. */
export function utcDay(at: Date): { day: string; since: string; until: string } {
  const day = at.toISOString().slice(0, 10);
  const since = `${day}T00:00:00.000Z`;
  return { day, since, until: new Date(Date.parse(since) + 86_400_000).toISOString() };
}

/** Seconds from `at` to the next UTC midnight, when the window resets: at least 1. */
export function secondsToReset(at: Date): number {
  return Math.max(1, Math.ceil((Date.parse(utcDay(at).until) - at.getTime()) / 1000));
}

export interface ReviewSpendDeps {
  readonly scope: ScopeId;
  readonly listUsage: (filter: { tenantId: TenantId; scopeId: ScopeId; since: string; until: string; limit: number; order: 'asc' }) => Promise<ModelUsageEntry[]>;
  readonly listEntitlements: (tenantId: TenantId) => Promise<EntitlementGrant[]>;
  /** The plane's default, already parsed by `defaultLimitUsd`. */
  readonly defaultLimitUsd: string | null;
  readonly marginPercent: number;
  /** The entitlement key whose quota is the staff override. */
  readonly entitlementKey: string;
}

export type ReviewSpend =
  | { readonly kind: 'unset' }
  | { readonly kind: 'within'; readonly limitUsd: string; readonly spentUsd: string; readonly day: string }
  | { readonly kind: 'reached'; readonly limitUsd: string; readonly spentUsd: string; readonly day: string; readonly readCapped: boolean };

/** The limit in force for a tenant: the staff override when its grant is live and carries one, else the default. */
export async function limitFor(deps: ReviewSpendDeps, tenantId: TenantId, at: Date): Promise<string | null> {
  const now = at.toISOString();
  const grant = (await deps.listEntitlements(tenantId)).find(
    (g) => g.entitlementKey === deps.entitlementKey && (g.expiresAt === null || g.expiresAt > now),
  );
  return grant?.quota != null ? centsToUsd(grant.quota) : deps.defaultLimitUsd;
}

/** The tenant's limit and what its reviews would cost today, priced as the ledger bills. */
export async function reviewSpend(deps: ReviewSpendDeps, tenantId: TenantId, at: Date): Promise<ReviewSpend> {
  const limitUsd = await limitFor(deps, tenantId, at);
  if (limitUsd === null) return { kind: 'unset' };
  const { day, since, until } = utcDay(at);
  const lines = await deps.listUsage({ tenantId, scopeId: deps.scope, since, until, limit: REVIEW_SPEND_READ_MAX, order: 'asc' });
  // An unpriced line adds nothing: the job refuses an unpriced model before any call, so one can
  // only predate that rule.
  const listUsd = lines.reduce((sum, line) => (line.listUsd === null ? sum : addDecimal(sum, line.listUsd)), '0');
  const spentUsd = mulDecimal(listUsd, marginFactor(deps.marginPercent));
  const readCapped = lines.length >= REVIEW_SPEND_READ_MAX;
  return readCapped || compareDecimal(spentUsd, limitUsd) >= 0
    ? { kind: 'reached', limitUsd, spentUsd, day, readCapped }
    : { kind: 'within', limitUsd, spentUsd, day };
}

/** The sentence a refusal carries: the limit, the window and the amount spent. */
export function spendReachedDetail(spend: Extract<ReviewSpend, { kind: 'reached' }>): string {
  return `spend limit reached: ${usdLabel(spend.spentUsd)} of ${usdLabel(spend.limitUsd)} for ${spend.day} (UTC day)` +
    (spend.readCapped ? ', more review lines than one read takes' : '');
}
