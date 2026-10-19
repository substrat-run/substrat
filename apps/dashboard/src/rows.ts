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
