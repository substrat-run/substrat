/**
 * The permission gate an attachment target is held to (#473, #3434), in one place so both
 * adapters judge a declaration, and a remove, the same way.
 *
 * - `read` decides `list`, `open`, `openStream` and `search`.
 * - `write` decides `upload` and `remove`. Absent from the declaration, it is `read`.
 * - `remove`, when declared, admits a REMOVE beside `write` and nothing else (#3434). It is the
 *   key a retention schedule holds to delete a file it never uploaded, without holding the
 *   uploader's key (and so without being able to upload). Declared `holder: 'system'`, it is a
 *   key no person can hold.
 */
import type { Decision, EntityRef, PermissionKey } from '@substrat-run/contracts';

/** What a manifest's `attachmentTargets` entry declares about its keys. */
export interface AttachmentTargetKeys {
  readonly readPermission: PermissionKey;
  readonly writePermission?: PermissionKey;
  readonly removePermission?: PermissionKey;
}

/** A target's keys, with the defaults applied. */
export interface AttachmentGate {
  readonly read: PermissionKey;
  readonly write: PermissionKey;
  readonly remove?: PermissionKey;
}

/** The gate a declaration means. */
export function attachmentGateOf(target: AttachmentTargetKeys): AttachmentGate {
  return {
    read: target.readPermission,
    write: target.writePermission ?? target.readPermission,
    ...(target.removePermission !== undefined ? { remove: target.removePermission } : {}),
  };
}

/**
 * Refuse a second declaration of one entity type whose gate differs from the first: who may
 * read or remove an entity's files must not depend on which module registered first. The same
 * gate declared twice is idempotent.
 */
export function assertSameAttachmentGate(
  entityType: string,
  existing: AttachmentGate | undefined,
  gate: AttachmentGate,
): void {
  if (!existing) return;
  if (existing.read === gate.read && existing.write === gate.write && existing.remove === gate.remove) return;
  const show = (g: AttachmentGate) => `${g.read}/${g.write}${g.remove !== undefined ? `/${g.remove}` : ''}`;
  throw new Error(`conflicting attachmentTargets for '${entityType}': (${show(existing)}) vs (${show(gate)})`);
}

/**
 * Decide a remove: the write key, or else the declared remove key, on the owning entity, as
 * whoever `check` checks as. A refusal names the remove key when one is declared, since that is
 * the narrowest key that would have admitted it, and the write key otherwise.
 *
 * The write key is asked first so a person's remove decides exactly as it did before #3434
 * whenever they hold it.
 */
export async function decideAttachmentRemove(
  check: (permission: PermissionKey, entity: EntityRef) => Promise<Decision>,
  gate: AttachmentGate,
  entity: EntityRef,
): Promise<Decision> {
  const byWrite = await check(gate.write, entity);
  if (byWrite.allowed || gate.remove === undefined || gate.remove === gate.write) return byWrite;
  return check(gate.remove, entity);
}
