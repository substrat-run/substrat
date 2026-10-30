import { z } from 'zod';
import { APP_EVENT_KINDS } from './app-event-kinds.js';

/**
 * The dashboard rows its HTTP surface and its module share (#2426): the route declarations in
 * `routes.ts` answer them, and the module's declared outputs in `module.ts` are built from them.
 *
 * In a file of their own because `routes.ts` is harness by boundary-lint's name list: module
 * code that imported a schema from it would reach a file the module rules never scan. This one
 * is module code, scanned as such.
 */

/** The longest a connect link may live: the mint operation and the route that declares it both cap at it. */
export const CONNECT_LINK_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

/**
 * One row of the team roster: an active member, an outstanding invite, or an accepted invite
 * whose access is still being set up (`joining`) or never will be (`refused`, reason in
 * `refusal`, #1184). The module's `DashboardMemberRow` is this row.
 */
export const memberRow = z.object({
  id: z.string(),
  /** The kernel principal once accepted; null while still `invited`. */
  principal: z.string().nullable(),
  email: z.string(),
  role_key: z.string(),
  status: z.enum(['active', 'invited', 'revoked', 'joining', 'refused']),
  refusal: z.string().optional(),
  invitation_id: z.string().nullable(),
  invited_by: z.string(),
  invited_at: z.string(),
  joined_at: z.string().nullable(),
});

/**
 * Where an AI-written text came from (#1749): computed by the dashboard from the records it
 * read, never by the model. The page renders it under the text, so a reader checks the
 * paragraph against the sources rather than taking it on trust.
 */
export const explanationSource = z.object({
  kind: z.enum(['finding', 'ops-failures', 'sweep-runs', 'deploy', 'lifecycle-flow']),
  /** Records read from it, where it is a list; null for a single record. */
  count: z.number().int().nonnegative().nullable(),
  /** A page inside the team where the source is read, or null where there is none. */
  href: z.string().nullable(),
});

export const explanationProvenance = z.object({
  writtenAt: z.string(),
  /** `provider/modelId`: what wrote the paragraph. */
  model: z.string(),
  /** The window the records were read over. */
  since: z.string(),
  until: z.string(),
  sources: z.array(explanationSource),
  /** "212 failure records, 2 versions": the counts the provenance line leads with. */
  summary: z.string(),
});

/** One AI-written text as the team's scope files it: what it says, about what, and from which facts. */
export const explanationRow = z.object({
  id: z.string(),
  /** `finding:<id>` or `process:<scopeId>:<entity>:<period>`. */
  subject: z.string(),
  /** The digest of the facts it was written from; a different digest now means newer data. */
  digest: z.string(),
  text: z.string(),
  provenance: explanationProvenance,
  written_by: z.string(),
  written_at: z.string(),
});
