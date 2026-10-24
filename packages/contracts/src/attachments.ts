import { z } from 'zod';
import { entityRef } from './events.js';
import { instant, principalId } from './ids.js';

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
 * (harmless, and collected by the orphan sweep, #2314), never a row silently re-pointed at
 * different content.
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
 * A record without what only its bytes can say (#2498): an upload judges these fields before it
 * writes a byte, and a streamed body's `size` and `sha256` are known only once it has been read.
 */
export const attachmentRecordFields = attachmentRecord.omit({ size: true, sha256: true });
/** The fields as a caller hands them over, before they are judged. */
export type AttachmentRecordFields = z.input<typeof attachmentRecordFields>;

/**
 * The longest each caller-supplied string of a NEW attachment may be, in UTF-16 units (#2519). A
 * connector reads a record back through a response header, where a non-ASCII unit costs up to 6
 * bytes escaped, so the strings it carries are bounded where the record is made: at 512 + 255 +
 * 128 + 255 + 128 units the record is under 8.2 KiB. 512 keeps a realistic 400-character path
 * storable. {@link attachmentRecord} itself is NOT capped: it is also what a stored row is parsed
 * against, and a row written before these bounds must stay readable.
 */
export const ATTACHMENT_FIELD_MAX = {
  filename: 512,
  contentType: 255,
  entityType: 128,
  entityId: 255,
  createdBy: 128,
} as const;

/**
 * {@link attachmentRecordFields} as an upload judges it: the same fields, each bounded by
 * {@link ATTACHMENT_FIELD_MAX}. One judge for every door that stores an attachment.
 */
export const attachmentUploadFields = attachmentRecordFields.extend({
  entity: z.object({
    entityType: z.string().min(1).max(ATTACHMENT_FIELD_MAX.entityType),
    entityId: z.string().min(1).max(ATTACHMENT_FIELD_MAX.entityId),
  }),
  filename: z.string().min(1).max(ATTACHMENT_FIELD_MAX.filename),
  contentType: z.string().min(1).max(ATTACHMENT_FIELD_MAX.contentType),
  createdBy: z.string().min(1).max(ATTACHMENT_FIELD_MAX.createdBy),
});

/**
 * The spine events attachment mutations emit (#473) — kernel-emitted, fat payload (the
 * full `attachmentRecord`), so a consumer (a timeline projection, attachment GC) never
 * needs a cross-module read. `entity` on the envelope is the OWNING entity, so timelines
 * project attachments onto the entity they document.
 */
export const ATTACHMENT_ADDED = 'attachment.added';
export const ATTACHMENT_REMOVED = 'attachment.removed';

// ---------------------------------------------------------------------------
// Upload links — an operation mints a short-lived, single-use URL for ONE attachment on
// ONE entity, so a caller with no cookie and no bearer (an MCP client) can hand bytes to
// the platform without sending them through a tool call.
//
// The link is a directory row in the scope's own spine, like a capability: only the
// secret's SHA-256 is stored, the secret leaves the kernel once (in the mint's return
// value), and redemption goes through the SAME attachment write as any upload — the
// target's `writePermission` is re-checked as the MINTING principal at redemption, who is
// the attachment's author. A link is not a capability: it never acts as anyone, it never
// makes a session, and it can only ever produce the one attachment it was minted for.
// ---------------------------------------------------------------------------

/** What every upload-link secret starts with — so a secret scanner can recognise a leaked one. */
export const UPLOAD_LINK_SECRET_PREFIX = 'sbup_';
/**
 * The whole shape of a secret the kernel mints: the prefix, then 32 random bytes as unpadded
 * base64url (43 characters). Anything else cannot be one of ours, so the route answers it with
 * the same 404 an unknown secret gets, without asking the scope.
 */
export const UPLOAD_LINK_SECRET_SHAPE = /^sbup_[A-Za-z0-9_-]{43}$/;
/** Could `secret` be one the kernel minted? Says nothing about whether it names a link. */
export const isUploadLinkSecretShape = (secret: unknown): secret is string =>
  typeof secret === 'string' && UPLOAD_LINK_SECRET_SHAPE.test(secret);
/** A link lives ten minutes unless the mint says otherwise. */
export const UPLOAD_LINK_DEFAULT_TTL_SECONDS = 600;
/** ... and never more than an hour, whatever the mint says. */
export const UPLOAD_LINK_MAX_TTL_SECONDS = 3600;
/**
 * The most bytes any upload link may admit. A manifest's `uploadLinks.maxBytes` is held under
 * it: a Worker buffers the body once to hash it, and a ceiling the platform cannot buffer is
 * not a limit.
 */
export const UPLOAD_LINK_MAX_BYTES_CEILING = 25 * 1024 * 1024;
/** Where a vertical mounts the redemption (`mountUploadLinkRedeem` in `@substrat-run/vertical-host`). */
export const UPLOAD_LINK_PATH_PREFIX = '/api/attachment-uploads';

/**
 * #2315: the request header a redeemer names its own redemption with, so a retry after a lost
 * reply gets the stored file back instead of 410. The id authorises nothing alone: it is
 * honoured only with the link's secret, only for the redemption that spent the link, and only
 * until `UPLOAD_LINK_REPLAY_GRACE_SECONDS` after the link's expiry.
 */
export const UPLOAD_LINK_IDEMPOTENCY_HEADER = 'Idempotency-Key';
/**
 * 16 to 255 visible ASCII characters other than `"` and `\`, no space: a UUID or a ULID fits.
 * The floor is there because whoever holds the secret but not the id must not be able to guess the
 * id and learn that the file arrived. The two characters left out keep a structured-field string
 * (`"…"`, which the route unwraps) from ever being read as a key of its own.
 */
export const UPLOAD_LINK_IDEMPOTENCY_KEY_SHAPE = /^[\x21\x23-\x5b\x5d-\x7e]{16,255}$/;
/** Is `key` a well-formed idempotency key? Says nothing about whether any redemption carried it. */
export const isUploadLinkIdempotencyKey = (key: unknown): key is string =>
  typeof key === 'string' && UPLOAD_LINK_IDEMPOTENCY_KEY_SHAPE.test(key);
/**
 * How long after a link's expiry a redemption it spent can still be replayed: a link redeemed in
 * its last second must still be retryable.
 */
export const UPLOAD_LINK_REPLAY_GRACE_SECONDS = 600;

/** A media type (`application/pdf`) or a family (`image/*`), lowercase, no parameters. */
export const uploadLinkContentType = z
  .string()
  .max(127)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/, 'a media type such as application/pdf, or a family such as image/*');

/**
 * What a target declares to take upload links (`attachmentTargets[].uploadLinks`). Presence
 * IS the opt-in — an entity type without it refuses a mint — and the policy is the target's,
 * so a mint can only narrow it: `maxBytes` here is the ceiling, `contentTypes` the allowlist
 * (absent: any type). The declaration is what a reviewer reads in the surface diff.
 */
export const uploadLinkPolicy = z.object({
  maxBytes: z.number().int().positive().max(UPLOAD_LINK_MAX_BYTES_CEILING),
  contentTypes: z.array(uploadLinkContentType).min(1).max(32).optional(),
});
export type UploadLinkPolicy = z.infer<typeof uploadLinkPolicy>;

/** The filename an upload may carry: a leaf name, never a path. */
export const uploadLinkFilename = z
  .string()
  .min(1)
  .max(255)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^/\\\u0000-\u001f\u007f]+$/, 'a file name, not a path');

/** `ctx.attachments.mintUploadUrl`'s input. */
export const uploadLinkMintInput = z
  .object({
    entity: entityRef,
    /** Fixes the stored name. Absent: the uploader names the file (`?filename=` or `Content-Disposition`). */
    filename: uploadLinkFilename.optional(),
    /** Narrows the target's `maxBytes`; a larger value is refused, not clamped. */
    maxBytes: z.number().int().positive().optional(),
    ttlSeconds: z.number().int().positive().max(UPLOAD_LINK_MAX_TTL_SECONDS).optional(),
    visibility: visibility.optional(),
  })
  .strict();
export type UploadLinkMintInput = z.input<typeof uploadLinkMintInput>;

/** The path a link's bytes are PUT to — the secret last, the target in the path so a mismatch is a 404 that spends nothing. */
export function uploadLinkPath(entity: { entityType: string; entityId: string }, secret: string): string {
  return `${UPLOAD_LINK_PATH_PREFIX}/${encodeURIComponent(entity.entityType)}/${encodeURIComponent(entity.entityId)}/${secret}`;
}

/** What a mint returns. The `secret` (and the `path` that carries it) exists only here. */
export interface MintedUploadLink {
  id: string;
  secret: string;
  /** Join to the vertical's own public origin: `PUT ${origin}${path}`. */
  path: string;
  expiresAt: string;
  /** The ceiling the link will enforce — the mint's, under the target's. */
  maxBytes: number;
  filename: string | null;
}

export const uploadLinkState = z.enum(['pending', 'redeemed', 'revoked', 'expired']);
export type UploadLinkState = z.infer<typeof uploadLinkState>;

/** A link as a listing shows it. Never the secret, never its hash. */
export const uploadLinkRecord = z.object({
  id: z.string().min(1),
  entity: entityRef,
  filename: z.string().nullable(),
  maxBytes: z.number().int().positive(),
  contentTypes: z.array(uploadLinkContentType).nullable(),
  visibility,
  mintedBy: principalId,
  mintedAt: instant,
  expiresAt: instant,
  state: uploadLinkState,
  redeemedAt: instant.nullable(),
  /** The attachment a redeemed link produced — what a follow-up operation is handed. */
  attachmentId: z.string().nullable(),
});
export type UploadLinkRecord = z.infer<typeof uploadLinkRecord>;

/** What `ScopeHost.inspectUploadLink` tells the route before it reads a byte. */
export interface UploadLinkView {
  entity: { entityType: string; entityId: string };
  filename: string | null;
  maxBytes: number;
  contentTypes: string[] | null;
  visibility: Visibility;
}

/** A link was minted. Entity: the target; actor: the minter. */
export const ATTACHMENT_UPLOAD_LINK_MINTED = 'attachment.upload-link-minted';
/**
 * A link was redeemed — written in the SAME transaction as the `attachment.added` it caused.
 * A vertical consumes this to learn which link produced which attachment, and so which
 * follow-up to run.
 */
export const ATTACHMENT_UPLOAD_LINK_REDEEMED = 'attachment.upload-link-redeemed';
/** A link was revoked before it was used. */
export const ATTACHMENT_UPLOAD_LINK_REVOKED = 'attachment.upload-link-revoked';

export const attachmentUploadLinkMintedPayload = z.object({
  linkId: z.string().min(1),
  entity: entityRef,
  filename: z.string().nullable(),
  maxBytes: z.number().int().positive(),
  contentTypes: z.array(uploadLinkContentType).nullable(),
  visibility,
  expiresAt: instant,
  mintedBy: principalId,
});
export type AttachmentUploadLinkMintedPayload = z.infer<typeof attachmentUploadLinkMintedPayload>;

export const attachmentUploadLinkRedeemedPayload = z.object({
  linkId: z.string().min(1),
  entity: entityRef,
  attachmentId: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mintedBy: principalId,
});
export type AttachmentUploadLinkRedeemedPayload = z.infer<typeof attachmentUploadLinkRedeemedPayload>;

export const attachmentUploadLinkRevokedPayload = z.object({
  linkId: z.string().min(1),
  entity: entityRef,
  revokedBy: principalId,
});
export type AttachmentUploadLinkRevokedPayload = z.infer<typeof attachmentUploadLinkRevokedPayload>;
