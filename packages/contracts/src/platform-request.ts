import { z } from 'zod';
import { instant, platformRequestId } from './ids.js';
import { actor } from './events.js';

/**
 * Platform intents (docs/design/platform-intents.md) — how a sandbox-clean vertical asks the
 * platform to perform a privileged action (provision a sibling scope, request quota, …) without
 * an upward call. A vertical operation enqueues a typed intent into its own scope's
 * `_substrat_platform_requests` spine table via `ctx.requestPlatform`; the platform pulls and
 * executes it with `HostAdmin` authority, knowing the tenant inherently (it reads that scope's DO).
 */

export const platformRequestStatus = z.enum(['pending', 'done', 'failed']);
export type PlatformRequestStatus = z.infer<typeof platformRequestStatus>;

/**
 * What module code passes to `ctx.requestPlatform`. `kind` selects the platform-side handler;
 * `payload` is opaque to the kernel (validated by the handler for that kind at drain time),
 * exactly as `domainEventInput.payload` is opaque to the emit path. Origin fields (id, requestedAt,
 * requestedBy) are stamped kernel-side and are deliberately absent here.
 */
export const platformRequestInput = z.object({
  kind: z.string().min(1),
  payload: z.unknown(),
});
export type PlatformRequestInput = z.infer<typeof platformRequestInput>;

/** The full kernel-stamped intent record as it lives in the spine and is read by the drain. */
export const platformRequest = z.object({
  id: platformRequestId,
  kind: z.string().min(1),
  payload: z.unknown(),
  requestedBy: actor, // stamped kernel-side from the operation's ambient actor, like an event's `actor`
  status: platformRequestStatus,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  result: z.unknown().nullable(),
  requestedAt: instant, // stamped kernel-side
  settledAt: instant.nullable(),
});
export type PlatformRequest = z.infer<typeof platformRequest>;

/**
 * Backpressure bound (platform-intents.md §Resolved decisions): `ctx.requestPlatform` refuses once
 * a scope already holds this many `pending` intents, so a stuck or runaway vertical cannot flood
 * the drain. Shared by every adapter so the limit can't drift between them.
 */
export const MAX_PENDING_PLATFORM_REQUESTS = 32;
