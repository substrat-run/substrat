import { ATTACHMENT_ADDED, ATTACHMENT_REMOVED } from './attachments.js';
import { CAPABILITY_EXERCISED, CAPABILITY_MINTED, CAPABILITY_REVOKED } from './capability.js';
import { substratError } from './errors.js';
import { ENTITY_LINKED, ENTITY_RELINKED } from './permission.js';

/**
 * The spine event types only the kernel writes (#1864). Each one is a fact about the
 * permission graph or a platform surface — a capability minted, an entity moved, a file
 * attached — that an auditor reads as having happened because the kernel did it. `ctx.emit`
 * refuses them from module code, or an operation could forge a move that never happened,
 * or a revoke that did not.
 *
 * The one definition: the adapters' `ctx.emit` asks `assertModuleEmittableType`, and the
 * kernel's own verbs write through the same outbox path without asking.
 */
export const KERNEL_AUTHORED_EVENT_TYPES: ReadonlySet<string> = new Set([
  ATTACHMENT_ADDED,
  ATTACHMENT_REMOVED,
  CAPABILITY_EXERCISED,
  CAPABILITY_MINTED,
  CAPABILITY_REVOKED,
  ENTITY_LINKED,
  ENTITY_RELINKED,
]);

/** `ctx.emit`'s refusal of a kernel-authored type: `validation_failed`, naming the type. */
export function assertModuleEmittableType(type: string): void {
  if (!KERNEL_AUTHORED_EVENT_TYPES.has(type)) return;
  throw substratError(
    'validation_failed',
    `ctx.emit cannot emit '${type}': the kernel authors that event type itself.`,
    { errors: [{ path: 'type', message: 'a kernel-authored event type' }] },
  );
}
