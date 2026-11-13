import {
  ATTACHMENT_DOWNLOAD_LINK_MINTED,
  ATTACHMENT_DOWNLOAD_LINK_REVOKED,
  DOWNLOAD_LINK_DEFAULT_TTL_SECONDS,
  DOWNLOAD_LINK_SECRET_PREFIX,
  downloadLinkMintInput,
  downloadLinkPath,
  isDownloadLinkSecretShape,
  principalId as principalIdSchema,
  substratError,
  type AttachmentDownloadLinkMintedPayload,
  type AttachmentDownloadLinkRevokedPayload,
  type CheckSubject,
  type Decision,
  type DomainEventInput,
  type EntityRef,
  type Instant,
  type MintedDownloadLink,
  type PermissionKey,
  type PrincipalId,
  type DownloadLinkMintInput,
} from '@substrat-run/contracts';
import { toBase64url } from './base64url.js';
import { capabilityTokenHash } from './capability.js';
import { assertAllowed } from './permission-checker.js';
import type { ScopedSql } from './scope-host.js';
import { ulid } from './ulid.js';

/**
 * The kernel half of download links (#3139): the directory row, the secret and every decision read
 * off them, written once for both adapters, as `upload-link.ts` is for the write side.
 *
 * An operation mints a link (`ctx.attachments.mintDownloadUrl`) for one attachment and hands the URL
 * to a caller with no cookie: an `<audio>` element on another origin, an MCP client, a mail. The
 * host resolves the secret to the principal who MINTED it, and opens the file through the ordinary
 * read surface as them, so the target's `readPermission` is checked on every request and not only
 * at the mint. A minter who loses read access takes every link they minted with them.
 *
 * **Not spent by a read.** A media element reads a file in many ranged requests, so a link is good
 * until it expires or is revoked. That is why the life is short by default and capped at a day, and
 * why nothing is written per read: a read is not a fact the spine records for any other door either.
 *
 * **Why not a capability.** A capability exchanges for a session in a cookie, on the vertical's own
 * origin; a media element on another origin, or a URL in an MCP tool result, has neither. A download
 * link is the bearer half alone, scoped to one file.
 *
 * **The secret.** 256 bits behind `sbdl_`; only its SHA-256 is stored and every lookup is an indexed
 * equality on the hash in SQL, as for an upload link.
 */

declare const crypto: {
  getRandomValues<T extends Uint8Array>(array: T): T;
};

export const DOWNLOAD_LINK_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_download_links (
    id TEXT PRIMARY KEY,
    -- SHA-256 hex of the secret. The secret itself is stored NOWHERE.
    token_hash TEXT NOT NULL UNIQUE,
    attachment_id TEXT NOT NULL,
    -- The file's owner when the link was minted: what a revoke checks, and what the events name.
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    -- The principal the file is read AS, at every request.
    minted_by TEXT NOT NULL,
    minted_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    -- Tombstone, never a delete: a link that was minted is evidence of who could read a file.
    revoked_at TEXT,
    revoked_by TEXT
  );
  CREATE INDEX IF NOT EXISTS _substrat_download_links_attachment
    ON _substrat_download_links (attachment_id);
`;

/** The tables `DOWNLOAD_LINK_DDL` builds — what a copy of a scope leaves behind. */
export const DOWNLOAD_LINK_TABLE_NAMES = ['_substrat_download_links'] as const;

/** The `reason` a redemption refuses a link with once it is expired or revoked, so the route can answer 410. */
export const DOWNLOAD_LINK_GONE = 'download_link_gone';

interface DownloadLinkRow {
  id: string;
  attachment_id: string;
  entity_type: string;
  entity_id: string;
  minted_by: string;
  expires_at: string;
  revoked_at: string | null;
}

const COLUMNS = 'id, attachment_id, entity_type, entity_id, minted_by, expires_at, revoked_at';

/** A fresh download-link secret: 256 bits, base64url, prefixed. Only its hash is ever stored. */
export function mintDownloadLinkSecret(): string {
  return DOWNLOAD_LINK_SECRET_PREFIX + toBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** What the download-link verbs need: the operation's own seams, and each target's read key. */
export interface DownloadLinkVerbDeps {
  /** RAW spine access inside the operation's own transaction. */
  sql: ScopedSql;
  subject: CheckSubject;
  now: Instant;
  /** The operation's OWN check. */
  check: (permission: PermissionKey, entity?: EntityRef) => Promise<Decision>;
  emit: (event: DomainEventInput) => void;
  assertWrites: (verb: string) => void;
  /** This invocation's minted secrets — appended to by a mint, read by the secret guards. */
  minted: string[];
  /** The declared read key for an entity type, if any module declares it an attachment target. */
  readKeyOf: (entityType: string) => PermissionKey | undefined;
}

const MS_PER_SECOND = 1000;

function principalOf(subject: CheckSubject, verb: string): PrincipalId {
  if (subject.kind !== 'principal') {
    throw substratError(
      'forbidden',
      `${verb}: only a principal may mint or revoke a download link — a ${subject.kind} actor has no ` +
        'read access of its own to lend',
      { reason: 'download_link_delegation' },
    );
  }
  return subject.id;
}

/**
 * `ctx.attachments.mintDownloadUrl`: a URL that lets its holder read one attachment until it expires.
 * The caller must be a principal holding the target's `readPermission` on the file's owner (the
 * check an open makes); it is made again, as them, on every read. A file the scope does not hold,
 * or one the orphan sweep has condemned, is `not_found`. Transactional with the operation.
 */
export async function mintDownloadUrl(deps: DownloadLinkVerbDeps, raw: DownloadLinkMintInput): Promise<MintedDownloadLink> {
  deps.assertWrites('ctx.attachments.mintDownloadUrl');
  const minter = principalOf(deps.subject, 'ctx.attachments.mintDownloadUrl');
  const input = downloadLinkMintInput.parse(raw);
  const file = deps.sql.query<{ entity_type: string; entity_id: string }>(
    `SELECT a.entity_type, a.entity_id FROM _substrat_attachments a
      WHERE a.id = ? AND NOT EXISTS (SELECT 1 FROM _substrat_attachment_condemned c WHERE c.id = a.id)`,
    [input.attachmentId],
  )[0];
  if (!file) throw substratError('not_found', `ctx.attachments.mintDownloadUrl: no attachment ${input.attachmentId} in this scope`);
  const entity = { entityType: file.entity_type, entityId: file.entity_id };
  const read = deps.readKeyOf(entity.entityType);
  if (!read) {
    throw substratError('not_found', `ctx.attachments.mintDownloadUrl: '${entity.entityType}' is not a declared attachment target`);
  }
  // Delegation, never elevation: the key an open checks, on the file's owner, as the caller.
  assertAllowed(await deps.check(read, entity));

  const id = ulid();
  const secret = mintDownloadLinkSecret();
  const expiresAt = new Date(
    Date.parse(deps.now) + (input.ttlSeconds ?? DOWNLOAD_LINK_DEFAULT_TTL_SECONDS) * MS_PER_SECOND,
  ).toISOString() as Instant;
  deps.sql.exec(
    `INSERT INTO _substrat_download_links
       (id, token_hash, attachment_id, entity_type, entity_id, minted_by, minted_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, await capabilityTokenHash(secret), input.attachmentId, entity.entityType, entity.entityId, minter, deps.now, expiresAt],
  );
  deps.minted.push(secret);
  const payload: AttachmentDownloadLinkMintedPayload = {
    linkId: id,
    attachmentId: input.attachmentId,
    entity,
    expiresAt,
    mintedBy: minter,
  };
  deps.emit({ type: ATTACHMENT_DOWNLOAD_LINK_MINTED, schemaVersion: 1, entity, piiClass: 'none', payload });
  return { id, secret, path: downloadLinkPath(input.attachmentId, secret), expiresAt };
}

/**
 * `ctx.attachments.revokeDownloadLink`: take a link back before it expires. Allowed to anyone who
 * could have minted it (the read key on the file's owner). Idempotent, and a no-op once expired.
 */
export async function revokeDownloadLink(deps: DownloadLinkVerbDeps, id: string): Promise<void> {
  deps.assertWrites('ctx.attachments.revokeDownloadLink');
  const revoker = principalOf(deps.subject, 'ctx.attachments.revokeDownloadLink');
  const row = deps.sql.query<DownloadLinkRow>(`SELECT ${COLUMNS} FROM _substrat_download_links WHERE id = ?`, [id])[0];
  if (!row) throw substratError('not_found', `no download link ${id} in this scope`);
  const entity = { entityType: row.entity_type, entityId: row.entity_id };
  const read = deps.readKeyOf(row.entity_type);
  if (read) assertAllowed(await deps.check(read, entity));
  if (row.revoked_at !== null || row.expires_at <= deps.now) return;
  deps.sql.exec('UPDATE _substrat_download_links SET revoked_at = ?, revoked_by = ? WHERE id = ?', [deps.now, revoker, id]);
  const payload: AttachmentDownloadLinkRevokedPayload = { linkId: id, attachmentId: row.attachment_id, entity, revokedBy: revoker };
  deps.emit({ type: ATTACHMENT_DOWNLOAD_LINK_REVOKED, schemaVersion: 1, entity, piiClass: 'none', payload });
}

/** One answer for a secret that names nothing, and for one minted for another file. */
const unknownLink = () => substratError('not_found', 'This download link is not valid.');

/**
 * Who a download link reads `attachmentId` as: the principal who minted it, while it is live. The
 * attachment is judged before the state, so a path naming another file is the same 404 as an
 * unknown secret, whatever the link's history; an expired or revoked link is `conflict` with reason
 * `download_link_gone`, said only to a holder of the secret. Reads nothing but the link: the host
 * then opens the file as the minter, through the gate any open takes.
 */
export async function resolveDownloadLink(
  deps: { sql: ScopedSql; now: Instant },
  secret: unknown,
  attachmentId: string,
): Promise<PrincipalId> {
  if (!isDownloadLinkSecretShape(secret)) throw unknownLink();
  const row = deps.sql.query<DownloadLinkRow>(
    `SELECT ${COLUMNS} FROM _substrat_download_links WHERE token_hash = ?`,
    [await capabilityTokenHash(secret)],
  )[0];
  if (!row || row.attachment_id !== attachmentId) throw unknownLink();
  if (row.revoked_at !== null || row.expires_at <= deps.now) {
    throw substratError('conflict', 'This download link has expired or was revoked.', { reason: DOWNLOAD_LINK_GONE });
  }
  return principalIdSchema.parse(row.minted_by);
}
