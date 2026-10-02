import { LIST_PAGE_MAX } from '@substrat-run/contracts';
import type { Page } from '@substrat-run/contracts';
import { ControlPlaneError, ControlPlaneStaffClient } from '@substrat-run/control-plane-api/browser';
import type { PageQuery } from '@substrat-run/control-plane-api/browser';

/**
 * The console's view of the control-plane API (packages/control-plane-api).
 *
 * The calls themselves live in `ControlPlaneStaffClient` (#971) — one typed client, one
 * transport, one error — and this module is only what is the console's own: which
 * credential a request carries, and the vocabulary the views import from here.
 *
 * The types come from `@substrat-run/contracts` and the client rather than being restated
 * here: the console renders the kernel's own vocabulary, so a field the platform renames
 * should break this build rather than render `undefined` in a table.
 */

export type {
  AdminLogPage,
  AuditLogQuery,
  ConnectionHealthQuery,
  ConnectorCallsBucket,
  EgressReport,
  IssuesQuery,
  MembersReading,
  ObservedEgressRow,
  OpsFailuresQuery,
  PageQuery,
  RecentLogEvent,
  ServiceMetricsRow,
  StaffMember,
  SweepRunsQuery,
  SystemSwitchesQuery,
} from '@substrat-run/control-plane-api/browser';

/**
 * A refused or unreachable control-plane call. The views catch it as `ApiError` and read
 * `status` (a 501 is "this plane predates the route", never a fault); it is the client's
 * own `ControlPlaneError`, so there is exactly one error class on the wire. `status` is 0
 * when the plane could not be reached at all.
 */
export const ApiError = ControlPlaneError;
export type ApiError = ControlPlaneError;

/**
 * Walk a paged read to exhaustion — for computations that need the FULL set
 * (fleet counts, cascade status, the bindable-scope dropdown) now that every
 * list egress defaults a page. Max-sized pages until the cursor runs out;
 * `nextCursor: null` is the end of the walk, never a trailing empty fetch.
 */
export async function walkAll<T>(fetchPage: (page: PageQuery) => Promise<Page<T>>): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage({ limit: LIST_PAGE_MAX, cursor });
    all.push(...page.entries);
    if (page.nextCursor === null) return all;
    cursor = page.nextCursor;
  }
}

/**
 * `actor` is the dev-actor id for the co-located quick path (sent as a header),
 * or null in session mode, where the staff session cookie authenticates instead.
 * `credentials: 'include'` carries that cookie (harmless in dev mode).
 */
export function createApi(actor: string | null, baseUrl = '/api') {
  // An empty actor sends no header, as it always has here — the client's `null` is the
  // "no dev actor" spelling, so an empty string is folded into it.
  return new ControlPlaneStaffClient({ baseUrl, actor: actor || null, credentials: 'include' });
}

export type Api = ReturnType<typeof createApi>;
