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
  bindAcknowledgement,
  channelHistoryEntry,
  channelName,
  connectionActivity,
  connectionCredentialField,
  connectionProbe,
  connectionSendTestResult,
  causeChain,
  deadLetter,
  defineRoutes,
  dnsRecord,
  edgeHealth,
  edgeHealthReport,
  envVarSpec,
  eventDelivery,
  eventFacetResult,
  historyEntry,
  LIST_PAGE_MAX,
  opsFailureEntry,
  FINDINGS_LIMIT_MAX,
  findingEntry,
  findingEvidence,
  findingKind,
  findingLikelyCause,
  findingRuleEntry,
  findingRuleInput,
  findingStatus,
  findingStatusInput,
  memberInviteInput,
  memberInviteLink,
  memberRemoval,
  memberRoleInput,
  ownerClaimLink,
  ownerSeat,
  permissionRegistry,
  permissionDenial,
  peerGrantsStatusEntry,
  peerSwitchResult,
  previewAuth,
  REBIND_REVIEW_REASONS,
  scopeDump,
  scopeQueryResult,
  scopeTable,
  scopeTablePage,
  scopeMemberInvite,
  scopeMembers,
  promotionAcknowledgement,
  importCursorMoved,
  versionOrigin,
  verticalSlug,
  z,
} from '@substrat-run/contracts';
import { LOGS_INCOMPLETE_HEADER } from '@substrat-run/control-plane-api/browser';
import { appAuthChoiceBody } from './app-auth-body.js';
import { logOutputDrift } from './output-drift.js';
import { CONNECT_LINK_MAX_TTL_MS, appEvent, appRow, explanationProvenance, installStep, memberRow } from './rows.js';
import { ASK_TURN_MAX, ASK_TURNS_MAX } from './ask.js';

// The rows the module shares, declared where module code may import them (`rows.ts`); the
// browser client's schemas are read off this file's exports, so they stay exported here.
export { appEvent, appRow, installStep, memberRow };

/** The shared page query: the platform's `limit`/`cursor` (default 20, `LIST_PAGE_MAX`), cursor opaque. */
const pageInput = {
  limit: z.number().int().min(1).max(LIST_PAGE_MAX).optional(),
  cursor: z.string().min(1).optional(),
};

/** `{ entries, nextCursor }` — null once the keyset walk is over (contracts `pagination.ts`). */
const pageOutput = <T extends z.ZodTypeAny>(entry: T) =>
  z.object({ entries: z.array(entry), nextCursor: z.string().nullable() });

const integrationConnection = z.object({
  id: z.string(),
  label: z.string(),
  status: z.string(),
  externalAccountRef: z.string().nullable(),
  expiresAt: z.string().nullable(),
  lastOkAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  createdAt: z.string(),
});
/** A consent-round connect link as the panel shows it; the signed URL only ever rides the mint answer. */
const appConnectLink = z.object({
  id: z.string(),
  provider: z.string(),
  appScopeId: z.string(),
  // outstanding · used · revoked; the plane owns the status of an app-minted link.
  status: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
/** A provider as its connect form renders it (`providerForm` in the worker). */
const integrationProviderForm = z.object({
  provider: z.string(), name: z.string(), description: z.string(), monogram: z.string(),
  fields: z.array(z.object({
    key: z.string(), label: z.string(), secret: z.boolean(), placeholder: z.string().optional(),
    optional: z.boolean().optional(), toggle: z.boolean().optional(),
  })),
  connectFlow: z.literal('redirect').nullable(), multiAccount: z.boolean(), sendsMail: z.boolean(),
});
// The plane owns a sweep's outcome, so it stays a string.
const integrationSweepRun = z.object({
  id: z.string(), outcome: z.string(), at: z.string(), error: z.string().nullable(), elapsedMs: z.number().nullable(),
});
/** An identity link as either directory holds it; loose, since the shared one is the plane's. */
const mirroredIdentityLink = z.object({
  provider: z.string(), externalId: z.string(), principal: z.string(), tenantId: z.string(), scopeId: z.string().optional(),
});
const integrationProbeBody = connectionProbe.extend({ refused: z.boolean().optional() });
const integrationProbe = integrationProbeBody.extend({ connection: integrationConnection.optional() });
const integrationActivity = connectionActivity.extend({
  source: z.string(),
  grants: z.array(z.string()),
  credential: z.array(connectionCredentialField),
  certificate: z.object({
    pem: z.string(), thumbprint: z.string(), notAfter: z.string(),
    next: z.object({ pem: z.string(), thumbprint: z.string(), notAfter: z.string() }).optional(),
  }).nullable(),
  /** #2343: the addresses a send test may go from; empty for a provider that sends no mail. */
  mailSenders: z.array(z.string()),
  connection: integrationConnection,
  sweepRuns: z.array(integrationSweepRun),
  intents: z.array(z.object({
    id: z.string(), status: z.string(), attempts: z.number(), lastError: z.string().nullable(),
    failure: z.object({ origin: z.string(), code: z.string().nullable(), permission: z.string().nullable() }).nullable(),
    requestedAt: z.string(), settledAt: z.string().nullable(), eventType: z.string(),
  })),
  unreadableIntents: z.array(z.object({
    id: z.string().nullable(), status: z.string().nullable(), requestedAt: z.string().nullable(), decodeError: z.string(),
  })),
});

const declaredPeerCall = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not-installed'), vertical: z.string() }),
  z.object({ state: z.literal('ambiguous'), vertical: z.string(), count: z.number() }),
  z.object({ state: z.literal('bound-unavailable'), vertical: z.string() }),
  z.object({ state: z.literal('not-declared'), vertical: z.string() }),
  z.object({ state: z.literal('allowed'), vertical: z.string(), scopeId: z.string() }),
  z.object({ state: z.literal('switched-off'), vertical: z.string(), scopeId: z.string(), switchedOff: peerGrantsStatusEntry.shape.switchedOff }),
  z.object({ state: z.literal('no-grant'), vertical: z.string(), scopeId: z.string() }),
  z.object({ state: z.literal('unreadable'), vertical: z.string(), scopeId: z.string(), message: z.string() }),
]);
const edgeHealthOut = edgeHealth.extend({
  state: z.string(),
  lastProblem: edgeHealth.shape.lastProblem.unwrap().extend({ outcome: z.string() }).nullable(),
});

/*
 * VERSION SKEW (#2170, #2401). The control plane ships separately from the dashboard, so a plane
 * newer than this dashboard can answer a value this dashboard's contracts do not know. A route
 * parses its output on the way out, and a parse that fails is an error the caller sees — for a
 * WRITE, after the write happened (a domain bound, a preview created, a finding resolved, reported
 * as a failure). So the schemas below for values the PLANE decides are forward-compatible:
 *
 * - an enum the plane owns is a `string` here, its known values documented, and reaches the page
 *   as the plane said it (`hostnameStatusOut`, `adminLogRow`, `findingRow`, `previewAuthOut`);
 * - a block the dashboard only forwards to a human who must read it, and whose absence already
 *   means "cannot show you this" (a registry, a migration diff, a version's origin, a finding's
 *   evidence and likely cause), falls back to `null` on a value it cannot parse. For the promote review that is the
 *   safe direction: the dialog treats `null` as "cannot diff, ask for an acknowledgement", never
 *   as "no change";
 * - a block whose absence would mean "nothing to worry about" (`exportBreaks`: whom the promotion
 *   breaks) is never nulled; it is declared loosely (plain strings, no enums or id formats) so it
 *   always reaches the dialog as the plane named it.
 *
 * `test/route-output-vocabulary.test.ts` holds every output to the first point: each enum or
 * literal left in one must be the dashboard's own, listed there with why.
 */

/**
 * A plane-owned block that reads as `null` ("cannot show") when this dashboard cannot parse it,
 * and says so in the log (`dashboard.output-drift`, the field and the issue paths only).
 */
const orNull = <T extends z.ZodType>(schema: T, field: string) =>
  schema.nullable().catch((ctx) => {
    // `z.toJSONSchema` asks for the fallback with no context, to document it as the default
    // (`openapi.json`, via `api.ts`); only a real parse has drift to report.
    if (ctx) logOutputDrift(field, ctx.error.issues);
    return null;
  });

/** Where a hostname's issuance stands. The plane owns the set (known: pending, verifying, active, failed — contracts `hostnameStatus`). */
const hostnameStatusOut = z.string();

/** A DNS record to publish (contracts `dnsRecord`). Its `type` is the plane's (known: hostname, txt). */
const dnsRecordOut = dnsRecord.extend({ type: z.string() });

/**
 * One admin-log row (contracts `adminLogEntry`). The plane owns `action` (known: contracts
 * `adminAction`) and an audited change's `outcome` (known: pending, applied, refused, failed,
 * unknown, conflicting); an action this dashboard does not know is listed as the plane named it.
 */
export const adminLogRow = adminLogEntry.extend({
  action: z.string(),
  audited: adminLogEntry.shape.audited.unwrap().extend({ outcome: z.string() }).optional(),
});

/**
 * One finding (contracts `findingEntry`). The plane owns `kind` (known: invariant, drift,
 * recurring), `status` (known: open, acked, resolved, suppressed), `severity` (known: info,
 * warning, critical), `resolution` (known: verdict, stale), each of `codes` (known: contracts
 * `errorCode`) and a likely cause's `kind` (known: deploy). `evidence` (where the occurrences are
 * read) and `likelyCause` are only shown to a person: one this dashboard cannot read is `null`.
 */
export const findingRow = findingEntry.extend({
  kind: z.string(),
  status: z.string(),
  severity: z.string(),
  resolution: z.string().nullable(),
  codes: z.array(z.string()),
  evidence: orNull(findingEvidence, 'findings.evidence'),
  likelyCause: orNull(findingLikelyCause.extend({ kind: z.string() }), 'findings.likelyCause'),
});

/**
 * What a page reads beside AI-written text (#1749): whether the deployment offers it at all, the
 * newest text filed for the subject, and the day's budget. `current` is false when the facts the
 * text was written from have moved since (a new occurrence, a moved count), and the page then
 * shows it as written against older data, beside a rewrite. Nothing here calls a model; only
 * the POST does, so a page load costs nothing.
 *
 * `reason` is why it is not offered: `off` (the deployment has not turned it on) or
 * `not-configured` (turned on, and the model it names cannot run here).
 */
export const explanationView = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  /** Who runs the model and what is sent there: the disclosure shown beside the button. */
  disclosure: z.object({ vendor: z.string(), location: z.string(), sent: z.string() }).nullable(),
  explanation: z
    .object({ text: z.string(), provenance: explanationProvenance, writtenAt: z.string(), current: z.boolean() })
    .nullable(),
  budget: z
    .object({
      person: z.object({ used: z.number().int().nonnegative(), limit: z.number().int().positive() }),
      team: z.object({ used: z.number().int().nonnegative(), limit: z.number().int().positive() }),
    })
    .nullable(),
});

/**
 * One question to the assistant (#2283): the conversation so far, oldest first, ending with the
 * person's question. The browser holds it until threads are recorded; the bounds are the
 * route's, so a long chat is cut by the page, not refused mid-sentence.
 */
const askInput = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(ASK_TURN_MAX) }))
    .min(1)
    .max(ASK_TURNS_MAX)
    .refine((m) => m[m.length - 1]!.role === 'user', { message: 'the last turn is the question' }),
});

/**
 * Which finding: its id, plus the status and kind the page last saw it under. The plane lists
 * findings and does not get one, so these narrow the walk to the tab it is in; they are hints,
 * and a finding that moved tab is still found.
 */
const findingExplanationInput = z.object({ id: z.string().min(1), status: z.string().max(32).optional(), kind: z.string().max(32).optional() });

/** The process map a note is about: the app's scope, the lifecycle and the period, as the map reads them. */
const processNoteInput = z.object({
  scopeId: z.string().min(1),
  entity: z.string().min(1).max(128),
  period: z.enum(['24h', '7d', '30d']),
});

/** A GitHub repo as `owner/name`. */
const githubRepo = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repo is owner/name');

/** A suppress rule (contracts `findingRuleEntry`). Its `kind` and `code` are the plane's, as on a finding. */
export const findingRuleRow = findingRuleEntry.extend({ kind: z.string().nullable(), code: z.string().nullable() });

/**
 * A suppress rule's body (contracts `findingRuleInput`). Its `kind` and `code` are copied from a
 * finding the plane answered and go back to the plane, which owns both sets and validates them: a
 * closed set here refused a rule for a kind the plane knows before the plane was asked. That a rule
 * narrows something stays this route's own check. Inputs the page builds from its own vocabulary
 * (a tab's status filter, a verdict) stay closed.
 */
const findingRuleIn = z
  .object({ ...findingRuleInput.shape, kind: z.string().min(1).optional(), code: z.string().min(1).optional() })
  .refine((r) => r.kind !== undefined || r.operation !== undefined || r.code !== undefined || r.subject !== undefined, {
    message: 'a suppress rule names at least one of kind, operation, code or subject',
  });

/** What the install form posts. */
export const installAppInput = z.object({
  verticalSlug,
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
  status: hostnameStatusOut,
  statusNote: z.string().nullable(),
  /** Canonical for its (scope, surface) — the "primary" tag. */
  primary: z.boolean(),
  createdAt: z.string(),
  /** DNS records to publish while it is not yet active. */
  validationRecords: z.array(dnsRecordOut),
});

/** What binding or re-polling a custom domain answers: where issuance stands and what to publish. */
const domainBinding = z.object({
  hostname: z.string(),
  status: hostnameStatusOut,
  statusNote: z.string().nullable().optional(),
  validationRecords: z.array(dnsRecordOut).optional(),
});

/** One hostname bound to an app's scope (an app's Domains tab). */
export const appHostnameRow = z.object({
  hostname: z.string(),
  surface: z.string(),
  status: hostnameStatusOut,
  /** Why a row is `failed` (or mid-flight detail) — rendered under the status pill. */
  statusNote: z.string().nullable(),
  canonical: z.boolean(),
  createdAt: z.string().nullable(),
  /** DNS records to publish for a custom domain; empty for a platform mint. */
  validationRecords: z.array(dnsRecordOut),
});

/** A role a member can be invited at — the owner is the un-invitable first member. */
const inviteRole = z.enum(['admin', 'member', 'viewer']);

/** What sending (or re-sending) an invite answers: the shareable link, and whether the email was accepted for delivery. */
const sentInvite = z.object({ invitationId: z.string(), acceptUrl: z.string(), emailDelivered: z.boolean() });

/** A surface the app's vertical declares it serves — the Domains tab's picker. */
const declaredSurface = z.object({ name: z.string(), label: z.string() });

/** A preview's login status. The plane owns the set (known: wired, unregistered, ambiguous, unknown, superseded, not-applicable); a newer one reaches the panel as the plane said it. */
const previewAuthOut = previewAuth.extend({ status: z.string() });

/** One version of a pushed vertical, as the Deployments view lists it (newest first within a deployment). */
export const deploymentVersion = z.object({
  id: z.string(),
  version: z.string(),
  /** `pending` | `admitted` | `rejected` — kept a string, as the registry may add states. */
  admission: z.string(),
  admissionNote: z.string().nullable(),
  deploymentRef: z.string().nullable(),
  /** Updating TO this version crosses a migration boundary (#286). */
  schemaChange: z.boolean(),
  /** Where the push came from; null for a push from before origin tracking. */
  // A push origin this dashboard cannot read is shown as an unknown one, not a failed list.
  origin: orNull(versionOrigin, 'deployments.versions.origin'),
  createdAt: z.string(),
});

// The plane may ship a newer env `kind` than this dashboard knows. Widen only the read
// shape; envVarSpec still validates declarations (including previewCarry rules).
const envSpecRow = z.object({ ...envVarSpec.shape, required: z.boolean(), secret: z.boolean(), kind: z.string().optional() });

/**
 * One vertical the New-app page offers this team: published ones plus the team's own. `owned`
 * groups it under "Your verticals", `listed` under "Marketplace"; `installable` is false until a
 * pushed vertical has a version promoted to prod.
 */
export const catalogRow = z.object({
  slug: z.string(),
  name: z.string(),
  owned: z.boolean(),
  listed: z.boolean(),
  source: z.string(),
  installable: z.boolean(),
  envSpec: z.array(envSpecRow).optional(),
  provides: z.array(z.string()).optional(),
  requires: z.array(z.string()).optional(),
});

/** A vertical this team pushed: its versions and where the `prod` channel points. */
export const deploymentRow = z.object({
  /** The full registry id, e.g. `acme-co/helpdesk` — what the routes below take. */
  slug: z.string(),
  displaySlug: z.string(),
  name: z.string(),
  source: z.string(),
  /** Published to the marketplace, which makes prod a staff decision. */
  listed: z.boolean(),
  versions: z.array(deploymentVersion),
  /** `servingVersionId` is what prod's serving script actually runs (#321); it trails `versionId` after a failed serve. */
  channels: z.array(z.object({ channel: z.string(), versionId: z.string(), servingVersionId: z.string().nullish() })),
});

/** The binding an acknowledgement carries to the review it answers (#2333): the base version and the digest read with it. */
export const reviewBinding = promotionAcknowledgement.shape.review.unwrap();

/**
 * The same binding as the plane answers it. `reviewBinding` is strict, as an INPUT should be (a
 * field the host does not know is refused, not dropped); on the way OUT a field a newer plane
 * adds must not fail the review, and the acknowledgement only ever carries `base` and `digest`.
 */
const reviewBindingOut = z.object({ base: z.string().min(1).nullable(), digest: z.string().regex(/^[0-9a-f]{64}$/) });

/** One migration as a review shows it; `sql` is null once the answer's byte budget ran out. */
const migrationEntry = z.object({
  moduleId: z.string(),
  version: z.string(),
  sql: z.string().nullable(),
  moves: z.record(z.string(), z.string()).optional(),
  discards: z.record(z.string(), z.string()).optional(),
  declarationsLeftOut: z.literal(true).optional(),
  edited: z.enum(['sql', 'declarations']).optional(),
});

/** The migrations a version adds on top of another (contracts `MigrationDiff`). */
const migrationDiff = z.object({
  baseline: z.enum(['version', 'none', 'unavailable']),
  added: z.array(migrationEntry),
  changed: z.array(migrationEntry),
  total: z.number().int(),
  truncated: z.boolean(),
});

/** One app a promotion breaks (contracts `exportBreak`), without the enums and id formats: it is shown to a person, never keyed on. */
const exportBreakOut = z.object({
  tenantId: z.string(),
  scopeId: z.string(),
  vertical: z.string(),
  version: z.string().nullable(),
  type: z.string(),
  schemaVersion: z.number().int(),
  incoming: z.number().int().nullable(),
});

/**
 * What promoting a version to `prod` would change (#1677): the permission surface and the
 * SQL, each against what `prod` serves now, whom the promotion breaks, and the binding an
 * acknowledgement of THIS review carries. A `null` is "cannot show", never "no change".
 */
export const promotionReviewRow = z.object({
  serving: z.object({ versionId: z.string() }).nullable(),
  incoming: z.object({ versionId: z.string() }),
  // A registry or SQL diff this dashboard cannot parse reads as "cannot show": the dialog then
  // asks for the acknowledgement it would ask for anyway, instead of the review failing to open.
  servingRegistry: orNull(permissionRegistry, 'promotionReview.servingRegistry'),
  incomingRegistry: orNull(permissionRegistry, 'promotionReview.incomingRegistry'),
  migrations: orNull(migrationDiff, 'promotionReview.migrations'),
  /** This tenant's own apps the promotion breaks by name, other tenants' as a count (#1705). Declared loosely: see the note on version skew above. */
  exportBreaks: z.object({ affected: z.array(exportBreakOut), otherTenants: z.number().int().optional() }).nullable(),
  review: reviewBindingOut.nullable(),
});

/**
 * One recorded go-live: what a channel started serving, what it replaced, who moved the pointer
 * and exactly when — the rollback picker's row. `at` is also the instant a point-in-time data
 * restore would rewind to.
 */
export const channelHistoryRow = channelHistoryEntry.pick({ id: true, versionId: true, fromVersionId: true, actor: true, at: true });

/** One recorded operational failure of a pushed vertical (#559) — a deploy, preview or provision the platform could not do. */
export const deployFailureRow = opsFailureEntry.pick({
  id: true,
  operation: true,
  stage: true,
  scopeId: true,
  status: true,
  message: true,
  /** The upstream provider's trace handle, when the message carried one. */
  reference: true,
  at: true,
});

/** Failures grouped by shape (#1233): counts cover the 90-day evidence window, not all time. */
export const failureGroupRow = z.object({
  fingerprint: z.string(),
  operation: z.string(),
  stage: z.string().nullable(),
  code: z.string().nullable(),
  origin: z.string().nullable(),
  count: z.number().int(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  lastMessage: z.string(),
  lastStatus: z.number().int().nullable(),
});

/** One version as a release (#1236): push instant, go-live moment, adoption and the version-stamped health facts. */
export const releaseRow = z.object({
  versionId: z.string(),
  version: z.string(),
  pushedAt: z.string(),
  origin: z.string().nullable(),
  schemaChange: z.boolean(),
  wentLiveAt: z.string().nullable(),
  isProd: z.boolean(),
  isServing: z.boolean(),
  scopesPinned: z.number().int(),
  failures: z.number().int(),
  /** Null = metrics unavailable, which is not zero traffic. */
  requests: z.number().nullable(),
  errors: z.number().nullable(),
});

/** The release ledger (#1236). */
export const releasesView = z.object({
  releases: z.array(releaseRow),
  /** Scopes with no pin: they follow prod, so belong to whatever `isProd` points at. */
  scopesTrackingProd: z.number().int(),
  metricsAvailable: z.boolean(),
});

/** One plotted bucket of traffic, zero-filled worker-side (#1236). */
const trafficBucket = z.object({
  start: z.string(),
  requests: z.number(),
  errors: z.number(),
  durationP95: z.number().nullable(),
  /** 2xx + 3xx and 4xx (#1693) — both present or both absent. */
  green: z.number().optional(),
  yellow: z.number().optional(),
});

/** The release chart's series (#1236): traffic over the window with every push and go-live drawn on it. */
export const trafficSeries = z.object({
  window: z.object({ since: z.string(), until: z.string() }).optional(),
  buckets: z.array(trafficBucket),
  markers: z.array(z.object({ at: z.string(), kind: z.enum(['pushed', 'went-live']), version: z.string(), versionId: z.string() })),
  bucketMinutes: z.number(),
  /** False = the plane cannot bucket; the chart says so instead of drawing silence. */
  available: z.boolean(),
});

const flowNode = z.object({
  id: z.string(), kind: z.enum(['trigger', 'module', 'event', 'connection', 'egress']), label: z.string(), sublabel: z.string().nullable(),
  observed: z.number().nullable(), silent: z.boolean(), stale: z.boolean(), status: z.enum(['ok', 'warn', 'danger']),
  title: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number(),
});
const appFlowView = z.object({
  findings: z.object({
    available: z.boolean(), observedComplete: z.boolean(), declaredComplete: z.boolean(),
    findings: z.array(z.object({ kind: z.enum(['unemitted', 'unconsumed', 'stale', 'unconnected-provider', 'unhealthy-provider']), subject: z.string(), moduleId: z.string().nullable(), detail: z.string() })),
    declaredTypes: z.number(), observedTypes: z.number(),
  }),
  graph: z.object({
    available: z.boolean(), nodes: z.array(flowNode),
    edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.enum(['triggers', 'emits', 'consumes', 'uses']), title: z.string() })),
    width: z.number(), height: z.number(), partialObservation: z.boolean(), declaredComplete: z.boolean(),
  }),
  operations: z.object({
    rows: z.array(z.object({ operation: z.string(), events: z.number().nullable(), lastSeen: z.string().nullable(),
      refusals: z.number().nullable(), refusedOnly: z.boolean() })),
    observedComplete: z.boolean(),
    refusals: z.object({ complete: z.boolean(), held: z.number(), counted: z.number(), since: z.string().nullable() }).nullable(),
  }),
  connectionSweep: z.object({
    rows: z.array(z.object({ connectionId: z.string(), provider: z.string(), label: z.string(), status: z.string(),
      lastSweptAt: z.string().nullable(), lastOutcomeFailed: z.boolean().nullable(), unknown: z.boolean(), idle: z.boolean() })),
    windowDays: z.number(), idleCount: z.number(),
  }),
});
const coverageField = z.object({ field: z.string(), returned: z.boolean(), erasable: z.boolean() });
const fieldCoverageView = z.object({
  available: z.boolean(), entities: z.array(z.object({ entity: z.string(), table: z.string(),
    fields: z.array(coverageField), neverReturned: z.array(coverageField) })),
  declared: z.number(), returned: z.number(), neverReturnedErasable: z.number(), operations: z.number(),
});
export const fieldReadsView = z.object({
  available: z.boolean(), source: z.string(),
  window: z.object({ since: z.string(), until: z.string() }).optional(),
  groups: z.array(z.object({
    sampleRate: z.number().nullable(), armedRequests: z.number(), refused: z.number(),
    operations: z.array(z.object({ operation: z.string(), responses: z.number(), fields: z.array(z.object({
      field: z.string(), present: z.number(), empty: z.number(), absent: z.number(), eligible: z.number(),
      sampleRate: z.number().nullable(), window: z.object({ since: z.string(), until: z.string() }),
    })) })),
    notObservedReturned: z.array(z.object({ operation: z.string(), field: z.string() })),
  })),
});
const appFailuresView = z.object({
  entries: z.array(z.object({ id: z.string(), at: z.string(), kind: z.enum(['sweep', 'operation']), operation: z.string(),
    stage: z.string().nullable(), message: z.string().nullable(), code: z.string().nullable() })),
  unavailableSources: z.array(z.string()), incompleteSources: z.array(z.string()),
});
const appOverlaysView = z.object({
  unavailableSources: z.array(z.string()).optional(), incompleteSources: z.array(z.string()).optional(),
  markers: z.array(z.object({ at: z.string(), kind: z.enum(['migration', 'run-failed', 'failure']), label: z.string(), detail: z.string().nullable() })),
  spans: z.array(z.object({ from: z.string(), to: z.string(), kind: z.literal('stale'), label: z.string() })),
  truncated: z.boolean(),
});

/** Read-only observability responses. Plane-owned labels stay strings across deploy skew. */
const observabilityRow = z.object({
  vertical: z.string(), version: z.string(), versionId: z.string().nullable(), service: z.string(),
  requests: z.number(), errors: z.number(), subrequests: z.number(), cpuTimeP50: z.number(), cpuTimeP99: z.number(),
});
const observabilityLogEvent = z.object({
  timestamp: z.number().nullable(), level: z.string().nullable(), message: z.string().nullable(),
  service: z.string().nullable(), outcome: z.string().nullable(), trigger: z.string().nullable(),
  invocation: z.string().nullable(), entrypoint: z.string().nullable(), requestId: z.string().nullable(),
  invocationId: z.string().nullable().optional(), cpuTimeMs: z.number().nullable(), wallTimeMs: z.number().nullable(),
  raw: z.unknown().optional(),
});
const tenantMetricsRow = z.object({
  scopeId: z.string(), vertical: z.string().nullable(), surface: z.string().nullable(),
  requests: z.number(), errors: z.number(), durationP50: z.number(), durationP95: z.number(),
});
const tenantMetricsBucket = z.object({
  scopeId: z.string(), start: z.string(), bucketMinutes: z.number(), requests: z.number(), errors: z.number(),
  class2xx: z.number().optional(), class3xx: z.number().optional(), class4xx: z.number().optional(),
  durationP50: z.number(), durationP95: z.number().optional(),
});
const connectorCallsView = z.object({
  available: z.boolean(),
  buckets: z.array(z.object({
    provider: z.string(), start: z.string(), bucketMinutes: z.number(), calls: z.number(), errors: z.number(),
    ok: z.number(), class4xx: z.number(), class5xx: z.number(), timeouts: z.number(), failed: z.number(),
    durationP50: z.number(), durationP95: z.number(),
  })),
});
const businessVolumesView = z.object({
  window: z.object({ since: z.string(), until: z.string() }), bucketMinutes: z.number(),
  rows: z.array(z.object({
    scopeId: z.string(), entityType: z.string(), state: z.string(), terminal: z.boolean(), fromInitial: z.boolean(),
    operations: z.array(z.string()), today: z.number(), yesterday: z.number(),
    buckets: z.array(z.object({ start: z.string(), count: z.number() })),
  })),
  apps: z.array(z.object({ scopeId: z.string(), unavailable: z.enum(['no-version', 'no-moves', 'not-yet-available']).nullable() })),
});
const teamTrafficSeries = z.object({
  window: z.object({ since: z.string(), until: z.string() }).optional(),
  series: z.array(z.object({ scopeId: z.string(), buckets: z.array(trafficBucket) })),
  bucketMinutes: z.number(), available: z.boolean(),
});
const appMetricsView = z.object({
  available: z.boolean(), cap: z.number().nullable(),
  rows: z.array(z.object({ scopeId: z.string(), requests: z.number().nullable(), errors: z.number().nullable(), p95: z.number().nullable() })),
});
const requestVolumeView = z.object({
  bucketMs: z.number(),
  buckets: z.array(z.object({ start: z.string(), info: z.number(), warn: z.number(), error: z.number(), unrecorded: z.number() })),
  estimated: z.boolean(),
});
const requestFacetsView = z.object({
  total: z.number(), facets: z.record(z.string(), z.array(z.object({ value: z.union([z.string(), z.number()]), count: z.number() }))),
  estimated: z.boolean(),
});
const requestRecordView = z.object({
  timestamp: z.number().nullable(), invocationId: z.string().nullable(), scopeId: z.string().nullable(),
  vertical: z.string().nullable(), surface: z.string().nullable(), method: z.string().nullable(),
  path: z.string().nullable(), status: z.number().nullable(), threw: z.boolean(), durationMs: z.number().nullable(),
  level: z.string().nullable(), operation: z.string().nullable(), problemCode: z.string().nullable(),
  principalKind: z.string().nullable(), eventCount: z.number().nullable(),
  // #2762: optional, so a source that predates it reads as not recorded.
  logLines: z.number().nullable().optional(), eventTypes: z.array(z.string()),
  entities: z.array(z.string()), versionId: z.string().nullable(), kind: z.string().optional(),
  outcome: z.string().nullable().optional(), eventType: z.string().nullable().optional(),
  eventId: z.string().nullable().optional(), attempt: z.number().nullable().optional(),
  latenessMs: z.number().nullable().optional(),
  outboundCalls: z.array(z.object({
    host: z.string(), path: z.string(), method: z.string(), status: z.number().nullable(),
    outcome: z.string(), durationMs: z.number(), atMs: z.number(), reason: z.string().optional(),
  })).optional(),
  outboundCallsDropped: z.number().optional(),
});
/** A filter the query carries once per selected value (`?level=warn&level=error`). */
const repeated = z.array(z.string()).optional();
const appRequestInput = z.object({
  scopeId: z.string().min(1), hours: z.string().optional(), since: z.string().optional(), until: z.string().optional(),
  level: repeated, operation: repeated, principalKind: repeated, problemCode: repeated, surface: repeated, status: repeated,
  kind: repeated, entity: repeated, path: repeated, buckets: z.string().optional(), facet: z.string().optional(), limit: z.string().optional(),
  search: z.string().optional(),
});
const logPatternsView = z.object({
  total: z.number(), bucketMs: z.number(),
  patterns: z.array(z.object({
    template: z.string(), count: z.number(), share: z.number(),
    levels: z.object({ debug: z.number(), info: z.number(), warn: z.number(), error: z.number() }),
    dominant: z.string(), buckets: z.array(z.object({ start: z.string(), count: z.number() })),
  })),
  truncated: z.boolean(), estimated: z.boolean(),
});

/** One install still bound to a vertical (#1592). */
export const boundScopeRow = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  status: z.string(),
  /** A preview or snapshot fork: retiring deletes it, and it is never moved. */
  fork: z.boolean(),
  movable: z.boolean(),
  verticalVersionId: z.string().nullable(),
  createdAt: z.string(),
  /** Names that go offline first when this scope is retired. */
  hostnames: z.array(z.string()),
});

/** What one install's Move would apply (#2347), and the binding its acknowledgement carries. */
export const moveReviewRow = z.object({
  scopeId: z.string(),
  slug: z.string(),
  base: z.object({ vertical: z.string(), versionId: z.string() }).nullable(),
  target: z.object({ vertical: z.string(), versionId: z.string() }),
  digestsMatch: z.boolean(),
  migrations: orNull(migrationDiff, 'moveReview.migrations'),
  /** The SQL is shown only to an owner of both verticals; the digests and the binding still are. */
  migrationsWithheld: z.boolean(),
  review: reviewBindingOut,
});

/** One builder preview of a vertical (#509): a scope with data bound to a version, at its own `--<tag>` URL. */
export const previewRow = z.object({
  scopeId: z.string(),
  tag: z.string().nullable(),
  versionId: z.string().nullable(),
  forkedFrom: z.string().nullable(),
  expiresAt: z.string().nullable(),
  hostname: z.string().nullable(),
  url: z.string().nullable(),
  /** What an external issuer would need registered (#1704). */
  callbackUrl: z.string().nullish(),
});

/** The result of creating a preview, or of re-using one by tag (`reused`). */
export const previewCreated = z.object({
  scopeId: z.string(),
  hostname: z.string(),
  url: z.string(),
  versionId: z.string(),
  reused: z.boolean(),
  auth: previewAuthOut.optional(),
  notes: z.array(z.string()).optional(),
});

/** A hostname bound to a preview's scope: where issuance stands and what to publish. */
export const previewDomainRow = z.object({
  hostname: z.string(),
  scopeId: z.string(),
  surface: z.string(),
  status: z.string(),
  statusNote: z.string().nullish(),
  canonical: z.boolean(),
  createdAt: z.string(),
  /** The Cloudflare-for-SaaS handle of a custom domain; null for a platform mint. */
  customHostnameId: z.string().nullish(),
  // `status` is `null` before a poll, and the contract's record defaults it, so its key may be absent.
  validationRecords: z.array(z.object({ type: z.string(), name: z.string(), value: z.string(), status: z.string().nullish() })).optional(),
});

const appReleaseSide = z.object({
  versionId: z.string(), version: z.string().nullable(), requests: z.number().nullable(),
  errors: z.number().nullable(), cpuTimeP50: z.number().nullable(), cpuTimeP99: z.number().nullable(),
});

/**
 * A document the control plane keeps for a version and this worker only carries: a permission
 * registry, an emitted model, a lifecycle and its replayed counts, a version's static files. The
 * plane parsed it when the version was pushed; parsing it again with this worker's contracts would
 * turn version skew between the two into an empty tab, and stripping would drop what a newer plane
 * says. So it goes out as the plane answered it, and the client states its type.
 */
const planeDocument = z.unknown();

/** The per-app Deployments tab: one page of versions, plus what THIS scope runs and whether the team pushed it. */
export const appDeploymentsView = deploymentRow.extend({
  owned: z.boolean(),
  boundVersionId: z.string().nullable(),
  nextCursor: z.string().nullable(),
});

/** The running version and an available update's, each with one document the plane holds for it. */
const versionPairOf = <K extends string>(key: K) => {
  const side = z.object({ versionId: z.string().nullable(), version: z.string().nullable(), [key]: planeDocument });
  return z.object({ running: side, update: side.nullable() });
};

/** A schedule's or a freshness unit's recent sweep rows, which the plane writes and nothing here parses. */
const sweepRunView = z.looseObject({
  id: z.string(), outcome: z.string(), at: z.string(), error: z.string().nullish(),
  elapsedMs: z.number().nullish(), observedAt: z.string().nullish(),
});

/** Schedule and freshness health (`schedules.ts`): the verdicts are this worker's own. */
const appSchedulesView = z.object({
  running: z.object({ versionId: z.string().nullable(), version: z.string().nullable() }),
  schedules: z.array(z.object({
    operation: z.string(), moduleId: z.string(), everyMinutes: z.number(), permissions: z.array(z.string()),
    lastRun: sweepRunView.nullable(), nextDueAt: z.string().nullable(),
    health: z.enum(['healthy', 'overdue', 'never-run', 'sweeper-silent']), runs: z.array(sweepRunView),
  })).nullable(),
  freshness: z.array(z.object({
    eventType: z.string(), moduleId: z.string(), withinHours: z.number(), observedAt: z.string().nullable(),
    health: z.enum(['fresh', 'stale', 'never-seen', 'sweeper-silent']), runs: z.array(sweepRunView),
  })).nullable(),
  lastSweepAt: z.string().nullable(),
});

/** The process map (`process-map.ts`): a declared lifecycle replayed over a period and the one before. */
const processMapView = z.object({
  versionId: z.string().nullable(),
  processes: z.array(z.object({ entity: z.string(), initial: z.string(), states: z.number(), edges: z.number() })),
  entity: z.string().nullable(),
  lifecycle: planeDocument,
  period: z.enum(['24h', '7d', '30d']),
  current: planeDocument,
  previous: planeDocument,
  unavailable: z.enum(['no-version', 'no-lifecycles', 'not-yet-available']).nullable(),
});

// These vocabularies are written by the deployed app's kernel, which may be newer
// than this dashboard. Preserve its value for the person reading the record.
const historyEntryOut = historyEntry.extend({ piiClass: z.string() });
const eventDeliveryOut = eventDelivery.extend({ state: z.string() });
// Plane-owned status tokens may change independently of this dashboard. Accept
// JSON scalars only; the view treats anything except known-good values as limited.
const planeScalar = z.union([z.string(), z.number(), z.boolean()]).nullable().optional();
export const meteredUsageOut = z.object({
  readAt: z.string(),
  retention: z.object({ storageMonths: z.number().int(), modelDays: z.number().int(), requestMonths: z.number().int().nullable() }),
  storage: z.object({
    // Plane-owned vocabulary: currently unavailable/empty/not-sampled/complete/partial/stale/failing/truncated.
    state: planeScalar,
    bytes: z.number().int().nullable(), estimated: planeScalar, basis: planeScalar,
    lowerBound: planeScalar, truncatedReason: planeScalar,
    sampled: z.number().int(), total: z.number().int(), failing: z.number().int(),
    oldestReadAt: z.string().nullable(), excluded: z.array(planeScalar),
  }),
  requests: z.object({
    // Plane-owned coverage and estimate status; currently unavailable/empty/complete/partial/truncated.
    state: planeScalar,
    requests: z.number().int().nullable(), estimated: planeScalar, lowerBound: planeScalar, truncatedReason: planeScalar,
    coveredDays: z.number().int(), totalDays: z.number().int(), sinceDay: z.string(), untilDay: z.string(),
    lastReadAt: z.string().nullable(),
    byVertical: z.array(z.object({ vertical: z.string().nullable(), requests: z.number().int() })),
    breakdownTruncated: z.boolean(),
  }),
  models: z.object({
    // Plane-owned coverage; currently unavailable/empty/complete/truncated.
    state: planeScalar,
    calls: z.number().int().nullable(), reportedCalls: z.number().int(), inputTokens: z.number().int().nullable(), outputTokens: z.number().int().nullable(),
    estimated: planeScalar, lowerBound: planeScalar, since: z.string(), until: z.string(),
    truncatedReason: planeScalar,
    oldestRecordedAt: z.string().nullable(), newestRecordedAt: z.string().nullable(),
    byVerticalModel: z.array(z.object({ vertical: z.string(), model: z.string(), calls: z.number().int(), reportedCalls: z.number().int(), inputTokens: z.number().int().nullable(), outputTokens: z.number().int().nullable() })),
    breakdownTruncated: z.boolean(),
  }),
});
export type MeteredUsageOut = z.infer<typeof meteredUsageOut>;
interface EventEffectsOut {
  event: z.infer<typeof historyEntryOut>;
  deliveries: z.infer<typeof eventDeliveryOut>[];
  effects: EventEffectsOut[];
}
export const eventEffects: z.ZodType<EventEffectsOut> = z.object({
  event: historyEntryOut, deliveries: z.array(eventDeliveryOut), effects: z.array(z.lazy(() => eventEffects)),
});
const effectsTree = z.object({ root: eventEffects.nullable(), terminal: z.string(), count: z.number() });

export const dashboardRoutes = defineRoutes({
  'dashboard/list-entitlements': {
    summary: "Read this team's entitlement grants (owner or admin)",
    output: z.array(z.object({
      key: z.string().min(1),
      quota: z.number().int().positive().optional(),
      expiresAt: z.string().optional(),
    })),
    http: { method: 'GET', path: '/entitlements' },
  },
  'dashboard/read-metered-usage': {
    summary: "Read this team's persisted metered usage without prices (owner or admin)",
    output: meteredUsageOut,
    http: { method: 'GET', path: '/metered-usage' },
  },
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
  'dashboard/get-app-concept': {
    summary: 'Read the running application description: omit section to list sections, then pass a section id and versionId to read it. Follow nextOffset for more text. Describes intended behavior, not live permissions or data.',
    input: z.object({
      scopeId: z.string().min(1),
      section: z.string().min(1).max(64).optional(),
      versionId: z.string().min(1).max(128).optional(),
      offset: z.coerce.number().int().min(0).max(65536).optional(),
    }),
    output: z.object({
      versionId: z.string().nullable(),
      sections: z.array(z.object({ id: z.string(), title: z.string() })),
      section: z.object({ id: z.string(), title: z.string(), paragraphs: z.array(z.string()) }).nullable(),
      nextOffset: z.number().nullable(),
      unavailable: z.enum(['no-version', 'not-published']).nullable(),
    }),
    http: { method: 'GET', path: '/apps/{scopeId}/concept' },
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
    output: pageOutput(adminLogRow),
    http: { method: 'GET', path: '/apps/{scopeId}/audit' },
  },
  'dashboard/get-app-flow': {
    summary: "The app's declared and observed flow",
    input: z.object({ scopeId: z.string().min(1) }),
    output: appFlowView,
    http: { method: 'GET', path: '/apps/{scopeId}/flow' },
  },
  'dashboard/get-app-field-coverage': {
    summary: "Fields declared by the app's running version and returnable by its operations",
    input: z.object({ scopeId: z.string().min(1) }),
    output: fieldCoverageView,
    http: { method: 'GET', path: '/apps/{scopeId}/field-coverage' },
  },
  'dashboard/get-app-field-reads': {
    summary: "Observed field presence in one app's responses",
    input: z.object({ scopeId: z.string().min(1), hours: z.string().optional() }),
    output: fieldReadsView,
    http: { method: 'GET', path: '/apps/{scopeId}/field-reads' },
  },
  'dashboard/get-app-traffic': {
    summary: "One installed app's traffic series and release markers",
    input: z.object({ scopeId: z.string().min(1), hours: z.string().optional(), since: z.string().optional(), until: z.string().optional() }),
    output: trafficSeries,
    http: { method: 'GET', path: '/apps/{scopeId}/traffic' },
  },
  'dashboard/get-app-failures': {
    summary: "Recent failures of one installed app",
    input: z.object({ scopeId: z.string().min(1), since: z.string().optional(), until: z.string().optional() }),
    output: appFailuresView,
    http: { method: 'GET', path: '/apps/{scopeId}/failures' },
  },
  'dashboard/get-app-overlays': {
    summary: "Migration, failure and stale markers over one app's traffic",
    input: z.object({ scopeId: z.string().min(1), hours: z.string().optional(), since: z.string().optional(), until: z.string().optional() }),
    output: appOverlaysView,
    http: { method: 'GET', path: '/apps/{scopeId}/overlays' },
  },
  // -- app Data browser: deployed scope data, kept outside the assistant ------
  'dashboard/list-app-tables': {
    summary: "The tables in one of this team's app scopes",
    input: z.object({ scopeId: z.string().min(1) }),
    output: z.array(scopeTable),
    http: { method: 'GET', path: '/apps/{scopeId}/tables' },
  },
  'dashboard/read-app-table': {
    summary: "A bounded page of one of this app scope's tables",
    input: z.object({ scopeId: z.string().min(1), table: z.string().min(1), limit: z.coerce.number().int().positive().optional(), offset: z.coerce.number().int().nonnegative().optional() }),
    output: scopeTablePage,
    http: { method: 'GET', path: '/apps/{scopeId}/tables/{table}' },
  },
  'dashboard/facet-app-events': {
    summary: "Counts of one app scope's events by a selected dimension",
    input: z.object({ scopeId: z.string().min(1), groupBy: z.string().optional(), field: z.string().optional(), type: z.string().optional(), since: z.string().optional(), until: z.string().optional(), limit: z.coerce.number().optional() }),
    output: eventFacetResult.extend({ withheldReason: z.string().optional() }),
    http: { method: 'GET', path: '/apps/{scopeId}/facets' },
  },
  'dashboard/read-app-history': {
    summary: "One record's event history in this app scope",
    input: z.object({ scopeId: z.string().min(1), entityType: z.string(), entityId: z.string(), limit: z.coerce.number().optional(), cursor: z.string().optional() }),
    output: pageOutput(historyEntryOut),
    http: { method: 'GET', path: '/apps/{scopeId}/history' },
  },
  'dashboard/read-app-cause': {
    summary: "The causal chain leading to an event in this app scope",
    input: z.object({ scopeId: z.string().min(1), eventId: z.string(), maxDepth: z.coerce.number().optional() }),
    output: causeChain.extend({ chain: z.array(historyEntryOut), terminal: z.string() }),
    http: { method: 'GET', path: '/apps/{scopeId}/cause' },
  },
  'dashboard/read-app-effects': {
    summary: "The event tree caused by one event in this app scope",
    input: z.object({ scopeId: z.string().min(1), eventId: z.string(), maxNodes: z.coerce.number().optional() }),
    output: effectsTree,
    http: { method: 'GET', path: '/apps/{scopeId}/effects' },
  },
  'dashboard/read-app-invocation': {
    summary: "The events emitted by one invocation in this app scope",
    input: z.object({ scopeId: z.string().min(1), invocationId: z.string(), limit: z.coerce.number().optional() }),
    output: z.object({ events: z.array(historyEntryOut), truncated: z.boolean() }),
    http: { method: 'GET', path: '/apps/{scopeId}/invocation' },
  },
  'dashboard/list-app-denials': {
    summary: "One page of permission refusals in this app scope",
    input: z.object({ scopeId: z.string().min(1), until: z.string().optional(), limit: z.coerce.number().optional() }),
    output: z.object({ entries: z.array(permissionDenial), limit: z.number() }),
    http: { method: 'GET', path: '/apps/{scopeId}/denials' },
  },
  'dashboard/list-app-dead-letters': {
    summary: "One page of dead-lettered deliveries in this app scope",
    input: z.object({ scopeId: z.string().min(1), limit: z.coerce.number().optional(), cursor: z.string().optional() }),
    output: pageOutput(deadLetter),
    http: { method: 'GET', path: '/apps/{scopeId}/dead-letters' },
  },
  'dashboard/query-app-scope': {
    summary: "Run one read-only SQL statement against this app scope",
    input: z.object({ scopeId: z.string().min(1), sql: z.string().min(1).max(10_000) }),
    output: scopeQueryResult,
    http: { method: 'POST', path: '/apps/{scopeId}/query' },
  },
  'dashboard/list-team-audit': {
    summary: "One page of this team's whole admin log, or one app's with `scopeId`, newest first",
    // An empty `scopeId` is no narrowing — the whole log, as the cookie route reads it.
    input: z.object({ scopeId: z.string().optional(), ...pageInput }),
    output: pageOutput(adminLogRow),
    http: { method: 'GET', path: '/audit' },
  },
  'dashboard/fleet-health': {
    summary: "Every app of this team with its health verdict, worst first",
    output: z.object({ rows: z.array(z.object({
      scopeId: z.string(), name: z.string(), vertical: z.string(),
      // Derived here (`fleet-health.ts`), from the reads below, never relayed from the plane.
      state: z.enum(['failing', 'stale', 'silent', 'unknown', 'ok']),
      reason: z.string(), failures: z.number(), sweepFailures: z.number(), stale: z.number(),
      lastSweepAt: z.string().nullable(),
    })) }),
    http: { method: 'GET', path: '/fleet-health' },
  },
  'dashboard/identity-mirror': {
    summary: "Whether this team's identity links in the dashboard and the shared directory agree",
    output: z.object({
      tenant: z.string(), inSync: z.boolean(),
      counts: z.object({ local: z.number(), shared: z.number(), missing: z.number(), extra: z.number(), conflicting: z.number() }),
      missing: z.array(mirroredIdentityLink), extra: z.array(mirroredIdentityLink),
      conflicting: z.array(z.object({ local: mirroredIdentityLink, shared: mirroredIdentityLink })),
    }),
    http: { method: 'GET', path: '/identity-mirror' },
  },

  // -- app peer access and cross-vertical edges (#2170) ----------------------
  // Each write checks `dashboard:provision-app` in the path team's dashboard scope.
  'dashboard/app-peers': {
    summary: "What this app calls and which of this team's apps may call it",
    input: z.object({ scopeId: z.string().min(1) }),
    output: z.object({
      declares: z.array(z.string()).nullable(), calls: z.array(declaredPeerCall),
      bindingChoices: z.array(z.object({
        vertical: z.string(), boundScopeId: z.string().nullable(), invalidated: z.boolean(),
        candidates: z.array(z.object({ scopeId: z.string(), name: z.string() })),
      })),
      callers: z.array(peerGrantsStatusEntry.extend({ calls: z.string() })).nullable(), callersError: z.string().nullable(),
    }),
    http: { method: 'GET', path: '/apps/{scopeId}/peers' },
  },
  'dashboard/switch-app-peer': {
    summary: "Switch one peer's access to this app on or off",
    input: z.object({ scopeId: z.string().min(1), vertical: z.string().min(1), to: z.enum(['on', 'off']), reason: z.string().trim().min(1).max(500) }),
    output: peerSwitchResult.extend({ calls: z.string() }),
    http: { method: 'POST', path: '/apps/{scopeId}/peers/switch' },
  },
  'dashboard/set-app-peer-binding': {
    summary: 'Choose or clear the instance this app calls for one peer vertical',
    input: z.object({ scopeId: z.string().min(1), vertical: z.string().min(1), targetScopeId: z.string().nullable() }).strict(),
    output: z.object({ changed: z.boolean(), previous: z.string().nullable(), operationId: z.string(), auditWarning: z.string().optional() }),
    http: { method: 'PUT', path: '/apps/{scopeId}/peers/binding' },
  },
  'dashboard/app-edges': {
    summary: "The event edges into and out of this app",
    input: z.object({ scopeId: z.string().min(1) }),
    output: edgeHealthReport.extend({ edges: z.array(edgeHealthOut) }),
    http: { method: 'GET', path: '/apps/{scopeId}/edges' },
  },
  'dashboard/move-app-edge': {
    summary: "Replay or skip one event edge into this app",
    // The handler applies `importCursorMove` after the acknowledgement's fixed refusal sentence.
    input: z.object({
      scopeId: z.string().min(1), mode: z.enum(['replay', 'skip']), from: z.string().min(1),
      after: z.string().nullable().optional(), through: z.string().optional(),
      acknowledge: z.string().optional(), reason: z.string().trim().min(1).max(500),
    }),
    output: importCursorMoved.extend({ mode: z.string() }),
    http: { method: 'POST', path: '/apps/{scopeId}/edges/move' },
  },
  'dashboard/app-scopes': {
    summary: "The browsable scopes of this app's vertical",
    input: z.object({ scopeId: z.string().min(1) }),
    output: z.array(z.object({ scopeId: z.string(), name: z.string(), status: z.string(), isDefault: z.boolean() })),
    http: { method: 'GET', path: '/apps/{scopeId}/scopes' },
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

  // -- app version and data lifecycle (#2170) -------------------------------
  'dashboard/update-installed-app': {
    summary: 'Move this app to the current prod version of its vertical',
    input: z.object({ scopeId: z.string().min(1), snapshot: z.boolean().optional(), acknowledge: bindAcknowledgement.optional() }),
    output: z.object({ updated: z.boolean(), version: z.string().nullable(), previousVersion: z.string().nullable() }),
    http: { method: 'POST', path: '/apps/{scopeId}/update' },
  },
  'dashboard/bind-installed-app': {
    summary: 'Pin this app to a specific admitted vertical version',
    input: z.object({ scopeId: z.string().min(1), versionId: z.string().min(1), snapshot: z.boolean().optional(), acknowledge: bindAcknowledgement.optional() }),
    output: z.object({ bound: z.literal(true) }),
    http: { method: 'POST', path: '/apps/{scopeId}/bind' },
  },
  'dashboard/list-app-bookmarks': {
    summary: 'The pre-migration rewind points for this app',
    input: z.object({ scopeId: z.string().min(1) }),
    output: z.array(z.object({ bookmark: z.string(), takenAt: z.string(), pending: z.array(z.string()) })),
    http: { method: 'GET', path: '/apps/{scopeId}/bookmarks' },
  },
  'dashboard/list-app-migrations': {
    summary: 'The schema migrations this app has applied',
    input: z.object({ scopeId: z.string().min(1) }),
    output: z.object({ available: z.boolean(), migrations: z.array(z.object({
      moduleId: z.string(), version: z.string(), appliedAt: z.string().nullable(),
      durationMs: z.number().nullable(), rowsChanged: z.number().nullable(),
    })) }),
    http: { method: 'GET', path: '/apps/{scopeId}/migrations' },
  },
  'dashboard/get-app-release-comparison': {
    summary: 'Compare this app’s running version with the current prod version',
    input: z.object({ scopeId: z.string().min(1) }),
    output: z.object({
      running: appReleaseSide.nullable(),
      update: appReleaseSide.nullable(),
      metricsAvailable: z.boolean(), owned: z.boolean(),
    }),
    http: { method: 'GET', path: '/apps/{scopeId}/release-comparison' },
  },
  // -- app version reads: what the app runs, and what it declares ----------
  'dashboard/get-app-deployments': {
    summary: "One page of this app's vertical versions, its channels, and the version the app runs",
    input: z.object({ scopeId: z.string().min(1), ...pageInput }),
    output: appDeploymentsView,
    http: { method: 'GET', path: '/apps/{scopeId}/deployments' },
  },
  'dashboard/get-app-version-assets': {
    summary: 'The static files one version of this app ships',
    input: z.object({ scopeId: z.string().min(1), versionId: z.string().min(1) }),
    output: z.object({ assets: planeDocument }),
    http: { method: 'GET', path: '/apps/{scopeId}/deployments/{versionId}/assets' },
  },
  'dashboard/get-app-permissions': {
    summary: 'The permission surface of the version this app runs, and of an available update',
    input: z.object({ scopeId: z.string().min(1) }),
    output: versionPairOf('registry'),
    http: { method: 'GET', path: '/apps/{scopeId}/permissions' },
  },
  'dashboard/get-app-model': {
    summary: 'The entity model of the version this app scope runs, and of an available update',
    input: z.object({ scopeId: z.string().min(1) }),
    output: versionPairOf('model'),
    http: { method: 'GET', path: '/apps/{scopeId}/model' },
  },
  'dashboard/get-app-process-map': {
    summary: "One app's process map: a declared lifecycle replayed over a period and the one before",
    // `period` is judged by the handler, which answers an unknown one with the 400 it always has.
    input: z.object({ scopeId: z.string().min(1), period: z.string().optional(), entity: z.string().optional() }),
    output: processMapView,
    http: { method: 'GET', path: '/apps/{scopeId}/processes' },
  },
  'dashboard/get-app-schedules': {
    summary: 'Schedule and freshness health for the version this app runs',
    input: z.object({ scopeId: z.string().min(1) }),
    output: appSchedulesView,
    http: { method: 'GET', path: '/apps/{scopeId}/schedules' },
  },
  'dashboard/rewind-app': {
    summary: 'Rewind this app to a pre-migration bookmark',
    input: z.object({ scopeId: z.string().min(1), bookmark: z.string().min(1) }),
    output: z.object({ rewindingTo: z.string() }),
    http: { method: 'POST', path: '/apps/{scopeId}/rewind' },
  },
  'dashboard/export-installed-app': {
    summary: 'Export this app’s data as a dump',
    input: z.object({ scopeId: z.string().min(1) }),
    output: scopeDump.extend({ masked: z.boolean() }),
    http: { method: 'GET', path: '/apps/{scopeId}/export' },
  },
  'dashboard/restore-installed-app': {
    summary: 'Replace this app’s data from an uploaded dump after making a safety copy',
    input: scopeDump.pick({ tables: true, stores: true }).extend({
      scopeId: z.string().min(1), tables: scopeDump.shape.tables.min(1), sourceScopeId: z.unknown().optional(),
    }),
    output: z.object({ restored: z.string(), tables: z.number().int(), safetyCopyId: z.string() }),
    http: { method: 'POST', path: '/apps/{scopeId}/restore' },
  },

  // -- app owner, members and identity (#2170) -------------------------------
  'dashboard/app-owner-seat': {
    summary: "The owner seat of one of this team's app scopes",
    input: z.object({ scopeId: z.string().min(1) }),
    output: ownerSeat.extend({ state: z.string() }),
    http: { method: 'GET', path: '/apps/{scopeId}/owner-seat' },
  },
  'dashboard/app-owner-claim': {
    summary: "Mint a one-time claim link for an unclaimed app owner seat",
    input: z.object({ scopeId: z.string().min(1) }),
    output: ownerClaimLink,
    http: { method: 'POST', path: '/apps/{scopeId}/owner-claim' },
    status: 201,
  },
  'dashboard/app-members': {
    summary: "The members, roles and open invites in one app scope",
    input: z.object({ scopeId: z.string().min(1) }),
    output: scopeMembers.extend({ invites: z.array(scopeMemberInvite.extend({
      link: z.object({ state: z.string(), reason: z.string().nullable() }).nullable().optional(),
    })) }),
    http: { method: 'GET', path: '/apps/{scopeId}/members' },
  },
  'dashboard/app-invite-member': {
    summary: "Invite a person into an app as the signed-in caller",
    input: z.object({ scopeId: z.string().min(1), ...memberInviteInput.shape }).strict(),
    output: memberInviteLink.extend({ operationId: z.string().optional(), auditWarning: z.string().optional() }),
    http: { method: 'POST', path: '/apps/{scopeId}/members' },
    status: 201,
  },
  'dashboard/app-change-member-role': {
    summary: "Change an app member's role as the signed-in caller",
    input: z.object({ scopeId: z.string().min(1), principal: z.string(), ...memberRoleInput.shape }).strict(),
    output: z.object({ principal: z.string(), from: z.string(), to: z.string(), operationId: z.string().optional(), auditWarning: z.string().optional() }),
    http: { method: 'POST', path: '/apps/{scopeId}/members/{principal}/role' },
  },
  'dashboard/app-remove-member': {
    summary: 'Remove an app member as the signed-in caller',
    input: z.object({ scopeId: z.string().min(1), principal: z.string() }),
    output: memberRemoval.extend({ operationId: z.string().optional(), auditWarning: z.string().optional() }),
    http: { method: 'POST', path: '/apps/{scopeId}/members/{principal}/remove' },
  },
  'dashboard/get-app-auth': {
    summary: "One app's stored identity choice with its write-only secret redacted and its callback URL",
    input: z.object({ scopeId: z.string().min(1) }),
    output: z.object({ auth: z.object({
      mode: z.literal('oidc'), issuer: z.string(), clientId: z.string(), audience: z.string().nullable(),
      hasClientSecret: z.boolean(), updatedAt: z.string(),
    }).nullable(), callbackUrl: z.string().nullable() }),
    http: { method: 'GET', path: '/apps/{scopeId}/auth' },
  },
  'dashboard/set-app-auth': {
    summary: "Save one app's identity choice and attempt live delivery",
    input: z.object({ scopeId: z.string().min(1), choice: appAuthChoiceBody }),
    output: z.object({ delivered: z.boolean(), note: z.string().optional() }),
    http: { method: 'PUT', path: '/apps/{scopeId}/auth' },
  },

  // -- app previews (#2170) --------------------------------------------------
  'dashboard/list-app-snapshots': {
    summary: "The archive forks of one of this team's apps, newest first",
    input: z.object({ scopeId: z.string().min(1) }),
    output: z.array(z.object({
      id: z.string(), kind: z.string(), forkedFrom: z.string().nullable(),
      forkedAt: z.string().nullable(), expiresAt: z.string().nullable(),
      verticalVersionId: z.string().nullable(), createdAt: z.string(), url: z.string().nullable().optional(),
    })),
    http: { method: 'GET', path: '/apps/{scopeId}/snapshots' },
  },
  'dashboard/create-app-snapshot': {
    summary: "Create an archive fork of this app's data, with optional expiry",
    input: z.object({ scopeId: z.string().min(1), ttlDays: z.number().int().positive().max(365).optional() }),
    output: z.object({ id: z.string(), expiresAt: z.string().nullable(), url: z.string().nullable() }),
    http: { method: 'POST', path: '/apps/{scopeId}/snapshots' },
    status: 201,
  },
  'dashboard/delete-app-snapshot': {
    summary: 'Delete one archive fork belonging to this app',
    input: z.object({ scopeId: z.string().min(1), snapshotId: z.string().min(1) }),
    output: z.object({ deleted: z.string() }),
    http: { method: 'DELETE', path: '/apps/{scopeId}/snapshots/{snapshotId}' },
  },

  // -- app environment (#2170) ----------------------------------------------
  'dashboard/get-app-env': {
    summary: "One app's declared environment and its stored values; secrets are write-only",
    input: z.object({ scopeId: z.string().min(1) }),
    output: z.object({
      spec: z.array(envSpecRow),
      values: z.array(z.object({
        key: z.string(),
        isSecret: z.boolean(),
        hasValue: z.boolean(),
        value: z.string().nullable(),
        updatedAt: z.string(),
      })),
      modelCatalog: z.array(z.object({
        id: z.string(), label: z.string(), status: z.enum(['active', 'deprecated']),
        servedBy: z.string(), tiers: z.array(z.object({
          upToInputTokens: z.number().int().nullable(),
          inputPer1M: z.string(), outputPer1M: z.string(),
          cacheReadPer1M: z.string().nullable(), cacheWritePer1M: z.string().nullable(),
        })),
      })),
    }),
    http: { method: 'GET', path: '/apps/{scopeId}/env' },
  },
  'dashboard/set-app-env': {
    summary: "Save one app's environment and try to deliver it to the running app",
    input: z.object({
      scopeId: z.string().min(1),
      entries: z.array(z.object({ key: z.string(), value: z.string(), secret: z.boolean().optional() })).optional(),
    }),
    output: z.object({ saved: z.number().int().nonnegative(), delivered: z.boolean(), note: z.string().optional() }),
    http: { method: 'PUT', path: '/apps/{scopeId}/env' },
  },
  'dashboard/delete-app-env': {
    summary: "Remove one stored environment value from this app",
    input: z.object({ scopeId: z.string().min(1), key: z.string().min(1) }),
    output: z.object({ deleted: z.string() }),
    http: { method: 'DELETE', path: '/apps/{scopeId}/env/{key}' },
  },

  // -- app integrations (#2170) ----------------------------------------------
  'dashboard/get-app-integrations': {
    summary: "One app's declared providers and live connection metadata",
    input: z.object({ scopeId: z.string().min(1) }),
    output: z.object({ providers: z.array(integrationProviderForm.extend({
      required: z.boolean(),
      connection: integrationConnection.nullable(), connections: z.array(integrationConnection),
    })) }),
    http: { method: 'GET', path: '/apps/{scopeId}/integrations' },
  },
  'dashboard/list-team-integrations': {
    summary: "Every first-party provider with this team's connections and the team's apps that can connect it",
    output: z.object({ providers: z.array(integrationProviderForm.extend({
      connections: z.array(integrationConnection.extend({
        vertical: z.string(),
        apps: z.array(z.object({ scopeId: z.string(), name: z.string() })),
        sweepRuns: z.array(integrationSweepRun),
      })),
      connectTargets: z.array(z.object({ scopeId: z.string(), name: z.string(), vertical: z.string(), connected: z.boolean() })),
    })) }),
    http: { method: 'GET', path: '/integrations' },
  },
  'dashboard/connect-app-integration': {
    summary: 'Connect or rotate one provider credential for an app',
    input: z.object({
      scopeId: z.string().min(1), provider: z.string().min(1),
      secret: z.record(z.string(), z.string()).optional(), label: z.string().optional(),
    }),
    output: z.object({ connectionId: z.string(), created: z.boolean(), probe: integrationProbeBody.optional() }),
    http: { method: 'POST', path: '/apps/{scopeId}/integrations/{provider}' },
  },
  'dashboard/disconnect-app-integration': {
    summary: 'Revoke the sole live connection for an app provider',
    input: z.object({ scopeId: z.string().min(1), provider: z.string().min(1) }),
    output: z.object({ disconnected: z.string() }),
    http: { method: 'DELETE', path: '/apps/{scopeId}/integrations/{provider}' },
  },
  'dashboard/disconnect-app-connection': {
    summary: 'Revoke one addressed live connection for an app provider',
    input: z.object({ scopeId: z.string().min(1), provider: z.string().min(1), connectionId: z.string().min(1) }),
    output: z.object({ disconnected: z.string() }),
    http: { method: 'DELETE', path: '/apps/{scopeId}/integrations/{provider}/connections/{connectionId}' },
  },
  'dashboard/verify-app-integration': {
    summary: 'Verify the current connection against its provider',
    input: z.object({ scopeId: z.string().min(1), provider: z.string().min(1) }),
    output: integrationProbe,
    http: { method: 'POST', path: '/apps/{scopeId}/integrations/{provider}/verify' },
  },
  'dashboard/verify-app-connection': {
    summary: 'Verify one addressed connection against its provider',
    input: z.object({ scopeId: z.string().min(1), provider: z.string().min(1), connectionId: z.string().min(1) }),
    output: integrationProbe,
    http: { method: 'POST', path: '/apps/{scopeId}/integrations/{provider}/connections/{connectionId}/verify' },
  },
  'dashboard/send-test-app-connection': {
    summary: "Send a test message from one of a mail connection's sender addresses to the signed-in person",
    input: z.object({
      scopeId: z.string().min(1), provider: z.string().min(1), connectionId: z.string().min(1), from: z.string().min(1),
    }),
    output: connectionSendTestResult,
    http: { method: 'POST', path: '/apps/{scopeId}/integrations/{provider}/connections/{connectionId}/send-test' },
  },
  'dashboard/get-app-integration-activity': {
    summary: 'Read the current connection activity and masked credential fields',
    input: z.object({ scopeId: z.string().min(1), provider: z.string().min(1), live: z.string().optional(), source: z.string().optional() }),
    output: integrationActivity,
    http: { method: 'GET', path: '/apps/{scopeId}/integrations/{provider}/activity' },
  },
  'dashboard/get-app-connection-activity': {
    summary: 'Read one addressed connection activity and masked credential fields',
    input: z.object({ scopeId: z.string().min(1), provider: z.string().min(1), connectionId: z.string().min(1), live: z.string().optional(), source: z.string().optional() }),
    output: integrationActivity,
    http: { method: 'GET', path: '/apps/{scopeId}/integrations/{provider}/connections/{connectionId}/activity' },
  },
  'dashboard/mint-app-connect-link': {
    summary: "Mint a single-use consent link for one app's redirect-flow provider",
    input: z.object({
      scopeId: z.string().min(1), provider: z.string().min(1),
      ttlMs: z.number().int().positive().max(CONNECT_LINK_MAX_TTL_MS).optional(),
    }),
    output: appConnectLink.extend({ url: z.string() }),
    http: { method: 'POST', path: '/apps/{scopeId}/integrations/{provider}/connect-links' },
    status: 201,
  },
  'dashboard/list-app-connect-links': {
    summary: "The outstanding connect links for one app and provider: the dashboard's own and those the app mailed",
    input: z.object({ scopeId: z.string().min(1), provider: z.string().min(1) }),
    output: z.object({ links: z.array(appConnectLink.extend({ source: z.enum(['dashboard', 'app']) })) }),
    http: { method: 'GET', path: '/apps/{scopeId}/integrations/{provider}/connect-links' },
  },
  'dashboard/revoke-app-connect-link': {
    summary: 'Revoke one outstanding connect link of an app; its URL stops working',
    input: z.object({ scopeId: z.string().min(1), provider: z.string().min(1), linkId: z.string().min(1) }),
    // A declared route owes an output; the cookie route's empty 204 becomes this 200.
    output: z.object({ revoked: z.string() }),
    http: { method: 'DELETE', path: '/apps/{scopeId}/integrations/{provider}/connect-links/{linkId}' },
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

  // -- members & invites (#2170) ----------------------------------------------
  // Each invokes the dashboard-scope operation the cookie route invoked, as the caller, so the
  // checks are that operation's: the roster read is `dashboard:read`; inviting, re-sending,
  // copying a link and withdrawing need `dashboard:manage-members` plus, where a role is
  // granted, every permission that role carries (§5.1); removing needs manage-members and the
  // removed member's role; the owner cannot be removed.
  'dashboard/list-members': {
    summary: "One page of this team's roster (active members and outstanding invites), newest first",
    input: z.object(pageInput),
    output: pageOutput(memberRow),
    http: { method: 'GET', path: '/members' },
  },
  'dashboard/invite-member': {
    summary: 'Invite someone at a role; emails them and answers the shareable accept link',
    input: z.object({ email: z.string().trim().min(1), roleKey: inviteRole }),
    output: sentInvite,
    http: { method: 'POST', path: '/members/invites' },
    status: 201,
  },
  'dashboard/resend-invite': {
    summary: "Re-send a pending invite's email (a lapsed invitation is renewed); 404 when there is no such pending invite",
    input: z.object({ invitationId: z.string().min(1) }),
    output: sentInvite,
    http: { method: 'POST', path: '/members/invites/{invitationId}/resend' },
  },
  'dashboard/invite-link': {
    summary: "A pending invite's accept link and deadline, to copy; sends no email, and a lapsed invite is a 409",
    input: z.object({ invitationId: z.string().min(1) }),
    output: z.object({ invitationId: z.string(), acceptUrl: z.string(), expiresAt: z.string() }),
    http: { method: 'POST', path: '/members/invites/{invitationId}/link' },
  },
  'dashboard/revoke-invite': {
    summary: 'Withdraw a pending invite',
    input: z.object({ invitationId: z.string().min(1) }),
    // A declared route owes an output; the cookie route's empty 204 becomes this 200.
    output: z.object({ revoked: z.literal(true) }),
    http: { method: 'DELETE', path: '/members/invites/{invitationId}' },
  },
  'dashboard/remove-member': {
    summary: 'Remove a member: their role is taken away and their login leaves the team (409 when the removal is refused)',
    input: z.object({ memberId: z.string().min(1) }),
    // `pending` is the cookie route's 202: the removal is committed and the retry backstop
    // owns taking the role away. One declared status, so it moves into the body. `removed` is
    // false when there was no removable member by that id (already gone, or the owner) — the
    // cookie route's 204 for that no-op said nothing at all.
    output: z.object({ removed: z.boolean(), pending: z.boolean() }),
    http: { method: 'DELETE', path: '/members/{memberId}' },
  },
  'dashboard/leave-team': {
    summary: 'Leave this team: your roster row is revoked and your login detached from it',
    output: z.object({ left: z.literal(true) }),
    http: { method: 'POST', path: '/leave' },
  },

  'dashboard/app-email-sender': {
    summary: 'Read email sending permission for a vertical owned by this team',
    input: z.object({ scopeId: z.string().min(1) }),
    output: z.object({ slug: z.string(), emailSender: z.boolean() }),
    http: { method: 'GET', path: '/apps/{scopeId}/email-sender' },
  },
  'dashboard/set-app-email-sender': {
    summary: 'Enable or disable email sending across all installations of this team’s vertical',
    input: z.object({ scopeId: z.string().min(1), granted: z.boolean() }),
    output: z.object({ slug: z.string(), emailSender: z.boolean() }),
    http: { method: 'POST', path: '/apps/{scopeId}/email-sender' },
  },

  // -- settings danger zone (#2170) ------------------------------------------
  'dashboard/delete-team': {
    summary: 'Delete this team after its owner types its name: deprovision apps, revoke members and tombstone the tenant',
    input: z.object({ confirm: z.string() }),
    output: z.object({ deleted: z.literal(true) }),
    http: { method: 'POST', path: '/delete' },
  },

  // -- observability (#2170) --------------------------------------------------
  // These are the existing read-only plane reads, now resolved from the team in the path.
  // A filter that can name several values is declared as an array and sent once per value.
  'dashboard/observability-metrics': {
    summary: "Metrics for this team's published verticals",
    input: z.object({ hours: z.string().optional(), vertical: z.string().optional() }),
    output: z.array(observabilityRow),
    http: { method: 'GET', path: '/observability/metrics' },
  },
  'dashboard/observability-logs': {
    summary: "Logs for this team's published service versions",
    input: z.object({ service: repeated, hours: z.string().optional(), limit: z.string().optional(), level: z.string().optional(), search: z.string().optional() }),
    output: z.array(observabilityLogEvent),
    http: { method: 'GET', path: '/observability/logs' },
    responseHeaders: [LOGS_INCOMPLETE_HEADER],
  },
  'dashboard/app-observability-metrics': {
    summary: "One installed app's traffic at this team's tenant grain",
    input: z.object({ scopeId: z.string().min(1), hours: z.string().optional(), since: z.string().optional(), until: z.string().optional() }),
    output: z.array(tenantMetricsRow),
    http: { method: 'GET', path: '/apps/{scopeId}/observability/metrics' },
  },
  'dashboard/tenant-metrics-series': {
    summary: "Bucketed traffic for this team's installed apps",
    input: z.object({ scopeId: repeated, hours: z.string().optional(), since: z.string().optional(), until: z.string().optional() }),
    output: z.array(tenantMetricsBucket),
    http: { method: 'GET', path: '/observability/tenant-metrics-series' },
  },
  'dashboard/connector-calls': {
    summary: "Connector calls for this team on Pulse's time axis",
    input: z.object({ hours: z.string().optional(), since: z.string().optional(), until: z.string().optional() }),
    output: connectorCallsView,
    http: { method: 'GET', path: '/observability/connector-calls' },
  },
  'dashboard/business-volumes': {
    summary: "Lifecycle move volumes for this team's installed apps",
    input: z.object({ scopeId: repeated, hours: z.string().optional(), since: z.string().optional(), until: z.string().optional() }),
    output: businessVolumesView,
    http: { method: 'GET', path: '/observability/business-volumes' },
  },
  'dashboard/team-traffic': {
    summary: "Zero-filled traffic series for this team's installed apps",
    input: z.object({ scopeId: repeated, hours: z.string().optional(), since: z.string().optional(), until: z.string().optional() }),
    output: teamTrafficSeries,
    http: { method: 'GET', path: '/observability/traffic' },
  },
  'dashboard/app-metrics': {
    summary: "One traffic summary row per installed app for this team's Apps table",
    input: z.object({ hours: z.string().optional() }),
    output: appMetricsView,
    http: { method: 'GET', path: '/observability/app-metrics' },
  },
  'dashboard/app-observability-logs': {
    summary: "Log lines for one of this team's installed apps",
    input: z.object({ scopeId: z.string().min(1), hours: z.string().optional(), limit: z.string().optional(), level: z.string().optional(), search: z.string().optional(), invocationId: z.string().optional(), template: z.string().optional(), since: z.string().optional(), until: z.string().optional() }),
    output: z.array(observabilityLogEvent),
    http: { method: 'GET', path: '/apps/{scopeId}/observability/logs' },
    responseHeaders: [LOGS_INCOMPLETE_HEADER],
  },
  'dashboard/app-request-volume': {
    summary: "Request histogram for one of this team's installed apps",
    input: appRequestInput,
    output: requestVolumeView,
    http: { method: 'GET', path: '/apps/{scopeId}/observability/requests/volume' },
  },
  'dashboard/app-request-facets': {
    summary: "Request facet counts for one of this team's installed apps",
    input: appRequestInput,
    output: requestFacetsView,
    http: { method: 'GET', path: '/apps/{scopeId}/observability/requests/facets' },
  },
  'dashboard/app-requests': {
    summary: "Request records for one of this team's installed apps",
    input: appRequestInput,
    output: z.array(requestRecordView),
    http: { method: 'GET', path: '/apps/{scopeId}/observability/requests/list' },
  },
  'dashboard/app-log-patterns': {
    summary: "Log templates for one of this team's installed apps",
    input: z.object({ scopeId: z.string().min(1), hours: z.string().optional(), since: z.string().optional(), until: z.string().optional(), level: repeated, operation: repeated, buckets: z.string().optional() }),
    output: logPatternsView,
    http: { method: 'GET', path: '/apps/{scopeId}/observability/log-patterns' },
  },

  // -- install catalog (#2170) ------------------------------------------------
  // The team's half of the New-app picker. The anonymous `/api/catalog` keeps the published
  // builtins; the team's pushed verticals and their installability are read here, for the path's team.
  'dashboard/list-catalog': {
    summary: 'The verticals this team can install: published ones and its own, each saying whether it is installable yet',
    output: z.array(catalogRow),
    http: { method: 'GET', path: '/catalog' },
  },

  // -- deployments & previews (#2170) -----------------------------------------
  // The verticals this team pushed (`{slug}` is the full registry id, `acme-co/helpdesk`, sent
  // percent-encoded). Reads are open to every role (a viewer sees what they may not touch); the
  // writes ask the dashboard scope's `dashboard:provision-app` first (#1595), exactly as the
  // cookie routes they replace did. Every route below resolves the slug against the TEAM'S OWN
  // verticals, so a slug another team pushed answers as an unknown one.
  'dashboard/list-deployments': {
    summary: 'The verticals this team pushed, with their versions and where the prod channel points',
    output: z.array(deploymentRow),
    http: { method: 'GET', path: '/deployments' },
  },
  'dashboard/promote-deployment': {
    summary: 'Promote a version to prod (self-serve while the vertical is private; the registry gates migration and permission changes on a bound acknowledgement)',
    input: z.object({
      slug: z.string().min(1),
      channel: channelName,
      versionId: z.string().min(1),
      // #2333: `review` binds the acknowledgements to the review they answer.
      acknowledge: promotionAcknowledgement.optional(),
    }),
    // A declared route owes an output; the cookie route's empty 204 becomes this 200.
    output: z.object({ promoted: z.literal(true) }),
    http: { method: 'POST', path: '/deployments/{slug}/promote' },
  },
  'dashboard/get-promotion-review': {
    summary: 'What promoting a version to prod would change in the permission surface and the SQL, read before the acknowledgement is given',
    input: z.object({ slug: z.string().min(1), versionId: z.string().min(1) }),
    output: promotionReviewRow,
    http: { method: 'GET', path: '/deployments/{slug}/promote-review' },
  },
  'dashboard/list-channel-history': {
    summary: "One channel's promotion timeline, newest first: the rollback picker",
    input: z.object({ slug: z.string().min(1), channel: channelName }),
    output: z.array(channelHistoryRow),
    http: { method: 'GET', path: '/deployments/{slug}/channels/{channel}/history' },
  },
  'dashboard/list-deployment-failures': {
    summary: "A vertical's recorded deploy, preview and provision failures, newest first (one page of 50)",
    input: z.object({ slug: z.string().min(1) }),
    output: z.array(deployFailureRow),
    http: { method: 'GET', path: '/deployments/{slug}/failures' },
  },
  'dashboard/get-deployment-releases': {
    summary: "A vertical's release ledger: each version against its go-live, adoption and health",
    input: z.object({ slug: z.string().min(1) }),
    output: releasesView,
    http: { method: 'GET', path: '/deployments/{slug}/releases' },
  },
  'dashboard/get-deployment-traffic': {
    summary: "A vertical's traffic over the last `hours` (1–72, default 24) with every push and go-live marked",
    input: z.object({ slug: z.string().min(1), hours: z.number().int().min(1).max(72).optional() }),
    output: trafficSeries,
    http: { method: 'GET', path: '/deployments/{slug}/traffic' },
  },
  'dashboard/list-deployment-issues': {
    summary: "A vertical's failures grouped by shape, over the evidence window",
    input: z.object({ slug: z.string().min(1) }),
    output: z.array(failureGroupRow),
    http: { method: 'GET', path: '/deployments/{slug}/issues' },
  },
  'dashboard/delete-deployment': {
    summary: 'Remove a vertical from the registry (refused for a published vertical, and while any scope still runs it)',
    input: z.object({ slug: z.string().min(1) }),
    // A declared route owes an output; the cookie route's empty 204 becomes this 200.
    output: z.object({ removed: z.literal(true) }),
    http: { method: 'DELETE', path: '/deployments/{slug}' },
  },
  'dashboard/list-bound-scopes': {
    summary: 'The installs a vertical still backs: the list a refused delete is counting',
    input: z.object({ slug: z.string().min(1) }),
    output: z.object({ live: z.number().int(), archived: z.number().int(), scopes: z.array(boundScopeRow) }),
    http: { method: 'GET', path: '/deployments/{slug}/scopes' },
  },
  'dashboard/review-scope-move': {
    summary: "What moving the chosen installs onto another of this team's verticals would apply, and the binding to acknowledge it with",
    input: z.object({ slug: z.string().min(1), scopeIds: z.array(z.string().min(1)).min(1).max(100), target: z.string().min(1) }),
    output: z.object({ scopes: z.array(moveReviewRow) }),
    http: { method: 'POST', path: '/deployments/{slug}/scopes/move-review' },
  },
  'dashboard/move-scopes': {
    summary: "Rebind the chosen installs onto another of this team's verticals, stopping at the first refusal",
    input: z.object({
      slug: z.string().min(1),
      scopeIds: z.array(z.string().min(1)).min(1).max(100),
      target: z.string().min(1),
      ackMigrations: z.boolean().optional(),
      // #2347: per scope, the rebind review its acknowledgement answers.
      reviews: z.record(z.string(), reviewBinding).optional(),
    }),
    output: z.object({
      moved: z.array(z.string()),
      /** `reason` (#2347): the review the acknowledgement answered moved, or none was sent. */
      refusal: z
        .object({ scopeId: z.string(), message: z.string(), reason: z.enum([REBIND_REVIEW_REASONS.stale, REBIND_REVIEW_REASONS.unbound]).optional() })
        .nullable(),
    }),
    http: { method: 'POST', path: '/deployments/{slug}/scopes/move' },
  },
  'dashboard/retire-scopes': {
    summary: 'Retire the chosen installs: release their names, archive and reap them. Wipes storage; `confirm` must be the count typed',
    input: z.object({
      slug: z.string().min(1),
      scopeIds: z.array(z.string().min(1)).min(1).max(100),
      // What the caller TYPED, verbatim — checked server-side against how many scopes are retired.
      confirm: z.string(),
    }),
    output: z.object({
      retired: z.array(z.string()),
      failure: z.object({ scopeId: z.string(), message: z.string() }).nullable(),
    }),
    http: { method: 'POST', path: '/deployments/{slug}/scopes/retire' },
  },
  'dashboard/list-previews': {
    summary: "A vertical's live previews: each a scope with data bound to a version, at its own `--<tag>` URL",
    input: z.object({ slug: z.string().min(1) }),
    output: z.array(previewRow),
    http: { method: 'GET', path: '/deployments/{slug}/previews' },
  },
  'dashboard/create-preview': {
    summary: 'Create a preview of an admitted version, or re-use the one with this tag (`reused`); `ttlHours: null` pins it',
    input: z.object({
      slug: z.string().min(1),
      tag: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'tag must be a short DNS-safe label, e.g. pr-123'),
      versionId: z.string().min(1),
      // `null` PINS the preview (a long-lived test env); absent = the plane's 72h default.
      ttlHours: z.number().int().positive().max(720).nullable().optional(),
      empty: z.boolean().optional(),
      sourceScopeId: z.string().optional(),
      surface: z.string().optional(),
      refresh: z.boolean().optional(),
    }),
    output: previewCreated,
    http: { method: 'POST', path: '/deployments/{slug}/previews' },
    status: 201,
  },
  'dashboard/delete-preview': {
    summary: 'Reap one preview by tag; idempotent (`deleted: null` when it was already gone)',
    input: z.object({ slug: z.string().min(1), tag: z.string().min(1) }),
    output: z.object({ deleted: z.string().nullable() }),
    http: { method: 'DELETE', path: '/deployments/{slug}/previews/{tag}' },
  },
  'dashboard/bind-preview-domain': {
    summary: "Attach a custom domain to a preview's scope: what makes a pinned preview a long-lived test environment",
    input: z.object({
      slug: z.string().min(1),
      tag: z.string().min(1),
      domain: z.string().min(1).max(253),
      surface: z.string().min(1).max(32).optional(),
      // An additive alias next to the `--<tag>` URL; never silently demotes it.
      canonical: z.boolean().optional(),
    }),
    output: previewDomainRow,
    http: { method: 'POST', path: '/deployments/{slug}/previews/{tag}/domain' },
    status: 201,
  },

  // -- git import (#2170) -----------------------------------------------------
  // The team's GitHub connections (one per account) and the one-click CI that wires a repo to
  // push into THIS team. Connecting and setting up CI ask `dashboard:manage-integrations` in the
  // dashboard scope first (`dashboard/begin-connection`), as the cookie routes they replace did.
  'dashboard/connect-github': {
    summary: "Begin connecting a GitHub account to this team: the App's install URL, carrying a state signed for this team and caller",
    output: z.object({ url: z.string() }),
    http: { method: 'POST', path: '/github/connect' },
  },
  'dashboard/list-github-repos': {
    summary: "The repos one of this team's GitHub accounts granted (`account` omitted: the oldest), and every connected account",
    input: z.object({ account: z.string().min(1).optional() }),
    output: z.object({
      configured: z.boolean(),
      connected: z.boolean(),
      account: z.string().nullable().optional(),
      accounts: z.array(z.string()),
      repos: z.array(z.object({ fullName: z.string(), defaultBranch: z.string(), private: z.boolean(), updatedAt: z.string() })),
    }),
    http: { method: 'GET', path: '/github/repos' },
  },
  'dashboard/list-github-branches': {
    summary: "A repo's branches, read through one of this team's GitHub accounts",
    input: z.object({ repo: githubRepo, account: z.string().min(1).optional() }),
    output: z.object({ branches: z.array(z.object({ name: z.string() })) }),
    http: { method: 'GET', path: '/github/branches' },
  },
  'dashboard/setup-github-ci': {
    summary: "One-click deploy: commit the workflow to a repo and store a push credential for this team as its secret",
    input: z.object({
      repo: githubRepo,
      branch: z.string().min(1).max(200),
      /** Which connected account holds the repo; omitted, the oldest. */
      account: z.string().min(1).optional(),
      /** The vertical's directory inside the repo (monorepo); omitted, the repo root. */
      path: z.string().min(1).max(300).optional(),
    }),
    // `ok: false` is an installation approved before the App's write permissions: re-approve, or set it up by hand.
    output: z.union([
      z.object({ ok: z.literal(true), workflowPath: z.string(), workflowUpdated: z.boolean(), branch: z.string(), vertical: z.string() }),
      z.object({ ok: z.literal(false), needsPermissions: z.literal(true) }),
    ]),
    http: { method: 'POST', path: '/github/setup-ci' },
  },
  'dashboard/github-workflow-preview': {
    summary: "The deploy workflow to commit by hand, from the same generator one-click setup uses",
    // Omitted, `repo` reads `owner/app` and `branch` `main`; `path` is checked as setup-ci checks it.
    input: z.object({ repo: z.string().optional(), branch: z.string().optional(), path: z.string().optional() }),
    output: z.object({ workflowPath: z.string(), workflow: z.string() }),
    http: { method: 'GET', path: '/github/workflow-preview' },
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
    output: z.object({ available: z.boolean(), entries: z.array(findingRow), nextCursor: z.string().nullable(), cut: z.boolean() }),
    http: { method: 'GET', path: '/findings' },
  },
  'dashboard/set-finding-status': {
    summary: "Acknowledge, resolve or reopen one of this team's findings",
    input: z.object({ id: z.string().min(1), status: findingStatusInput }),
    output: findingRow,
    http: { method: 'PUT', path: '/findings/{id}/status' },
  },
  'dashboard/list-finding-rules': {
    summary: "This team's suppress rules; `active` keeps the unexpired ones",
    input: z.object({ active: z.boolean().optional() }),
    output: z.object({ entries: z.array(findingRuleRow) }),
    http: { method: 'GET', path: '/findings/rules' },
  },
  'dashboard/create-finding-rule': {
    summary: 'Suppress with a rule: a scope plus an expiry, audited by the plane',
    input: findingRuleIn,
    output: z.object({ rule: findingRuleRow, suppressed: z.number().int().nonnegative() }),
    http: { method: 'POST', path: '/findings/rules' },
    status: 201,
  },
  'dashboard/revoke-finding-rule': {
    summary: 'End a suppress rule now',
    input: z.object({ ruleId: z.string().min(1) }),
    output: findingRuleRow,
    http: { method: 'DELETE', path: '/findings/rules/{ruleId}' },
  },

  // -- AI-written text (#1749) ------------------------------------------------
  'dashboard/ask': {
    summary: 'Ask the dashboard assistant a question about this team, read-only, as the assistant stream protocol',
    input: askInput,
    // Events of the assistant's stream protocol (`@substrat-run/contracts/assistant-stream`). Each is
    // parsed with the protocol's strict schema before it is sent; a client reads them with
    // `readAssistantStreamEvent`, which is forward-compatible where this declaration cannot be.
    output: z.object({ events: z.array(z.record(z.string(), z.unknown())) }),
    http: { method: 'POST', path: '/assistant/ask' },
  },
  'dashboard/explanations-status': {
    summary: 'Whether this deployment writes AI text, and the caller’s budget for today',
    input: z.object({}),
    output: explanationView,
    http: { method: 'GET', path: '/explanations' },
  },
  'dashboard/get-finding-explanation': {
    summary: "The newest AI explanation of one of this team's findings, and today's budget",
    input: findingExplanationInput,
    output: explanationView,
    http: { method: 'GET', path: '/findings/{id}/explanation' },
  },
  'dashboard/write-finding-explanation': {
    summary: "Write an AI explanation of one of this team's findings from its evidence",
    input: findingExplanationInput,
    output: explanationView,
    http: { method: 'POST', path: '/findings/{id}/explanation' },
  },
  'dashboard/get-process-note': {
    summary: "The newest AI note under one app's process map, and today's budget",
    input: processNoteInput,
    output: explanationView,
    http: { method: 'GET', path: '/apps/{scopeId}/processes/note' },
  },
  'dashboard/write-process-note': {
    summary: "Write an AI note under one app's process map from its replayed counts",
    input: processNoteInput,
    output: explanationView,
    http: { method: 'POST', path: '/apps/{scopeId}/processes/note' },
  },
});
