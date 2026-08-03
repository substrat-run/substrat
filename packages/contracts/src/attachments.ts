import { z } from 'zod';
import { entityRef } from './events.js';
import { instant } from './ids.js';

// Visibility classification for attachment items — documents, comments,
// custom-field values (K-13). Mandatory wherever data can reach the customer
// portal: like piiClass on events, a classification is only total if it was
// never optional. Engine-owned tables handle their own flags; this is the
// kernel-surface convention.

export const visibility = z.enum(['internal', 'customer']);
export type Visibility = z.infer<typeof visibility>;

/**
 * One attachment's metadata fact (#473) — the row the kernel writes into the scope's
 * `_substrat_attachments` spine when bytes land in the platform blob store. The row and
 * the object are two halves of one thing: the row lives INSIDE the scope database (so
 * `scope pull` / restore / PITR carry it like any other scope fact), the bytes live in
 * the platform-minted per-tenant blob store under a key derived from `(scopeId, id)`.
 *
 * `sha256` is the integrity witness across that split: bytes are hashed at upload and
 * written once under a fresh ULID key, so a row can never point at bytes other than the
 * ones it was born with — after a PITR rewind the worst case is an orphaned object
 * (harmless, GC-able), never a row silently re-pointed at different content.
 */
export const attachmentRecord = z.object({
  /** ULID — also the tail of the platform-derived blob key. */
  id: z.string().min(1),
  /** The owning entity — must be a declared `attachmentTargets` entry of a registered module. */
  entity: entityRef,
  filename: z.string().min(1),
  contentType: z.string().min(1),
  /** Byte length, recorded at upload. */
  size: z.number().int().nonnegative(),
  /** Hex SHA-256 of the bytes, computed kernel-side at upload (Web Crypto). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  visibility,
  /** The uploading actor: a principal id, or the JSON-encoded system/connection actor. */
  createdBy: z.string().min(1),
  createdAt: instant,
});
export type AttachmentRecord = z.infer<typeof attachmentRecord>;

/**
 * The spine events attachment mutations emit (#473) — kernel-emitted, fat payload (the
 * full `attachmentRecord`), so a consumer (a timeline projection, attachment GC) never
 * needs a cross-module read. `entity` on the envelope is the OWNING entity, so timelines
 * project attachments onto the entity they document.
 */
export const ATTACHMENT_ADDED = 'attachment.added';
export const ATTACHMENT_REMOVED = 'attachment.removed';
