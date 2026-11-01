/**
 * The query a tenant-grain request read takes (#1746): the tenant, the window, the facet
 * filters and the free-text search (#2762). Shared by the three request routes so they refuse
 * and accept the same things, and so the count, the histogram and the list beside it always
 * describe one set — which is why the two counting routes refuse `search` outright.
 */
import { z, substratError, tenantId as tenantIdSchema, ENTITY_TYPES_SEPARATOR, INVOCATION_RECORD_FIELD_MAX } from '@substrat-run/contracts';
import {
  INVOCATION_KINDS,
  REQUEST_FACET_KEYS,
  REQUEST_SEARCH_MAX,
  REQUEST_SEARCH_NOT_COUNTED,
  type RequestFacetKey,
  type RequestWhere,
  type TenantRequestScope,
} from './observability.js';
import { stableDeploymentRefFor } from './deploy.js';

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
  // #1901: what kind of work a line is about; `request` matches the lines that carry none.
  kind: z.enum(INVOCATION_KINDS),
  // #2762: ONE entity type — a value holding the separator is a set, never a type.
  entity: z
    .string()
    .min(1)
    .max(INVOCATION_RECORD_FIELD_MAX)
    .refine((v) => !v.includes(ENTITY_TYPES_SEPARATOR), 'entity is one entity type'),
  // #2762: a route as the line writes it — `<METHOD> <pattern>`, never longer than the record
  // keeps. A called path (`/api/items/7`) is refused rather than matching nothing.
  path: z
    .string()
    .max(INVOCATION_RECORD_FIELD_MAX)
    .regex(/^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|OTHER) \S/, 'path is a route: a method and the pattern it was registered under'),
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
  const base = parseTenantWindowQuery(tenantId, q, now);
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
  // #2762: surrounding space is not part of what a reader looks for; an empty one is no filter.
  const { search } = z.object({ search: z.string().max(REQUEST_SEARCH_MAX) }).parse({ search: q.one('search')?.trim() ?? '' });
  return { ...base, ...(Object.keys(where).length > 0 ? { where } : {}), ...(search ? { search } : {}) };
}

/**
 * #2762: refuse `search` on a read that counts. The histogram and the facets are computed from
 * cubes (#1877) holding neither a request id nor a path, so no count could honour the text the
 * list is filtered by. A refusal, never an ignored filter: counts of every request would read
 * as counts of the matching ones. A semantic refusal, so no `errors` list: one would make it
 * read as a parse failure, which answers neither the `reason` nor this sentence.
 */
export function refuseSearchOnCounts(scope: TenantRequestScope): void {
  if (scope.search === undefined) return;
  throw substratError(
    'validation_failed',
    'request counts cannot be narrowed by search; search applies to the request list',
    { reason: REQUEST_SEARCH_NOT_COUNTED },
  );
}

/**
 * The tenant, the narrowing within it and the resolved window — the half every tenant-grain
 * aggregate read shares (#1746 requests, #1747 log patterns).
 */
export function parseTenantWindowQuery(
  tenantId: string,
  q: QueryReader,
  now: number = Date.now(),
): Omit<TenantRequestScope, 'where'> {
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
  const { from, to } = resolveTenantWindow(base, now);
  return {
    tenantId: base.tenantId,
    ...(base.scopeId ? { scopeId: base.scopeId } : {}),
    ...(base.vertical ? { vertical: base.vertical } : {}),
    from,
    to,
  };
}

/**
 * #1877: the script FAMILIES a tenant's app — or, with no scope named, its apps — are served
 * from. A family is a vertical's stem (`stableDeploymentRefFor`): its serving script, every
 * per-version script (`<stem>-<ulid>`, which previews and legacy scopes run on), and any
 * jurisdictional one (`<stem>-eu`).
 *
 * The family, not the script a scope is on today, because a scope MOVES between them — a
 * preview onto each push's own script, a legacy scope on a rebind, any scope on
 * `adopt-serving` — and a read scoped to today's script alone would draw silence before
 * the move. Every script in a family belongs to the same vertical, so the trust boundary
 * holds; the tenant and scope filters still narrow the rows within it.
 *
 * Only the tenant's own scopes are given, so a foreign scope id matches none.
 */
export function scriptFamiliesOfScopes(
  scopes: ReadonlyArray<{ id: string; vertical: string | null }>,
  narrow: { scopeId?: string | undefined; vertical?: string | undefined },
): string[] {
  const families = new Set<string>();
  for (const s of scopes) {
    if (narrow.scopeId && s.id !== narrow.scopeId) continue;
    if (narrow.vertical && s.vertical !== narrow.vertical) continue;
    if (s.vertical) families.add(stableDeploymentRefFor(s.vertical));
  }
  return [...families];
}
