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
  adminLogEntry,
  defineRoutes,
  LIST_PAGE_MAX,
  FINDINGS_LIMIT_MAX,
  findingEntry,
  findingKind,
  findingRuleEntry,
  findingRuleInput,
  findingStatus,
  findingStatusInput,
  z,
} from '@substrat-run/contracts';

/** The shared page query: the platform's `limit`/`cursor` (default 20, `LIST_PAGE_MAX`), cursor opaque. */
const pageInput = {
  limit: z.number().int().min(1).max(LIST_PAGE_MAX).optional(),
  cursor: z.string().min(1).optional(),
};

/** `{ entries, nextCursor }` — null once the keyset walk is over (contracts `pagination.ts`). */
const pageOutput = <T extends z.ZodTypeAny>(entry: T) =>
  z.object({ entries: z.array(entry), nextCursor: z.string().nullable() });

/** One installed app, as the Apps list shows it. */
export const appRow = z.object({
  id: z.string(),
  app_scope_id: z.string(),
  vertical_slug: z.string(),
  name: z.string(),
  status: z.enum(['provisioning', 'active', 'failed']),
  hostname: z.string().nullable(),
  /** The vertical's non-secret provision result as JSON (#426); null for a bare ack. */
  provision_result: z.string().nullable().optional(),
  created_by: z.string(),
  created_at: z.string(),
});

/** One step of an app's install sequence (#424); a failed step carries the downstream error verbatim. */
export const installStep = z.object({
  step: z.string(),
  seq: z.number().int(),
  status: z.enum(['running', 'done', 'failed']),
  attempts: z.number().int(),
  last_error: z.string().nullable(),
  started_at: z.string(),
  settled_at: z.string().nullable(),
});

/** One lifecycle transition in an app's Activity panel. */
export const appEvent = z.object({
  id: z.string(),
  app_scope_id: z.string(),
  kind: z.enum(['created', 'active', 'failed', 'deleted', 'updated', 'snapshotted', 'snapshot-deleted', 'data-exported', 'data-restored']),
  /** Failure reason / bound hostname / the version move / the vertical slug — depending on `kind`. */
  detail: z.string().nullable(),
  actor: z.string(),
  created_at: z.string(),
});

export const dashboardRoutes = defineRoutes({
  // -- apps: the read side (#2170) --------------------------------------------
  'dashboard/list-apps': {
    summary: "One page of this team's apps, newest first",
    input: z.object(pageInput),
    output: pageOutput(appRow),
    http: { method: 'GET', path: '/apps' },
  },
  'dashboard/get-app-install-steps': {
    summary: "An app's durable install record: directory, provision, activate, hostname, identity",
    input: z.object({ scopeId: z.string().min(1) }),
    output: z.array(installStep),
    http: { method: 'GET', path: '/apps/{scopeId}/steps' },
  },
  'dashboard/list-app-events': {
    summary: "One page of an app's lifecycle trail (Activity panel), newest first",
    input: z.object({ scopeId: z.string().min(1), ...pageInput }),
    output: pageOutput(appEvent),
    http: { method: 'GET', path: '/apps/{scopeId}/events' },
  },
  'dashboard/list-app-audit': {
    summary: "One page of the control-plane admin log for one of this team's apps, newest first",
    input: z.object({ scopeId: z.string().min(1), ...pageInput }),
    output: pageOutput(adminLogEntry),
    http: { method: 'GET', path: '/apps/{scopeId}/audit' },
  },
  'dashboard/list-team-audit': {
    summary: "One page of this team's whole admin log, or one app's with `scopeId`, newest first",
    input: z.object({ scopeId: z.string().min(1).optional(), ...pageInput }),
    output: pageOutput(adminLogEntry),
    http: { method: 'GET', path: '/audit' },
  },

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
export { adminLogEntry, findingEntry, findingRuleEntry };
