import { ATTACHMENT_ADDED, ATTACHMENT_REMOVED } from './attachments.js';
import { EMAIL_DEAD_LETTERED, EMAIL_REFUSED, EMAIL_SENT } from './email-intent.js';
import { CAPABILITY_EXERCISED, CAPABILITY_MINTED, CAPABILITY_REVOKED } from './capability.js';
import { ENTITY_ARCHIVED, ENTITY_RESTORED, ENTITY_TRASHED, ENTITY_UNARCHIVED } from './entity-state.js';
import { substratError } from './errors.js';
import { ENTITY_GRANTS_RETIRED, ENTITY_GRANTS_TOPPED_UP, ENTITY_LINKED, ENTITY_RELINKED } from './permission.js';

/**
 * The spine event types only the kernel writes (#1864). Each one is a fact about the
 * permission graph or a platform surface — a capability minted, an entity moved, a file
 * attached — that an auditor reads as having happened because the kernel did it. `ctx.emit`
 * refuses them from module code, or an operation could forge a move that never happened,
 * or a revoke that did not.
 *
 * The one definition: the adapters' `ctx.emit` asks `assertModuleEmittableType`, and the
 * kernel's own writer asks `assertKernelAuthoredType` — the same set, from both sides.
 *
 * The membership the guards consult is this module's own and never exported: module code is
 * bundled with contracts into the same worker, so an exported `Set` — `ReadonlySet` is only a
 * type — could be cast, emptied, and then forged past. Readers get a frozen copy and a
 * predicate; nothing they hold changes what is refused.
 */
const KERNEL_AUTHORED: ReadonlySet<string> = new Set([
  ATTACHMENT_ADDED,
  ATTACHMENT_REMOVED,
  CAPABILITY_EXERCISED,
  CAPABILITY_MINTED,
  CAPABILITY_REVOKED,
  EMAIL_DEAD_LETTERED,
  EMAIL_REFUSED,
  EMAIL_SENT,
  ENTITY_ARCHIVED,
  ENTITY_GRANTS_RETIRED,
  ENTITY_GRANTS_TOPPED_UP,
  ENTITY_LINKED,
  ENTITY_RELINKED,
  ENTITY_RESTORED,
  ENTITY_TRASHED,
  ENTITY_UNARCHIVED,
]);

/** The reserved types, for readers: a frozen snapshot, not the set the guards consult. */
export const KERNEL_AUTHORED_EVENT_TYPES: readonly string[] = Object.freeze([...KERNEL_AUTHORED]);

/** Is `type` one only the kernel may write? */
export const isKernelAuthoredEventType = (type: string): boolean => KERNEL_AUTHORED.has(type);

/** `ctx.emit`'s refusal of a kernel-authored type: `validation_failed`, naming the type. */
export function assertModuleEmittableType(type: string): void {
  if (!KERNEL_AUTHORED.has(type)) return;
  throw substratError(
    'validation_failed',
    `ctx.emit cannot emit '${type}': the kernel authors that event type itself.`,
    { errors: [{ path: 'type', message: 'a kernel-authored event type' }] },
  );
}

/**
 * The kernel writer's own check, the mirror of the one above: a type the kernel writes must be
 * in the set, or a new kernel event would be forgeable from `ctx.emit` without anyone noticing
 * the list was not updated. `internal`, because it is a platform bug, never a caller's.
 */
export function assertKernelAuthoredType(type: string): void {
  if (KERNEL_AUTHORED.has(type)) return;
  throw substratError(
    'internal',
    `the kernel wrote '${type}', which is not a kernel-authored type — add it to ` +
      'KERNEL_AUTHORED in contracts/src/kernel-events.ts, ' +
      'or module code can forge it through ctx.emit',
  );
}
