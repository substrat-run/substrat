/**
 * The dashboard's declared HTTP surface (#2170) — one entry per route, and every path
 * relative to the TEAM it is about.
 *
 * `worker.ts` mounts this under `/api/teams/:teamId` (`mountRoutes`), so a request names
 * its team in its own URL instead of inheriting it from the `sb_team` cookie. The cookie
 * is shared by every tab on the origin, so a team read from it was the team the LAST tab
 * switched to: a tab still showing team A read — and wrote — team B. A path cannot be
 * shared that way.
 *
 * From this one object come the route table and its input/output parsing (`mountRoutes`),
 * the handler map's type (`satisfies RouteImpl<typeof dashboardRoutes, …>` in `worker.ts`)
 * and the browser client (`web/src/lib/api.generated.ts`, `pnpm lint:client`). Routes move
 * here area by area; until an area has moved, its routes are still the hand-written,
 * cookie-scoped ones in `worker.ts`.
 *
 * These are ROUTES, not operations: their handlers call the control plane, which module
 * code may not. When one becomes a model operation (#1185), its entry keeps its path and
 * schemas and only its implementation moves.
 */
import {
  defineRoutes,
  FINDINGS_LIMIT_MAX,
  findingEntry,
  findingKind,
  findingRuleEntry,
  findingRuleInput,
  findingStatus,
  findingStatusInput,
  z,
} from '@substrat-run/contracts';

export const dashboardRoutes = defineRoutes({
  // -- findings (#1748) ------------------------------------------------------
  'dashboard/list-findings': {
    summary: "One page of this team's findings, most recently seen first",
    // `limit` defaults to 100 and tops out at 500; `cursor` is the previous page's `nextCursor`, opaque.
    input: z.object({
      status: findingStatus.optional(),
      kind: findingKind.optional(),
      limit: z.number().int().min(1).max(FINDINGS_LIMIT_MAX).optional(),
      cursor: z.string().min(1).optional(),
    }),
    // `available: false` is a plane that predates findings — said as such, never as an empty inbox.
    // `nextCursor` is null when the walk is over. `cut` is true only when a control plane that
    // predates paging returned a full page it cannot continue: the list may be longer than shown.
    output: z.object({ available: z.boolean(), entries: z.array(findingEntry), nextCursor: z.string().nullable(), cut: z.boolean() }),
    http: { method: 'GET', path: '/findings' },
  },
  'dashboard/set-finding-status': {
    summary: "Acknowledge, resolve or reopen one of this team's findings",
    input: z.object({ id: z.string().min(1), status: findingStatusInput }),
    output: findingEntry,
    http: { method: 'PUT', path: '/findings/{id}/status' },
  },
  'dashboard/list-finding-rules': {
    summary: "This team's suppress rules; `active` keeps the unexpired ones",
    input: z.object({ active: z.boolean().optional() }),
    output: z.object({ entries: z.array(findingRuleEntry) }),
    http: { method: 'GET', path: '/findings/rules' },
  },
  'dashboard/create-finding-rule': {
    summary: 'Suppress with a rule: a scope plus an expiry, audited by the plane',
    input: findingRuleInput,
    output: z.object({ rule: findingRuleEntry, suppressed: z.number().int().nonnegative() }),
    http: { method: 'POST', path: '/findings/rules' },
    status: 201,
  },
  'dashboard/revoke-finding-rule': {
    summary: 'End a suppress rule now',
    input: z.object({ ruleId: z.string().min(1) }),
    output: findingRuleEntry,
    http: { method: 'DELETE', path: '/findings/rules/{ruleId}' },
  },
});

// Re-exported so the generated client names them (`substrat.client.schemas`) instead of
// inlining each one at every method that returns it.
export { findingEntry, findingRuleEntry };
