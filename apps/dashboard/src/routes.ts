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
  dnsRecord,
  hostnameStatus,
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
import { appAuthChoiceBody } from './app-auth-body.js';
import { APP_EVENT_KINDS } from './app-event-kinds.js';

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
  kind: z.enum(APP_EVENT_KINDS),
  /** Failure reason / bound hostname / the version move / the vertical slug — depending on `kind`. */
  detail: z.string().nullable(),
  actor: z.string(),
  created_at: z.string(),
});

/** What the install form posts. */
export const installAppInput = z.object({
  verticalSlug: z.string().min(1),
  name: z.string().min(1),
  /** The Identity section's choice (vertical-auth-detach.md §2.4). Absent ⇒ builtin. */
  auth: appAuthChoiceBody.optional(),
  /**
   * The install form's config values (#426), keyed by env-spec key. The handler narrows
   * them to the vertical's DECLARED spec (the manifest is the allow-list, exactly as
   * `resolveScopedEnvSpec` reads) — an undeclared key is dropped, not delivered.
   */
  config: z.record(z.string(), z.string()).optional(),
});

/** One custom domain, as the team's Domains view lists it. */
export const domainRow = z.object({
  hostname: z.string(),
  appScopeId: z.string(),
  /** The app (vertical install) this domain fronts. */
  app: z.string(),
  surface: z.string(),
  status: hostnameStatus,
  statusNote: z.string().nullable(),
  /** Canonical for its (scope, surface) — the "primary" tag. */
  primary: z.boolean(),
  createdAt: z.string(),
  /** DNS records to publish while it is not yet active. */
  validationRecords: z.array(dnsRecord),
});

/** What binding or re-polling a custom domain answers: where issuance stands and what to publish. */
export const domainBinding = z.object({
  hostname: z.string(),
  status: hostnameStatus,
  statusNote: z.string().nullable().optional(),
  validationRecords: z.array(dnsRecord).optional(),
});

/** One hostname bound to an app's scope (an app's Domains tab). */
export const appHostnameRow = z.object({
  hostname: z.string(),
  surface: z.string(),
  status: z.string(),
  /** Why a row is `failed` (or mid-flight detail) — rendered under the status pill. */
  statusNote: z.string().nullable(),
  canonical: z.boolean(),
  createdAt: z.string().nullable(),
  /** DNS records to publish for a custom domain; empty for a platform mint. */
  validationRecords: z.array(dnsRecord),
});

/** A surface the app's vertical declares it serves — the Domains tab's picker. */
const declaredSurface = z.object({ name: z.string(), label: z.string() });

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
    // An empty `scopeId` is no narrowing — the whole log, as the cookie route reads it.
    input: z.object({ scopeId: z.string().optional(), ...pageInput }),
    output: pageOutput(adminLogEntry),
    http: { method: 'GET', path: '/audit' },
  },

  // -- apps: the lifecycle writes (#2170) -------------------------------------
  // Each is gated in the dashboard scope by `dashboard:provision-app` (the operations the
  // provisioning helpers invoke), exactly as the cookie routes they replace were.
  'dashboard/install-app': {
    summary: 'Install a vertical into this team as a new app',
    input: installAppInput,
    output: appRow,
    http: { method: 'POST', path: '/apps' },
    status: 201,
  },
  'dashboard/remove-app': {
    summary: "Delete one of this team's apps: deprovision its scope and take its hostname offline",
    // `id` is the app's row id (`appRow.id`), as the cookie route took it — not its scope id.
    input: z.object({ id: z.string().min(1) }),
    // A declared route owes an output; the cookie route's empty 204 becomes this 200.
    output: z.object({ removed: z.literal(true) }),
    http: { method: 'DELETE', path: '/apps/{id}' },
  },
  'dashboard/retry-app': {
    summary: 'Re-provision a failed app under a fresh scope (409 unless it failed)',
    input: z.object({ scopeId: z.string().min(1) }),
    output: appRow,
    http: { method: 'POST', path: '/apps/{scopeId}/retry' },
    status: 201,
  },
  'dashboard/resume-app': {
    summary: 'Finish the install of an app stuck provisioning, in place (409 unless it is)',
    input: z.object({ scopeId: z.string().min(1) }),
    output: appRow,
    http: { method: 'POST', path: '/apps/{scopeId}/resume' },
  },

  // -- domains (#2170) --------------------------------------------------------
  // The team's custom domains (§4.7). The control plane narrows each call to the team; the
  // cookie routes these replace asked nothing more of the dashboard scope, and neither do these.
  'dashboard/list-domains': {
    summary: "One page of this team's custom domains (the platform default each app rides is not listed)",
    input: z.object(pageInput),
    output: pageOutput(domainRow),
    http: { method: 'GET', path: '/domains' },
  },
  'dashboard/add-domain': {
    summary: "Add a custom domain to one of this team's apps; lands verifying with the DNS records to publish",
    input: z.object({
      hostname: z.string().trim().min(1).max(253),
      appScopeId: z.string().min(1),
      surface: z.string().trim().min(1).default('app'),
    }),
    output: domainBinding,
    http: { method: 'POST', path: '/domains' },
    status: 201,
  },
  'dashboard/verify-domain': {
    summary: "Re-poll a custom domain's issuance (\"check again\")",
    input: z.object({ hostname: z.string().min(1) }),
    output: domainBinding,
    http: { method: 'POST', path: '/domains/{hostname}/verify' },
  },
  'dashboard/remove-domain': {
    summary: "Remove a custom domain: releases the Cloudflare custom hostname and drops the binding",
    input: z.object({ hostname: z.string().min(1) }),
    output: z.object({ deleted: z.string() }),
    http: { method: 'DELETE', path: '/domains/{hostname}' },
  },

  // -- apps: hostnames (#2170) ------------------------------------------------
  // One scope can front more than one app (K-26): the hostname decides the surface. Binding and
  // unbinding are gated in the dashboard scope by `dashboard:provision-app`, as the cookie routes were.
  'dashboard/list-app-hostnames': {
    summary: "An app's hostname bindings, the surfaces its vertical declares, and its untouchable default",
    input: z.object({ scopeId: z.string().min(1) }),
    output: z.object({
      bindings: z.array(appHostnameRow),
      surfaces: z.array(declaredSurface),
      defaultHostname: z.string().nullable(),
    }),
    http: { method: 'GET', path: '/apps/{scopeId}/hostnames' },
  },
  'dashboard/add-app-hostname': {
    summary: 'Bind a hostname to a surface of this app: platform-minted (lands active) or a custom domain (lands pending)',
    input: z.object({
      scopeId: z.string().min(1),
      surface: z.string().min(1).max(32),
      domain: z.string().min(1).max(253).optional(),
    }),
    output: appHostnameRow,
    http: { method: 'POST', path: '/apps/{scopeId}/hostnames' },
    status: 201,
  },
  'dashboard/remove-app-hostname': {
    summary: "Unbind one hostname (409 for the app's default hostname)",
    input: z.object({ scopeId: z.string().min(1), hostname: z.string().min(1) }),
    output: z.object({ deleted: z.string() }),
    http: { method: 'DELETE', path: '/apps/{scopeId}/hostnames/{hostname}' },
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
