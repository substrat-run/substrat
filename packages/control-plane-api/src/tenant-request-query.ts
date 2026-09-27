/**
 * The query a tenant-grain request read takes (#1746): the tenant, the window, and the
 * facet filters. Shared by the three request routes so they refuse and accept the same
 * things, and so the count, the histogram and the list beside it always describe one set.
 */
import { z, tenantId as tenantIdSchema } from '@substrat-run/contracts';
import { REQUEST_FACET_KEYS, type RequestFacetKey, type RequestWhere, type TenantRequestScope } from './observability.js';

/** The widest window a tenant-grain read may cover — the same three days `hours` caps at. */
export const TENANT_WINDOW_MAX_HOURS = 72;

/** How many alternatives one facet filter may name. A panel ticks a handful, never hundreds. */
export const REQUEST_WHERE_VALUES_MAX = 20;

/**
 * The window rules every tenant-grain read shares, on the RESOLVED bounds.
 *
 * On the resolved bounds rather than on the pair, so a lone `since` in the future is refused
 * by the same line: with no `until` it is measured against now, and without this it would
 * reach the backend as a window that cannot contain anything and come back as an empty page
 * nobody could explain. The three-day ceiling applies however the window was spelled, or
 * the pair would be a second door onto a read `hours` caps. And a window ending in the
 * future returns nothing and says nothing about why, which a reader takes for "my app was
 * quiet"; five minutes of slack, because the instant is stamped by a browser's clock.
 */
export function refineTenantWindow(
  v: { hours: number; since?: string | undefined; until?: string | undefined },
  ctx: z.RefinementCtx,
  now: number = Date.now(),
): void {
  const { from, to } = resolveTenantWindow(v, now);
  if (from >= to) {
    ctx.addIssue({ code: 'custom', path: ['since'], message: 'since must be before until' });
  }
  if (to - from > TENANT_WINDOW_MAX_HOURS * 3_600_000) {
    ctx.addIssue({ code: 'custom', path: ['since'], message: `the window may not exceed ${TENANT_WINDOW_MAX_HOURS} hours` });
  }
  if (to > now + 5 * 60_000) {
    ctx.addIssue({ code: 'custom', path: ['until'], message: 'until may not be more than 5 minutes in the future' });
  }
}

/** `until` defaults to now and `since` to `until − hours`; both given, `hours` is ignored. */
export function resolveTenantWindow(
  v: { hours: number; since?: string | undefined; until?: string | undefined },
  now: number = Date.now(),
): { from: number; to: number } {
  const to = v.until ? Date.parse(v.until) : now;
  const from = v.since ? Date.parse(v.since) : to - v.hours * 3_600_000;
  return { from, to };
}

/**
 * One facet's filter values. `status` is a three-digit code and `level` one of the line's
 * own levels; the rest are free strings, bounded. A value outside those is a 400 rather than
 * a filter that can only match nothing, which a panel would render as "no such requests".
 */
const facetValue: Record<RequestFacetKey, z.ZodType<string>> = {
  level: z.enum(['info', 'warn', 'error']),
  status: z.string().regex(/^[1-5][0-9]{2}$/, 'status must be an HTTP status code'),
  operation: z.string().min(1).max(200),
  principalKind: z.string().min(1).max(40),
  problemCode: z.string().min(1).max(80),
  surface: z.string().min(1).max(80),
};

/** A query-string reader — Hono's `c.req.query` / `c.req.queries`, taken structurally. */
export interface QueryReader {
  one(key: string): string | undefined;
  all(key: string): string[];
}

/**
 * Parse the shared part of a request read. `tenantId` is the caller's resolved tenant (the
 * session's own, or staff's explicit one) and is never read from the query here.
 */
export function parseTenantRequestQuery(tenantId: string, q: QueryReader, now: number = Date.now()): TenantRequestScope {
  const base = z
    .object({
      tenantId: tenantIdSchema,
      // Narrowing WITHIN the tenant: the reader always applies the tenant predicate, so a
      // foreign scope id yields zero rows rather than somebody else's.
      scopeId: z.string().min(1).max(64).optional(),
      vertical: z.string().min(1).max(200).optional(),
      hours: z.coerce.number().int().min(1).max(TENANT_WINDOW_MAX_HOURS).default(24),
      since: z.string().datetime({ offset: true }).optional(),
      until: z.string().datetime({ offset: true }).optional(),
    })
    .superRefine((v, ctx) => refineTenantWindow(v, ctx, now))
    .parse({
      tenantId,
      scopeId: q.one('scopeId') || undefined,
      vertical: q.one('vertical') || undefined,
      hours: q.one('hours'),
      since: q.one('since') || undefined,
      until: q.one('until') || undefined,
    });
  const where: RequestWhere = {};
  for (const key of REQUEST_FACET_KEYS) {
    // Repeated keys are the alternatives (`level=warn&level=error`); an empty one is no filter.
    const values = q.all(key).filter((v) => v.length > 0);
    if (values.length === 0) continue;
    where[key] = z
      .array(facetValue[key])
      .max(REQUEST_WHERE_VALUES_MAX)
      .parse([...new Set(values)]);
  }
  const { from, to } = resolveTenantWindow(base, now);
  return {
    tenantId: base.tenantId,
    ...(base.scopeId ? { scopeId: base.scopeId } : {}),
    ...(base.vertical ? { vertical: base.vertical } : {}),
    from,
    to,
    ...(Object.keys(where).length > 0 ? { where } : {}),
  };
}
