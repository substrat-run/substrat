import {
  ATTACHMENT_UPLOAD_LINK_MINTED,
  ATTACHMENT_UPLOAD_LINK_REDEEMED,
  ATTACHMENT_UPLOAD_LINK_REVOKED,
  UPLOAD_LINK_DEFAULT_TTL_SECONDS,
  UPLOAD_LINK_MAX_BYTES_CEILING,
  UPLOAD_LINK_SECRET_PREFIX,
  principalId as principalIdSchema,
  substratError,
  uploadLinkMintInput,
  uploadLinkPath,
  type AttachmentRecord,
  type AttachmentUploadLinkMintedPayload,
  type AttachmentUploadLinkRedeemedPayload,
  type AttachmentUploadLinkRevokedPayload,
  type CheckSubject,
  type Decision,
  type DomainEventInput,
  type EntityRef,
  type Instant,
  type MintedUploadLink,
  type PermissionKey,
  type PrincipalId,
  type UploadLinkMintInput,
  type UploadLinkPolicy,
  type UploadLinkRecord,
  type UploadLinkView,
  type Visibility,
} from '@substrat-run/contracts';
import { toBase64url } from './base64url.js';
import { capabilityTokenHash } from './capability.js';
import { assertAllowed } from './permission-checker.js';
import type { ScopedSql, SqlValue } from './scope-host.js';
import { ulid } from './ulid.js';

/**
 * The kernel half of upload links — the directory row, the secret and every decision read off
 * them, written ONCE for both adapters (the way `capability.ts` is).
 *
 * An operation mints a link (`ctx.attachments.mintUploadUrl`) and hands the URL to a caller
 * who has no cookie and no bearer. The caller PUTs the bytes; the host redeems the secret
 * through the same attachment write any upload takes. What is different from an upload is
 * only WHO is deciding: the target's `writePermission` is checked as the principal who
 * MINTED the link, at redemption and not only at mint, and that principal is the
 * attachment's author.
 *
 * **Why not a capability.** A capability acts as itself, exchanges for a session and may
 * be used many times; `attachments` refuses its writes by design (#1686). A link is the
 * opposite shape — it never acts, it has no session, and it admits exactly one file. Giving
 * a capability a write mode would have widened what every link share can do.
 *
 * **The secret.** 256 bits from `crypto.getRandomValues`, base64url behind `sbup_`; only its
 * SHA-256 is stored and every lookup is an indexed equality on the hash in SQL, so no secret
 * is ever compared in JavaScript.
 *
 * **Single use is the transaction's, not a flag's.** Redemption marks the row used in the
 * SAME transaction that inserts the attachment row, and the whole thing rolls back together:
 * a redemption that fails for any reason after the link was found — the minter lost the key,
 * the store refused — leaves the link unspent and the caller free to retry within its time
 * box. Two concurrent redemptions are serialized by the scope; the second finds the row
 * used.
 */

declare const crypto: {
  getRandomValues<T extends Uint8Array>(array: T): T;
};

export const UPLOAD_LINK_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_upload_links (
    id TEXT PRIMARY KEY,
    -- SHA-256 hex of the secret. The secret itself is stored NOWHERE.
    token_hash TEXT NOT NULL UNIQUE,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    -- NULL = the uploader names the file.
    filename TEXT,
    max_bytes INTEGER NOT NULL,
    -- JSON array of media types / families, or NULL = any type.
    content_types TEXT,
    visibility TEXT NOT NULL,
    -- The principal the attachment is written AS: its author, and whose \`writePermission\`
    -- is checked again at redemption.
    minted_by TEXT NOT NULL,
    minted_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    redeemed_at TEXT,
    -- The attachment this link produced.
    attachment_id TEXT,
    -- Tombstone, never a delete: a link that was minted is evidence of why a file arrived.
    revoked_at TEXT,
    revoked_by TEXT
  );
  CREATE INDEX IF NOT EXISTS _substrat_upload_links_entity
    ON _substrat_upload_links (entity_type, entity_id);
`;

/** The tables `UPLOAD_LINK_DDL` builds — what a copy of a scope leaves behind. */
export const UPLOAD_LINK_TABLE_NAMES = ['_substrat_upload_links'] as const;

/** `reason` slugs a redemption refuses with, so the HTTP route can answer 410/413/415 and a client can act. */
export const UPLOAD_LINK_GONE = 'upload_link_gone';
export const UPLOAD_LINK_TOO_LARGE = 'upload_link_too_large';
export const UPLOAD_LINK_TYPE_REFUSED = 'upload_link_type_refused';
export const UPLOAD_LINK_WRONG_TARGET = 'upload_link_wrong_target';

interface UploadLinkRow {
  id: string;
  entity_type: string;
  entity_id: string;
  filename: string | null;
  max_bytes: number;
  content_types: string | null;
  visibility: string;
  minted_by: string;
  minted_at: string;
  expires_at: string;
  redeemed_at: string | null;
  attachment_id: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

const COLUMNS =
  'id, entity_type, entity_id, filename, max_bytes, content_types, visibility, minted_by, minted_at, ' +
  'expires_at, redeemed_at, attachment_id, revoked_at, revoked_by';

/** A fresh link secret: 256 bits, base64url, prefixed. Only its hash is ever stored. */
export function mintUploadLinkSecret(): string {
  return UPLOAD_LINK_SECRET_PREFIX + toBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** A secret that cannot be one of ours is refused before it is hashed. */
const plausibleSecret = (secret: unknown): secret is string =>
  typeof secret === 'string' && secret.startsWith(UPLOAD_LINK_SECRET_PREFIX) && secret.length <= 128;

/** Is `type` (already stripped of parameters, lowercase) admitted by `allowed`? `null` admits anything. */
export function uploadContentTypeAllowed(allowed: readonly string[] | null, type: string): boolean {
  if (allowed === null) return true;
  const t = type.toLowerCase();
  return allowed.some((a) => (a.endsWith('/*') ? t.startsWith(a.slice(0, -1)) : a === t));
}

const stateOf = (row: UploadLinkRow, now: Instant): UploadLinkRecord['state'] =>
  row.revoked_at !== null ? 'revoked' : row.redeemed_at !== null ? 'redeemed' : row.expires_at <= now ? 'expired' : 'pending';

function recordOf(row: UploadLinkRow, now: Instant): UploadLinkRecord {
  return {
    id: row.id,
    entity: { entityType: row.entity_type, entityId: row.entity_id },
    filename: row.filename,
    maxBytes: row.max_bytes,
    contentTypes: row.content_types === null ? null : (JSON.parse(row.content_types) as string[]),
    visibility: row.visibility as Visibility,
    mintedBy: principalIdSchema.parse(row.minted_by),
    mintedAt: row.minted_at as Instant,
    expiresAt: row.expires_at as Instant,
    state: stateOf(row, now),
    redeemedAt: row.redeemed_at as Instant | null,
    attachmentId: row.attachment_id,
  };
}

// ---------------------------------------------------------------------------
// ctx.attachments — mint, revoke, list, from inside an operation.
// ---------------------------------------------------------------------------

/** What an operation handler sees as `ctx.attachments`. */
export interface AttachmentVerbs {
  /**
   * Mint a single-use URL that lets its holder upload ONE file to `entity` — and return the
   * secret and the path that carries it, once.
   *
   * The target must declare `uploadLinks` in its `attachmentTargets` entry, and the caller
   * must hold the target's `writePermission` on the entity (the check an upload makes);
   * it is made again, as the same principal, when the link is redeemed. Only a principal may
   * mint. The operation's own guards — an entity lock, a state check — run in the operation,
   * before this; they are not re-run at redemption, so keep `ttlSeconds` short.
   *
   * ```ts
   * assertAllowed(await ctx.check('contract:write', ref));
   * const link = await ctx.attachments.mintUploadUrl({ entity: ref, filename: 'signed.pdf' });
   * return { url: `${origin}${link.path}`, expiresAt: link.expiresAt };
   * ```
   *
   * The same tripwire `ctx.capabilities.mint` has applies: while this invocation runs,
   * `ctx.emit` and `ctx.sql` refuse a record carrying the secret verbatim. Transactional with
   * the operation: a mint whose operation throws never happened.
   */
  mintUploadUrl(input: UploadLinkMintInput): Promise<MintedUploadLink>;
  /** Revoke a link that has not been redeemed. Allowed to anyone who could have minted it. Idempotent. */
  revokeUploadLink(id: string): Promise<void>;
  /** This scope's upload links, newest first — never the secret. What a follow-up operation reads to find the attachment a link produced. */
  uploadLinks(filter?: { entity?: EntityRef; limit?: number }): UploadLinkRecord[];
}

/** What the verbs need of the target's declaration: its write key and its link policy. */
export interface UploadTarget {
  write: PermissionKey;
  uploadLinks?: UploadLinkPolicy;
}

export interface AttachmentVerbDeps {
  /** RAW spine access inside the operation's own transaction. */
  sql: ScopedSql;
  subject: CheckSubject;
  now: Instant;
  /** The operation's OWN check. */
  check: (permission: PermissionKey, entity?: EntityRef) => Promise<Decision>;
  emit: (event: DomainEventInput) => void;
  assertWrites: (verb: string) => void;
  /** This invocation's minted secrets — appended to by `mint`, read by the secret guards. */
  minted: string[];
  /** The declared attachment target for an entity type, if any module declares one. */
  targetOf: (entityType: string) => UploadTarget | undefined;
}

const MS_PER_SECOND = 1000;

function principalOf(subject: CheckSubject, verb: string): PrincipalId {
  if (subject.kind !== 'principal') {
    throw substratError(
      'forbidden',
      `${verb}: only a principal may mint or revoke an upload link — a ${subject.kind} actor has no ` +
        'authorship to lend an attachment',
      { reason: 'upload_link_delegation' },
    );
  }
  return subject.id;
}

export function createAttachmentVerbs(deps: AttachmentVerbDeps): AttachmentVerbs {
  const readRow = (id: string): UploadLinkRow | undefined =>
    deps.sql.query<UploadLinkRow>(`SELECT ${COLUMNS} FROM _substrat_upload_links WHERE id = ?`, [id])[0];

  return {
    async mintUploadUrl(raw) {
      deps.assertWrites('ctx.attachments.mintUploadUrl');
      const minter = principalOf(deps.subject, 'ctx.attachments.mintUploadUrl');
      const input = uploadLinkMintInput.parse(raw);
      const target = deps.targetOf(input.entity.entityType);
      if (!target) {
        throw substratError(
          'validation_failed',
          `ctx.attachments.mintUploadUrl: '${input.entity.entityType}' is not a declared attachment target`,
        );
      }
      const policy = target.uploadLinks;
      if (!policy) {
        throw substratError(
          'forbidden',
          `ctx.attachments.mintUploadUrl: '${input.entity.entityType}' does not declare uploadLinks in its attachmentTargets entry`,
          { reason: 'upload_links_not_declared' },
        );
      }
      const maxBytes = input.maxBytes ?? policy.maxBytes;
      if (maxBytes > policy.maxBytes || maxBytes > UPLOAD_LINK_MAX_BYTES_CEILING) {
        throw substratError(
          'validation_failed',
          `ctx.attachments.mintUploadUrl: maxBytes ${maxBytes} is above the target's ${policy.maxBytes} — a link narrows its target's policy, never widens it`,
        );
      }
      // Delegation, never elevation: the key an upload checks, on the entity, as the caller.
      assertAllowed(await deps.check(target.write, input.entity));

      const id = ulid();
      const secret = mintUploadLinkSecret();
      const expiresAt = new Date(
        Date.parse(deps.now) + (input.ttlSeconds ?? UPLOAD_LINK_DEFAULT_TTL_SECONDS) * MS_PER_SECOND,
      ).toISOString() as Instant;
      const visibility = input.visibility ?? 'internal';
      const contentTypes = policy.contentTypes ?? null;
      deps.sql.exec(
        `INSERT INTO _substrat_upload_links
           (id, token_hash, entity_type, entity_id, filename, max_bytes, content_types, visibility,
            minted_by, minted_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          await capabilityTokenHash(secret),
          input.entity.entityType,
          input.entity.entityId,
          input.filename ?? null,
          maxBytes,
          contentTypes === null ? null : JSON.stringify(contentTypes),
          visibility,
          minter,
          deps.now,
          expiresAt,
        ],
      );
      deps.minted.push(secret);
      const payload: AttachmentUploadLinkMintedPayload = {
        linkId: id,
        entity: input.entity,
        filename: input.filename ?? null,
        maxBytes,
        contentTypes,
        visibility,
        expiresAt,
        mintedBy: minter,
      };
      deps.emit({
        type: ATTACHMENT_UPLOAD_LINK_MINTED,
        schemaVersion: 1,
        entity: input.entity,
        piiClass: 'none',
        payload,
      });
      return {
        id,
        secret,
        path: uploadLinkPath(input.entity, secret),
        expiresAt,
        maxBytes,
        filename: input.filename ?? null,
      };
    },

    async revokeUploadLink(id) {
      deps.assertWrites('ctx.attachments.revokeUploadLink');
      const revoker = principalOf(deps.subject, 'ctx.attachments.revokeUploadLink');
      const row = readRow(id);
      if (!row) throw substratError('not_found', `no upload link ${id} in this scope`);
      const entity = { entityType: row.entity_type, entityId: row.entity_id };
      const target = deps.targetOf(row.entity_type);
      if (target) assertAllowed(await deps.check(target.write, entity));
      // A spent or already-revoked link has nothing left to take back.
      if (row.revoked_at !== null || row.redeemed_at !== null) return;
      deps.sql.exec(`UPDATE _substrat_upload_links SET revoked_at = ?, revoked_by = ? WHERE id = ?`, [
        deps.now,
        revoker,
        id,
      ]);
      const payload: AttachmentUploadLinkRevokedPayload = { linkId: id, entity, revokedBy: revoker };
      deps.emit({
        type: ATTACHMENT_UPLOAD_LINK_REVOKED,
        schemaVersion: 1,
        entity,
        piiClass: 'none',
        payload,
      });
    },

    uploadLinks(filter) {
      const params: SqlValue[] = [];
      let where = '';
      if (filter?.entity) {
        where = 'WHERE entity_type = ? AND entity_id = ?';
        params.push(filter.entity.entityType, filter.entity.entityId);
      }
      const limit = Math.min(Math.max(Math.trunc(filter?.limit ?? 50), 1), 200);
      params.push(limit);
      return deps.sql
        .query<UploadLinkRow>(
          `SELECT ${COLUMNS} FROM _substrat_upload_links ${where} ORDER BY id DESC LIMIT ?`,
          params,
        )
        .map((r) => recordOf(r, deps.now));
    },
  };
}

// ---------------------------------------------------------------------------
// Redemption — the host's half. A secret in, an attachment out.
// ---------------------------------------------------------------------------

/** One answer for every secret that is not ours or names nothing, so a probe learns nothing it can act on. */
const unknownLink = () => substratError('not_found', 'This upload link is not valid.');
/** The 410: it was ours, and it is spent, expired or revoked. Said only to a holder of the secret. */
const goneLink = () =>
  substratError('conflict', 'This upload link has been used, has expired or was revoked.', { reason: UPLOAD_LINK_GONE });

async function liveRow(sql: ScopedSql, now: Instant, secret: unknown): Promise<UploadLinkRow> {
  if (!plausibleSecret(secret)) throw unknownLink();
  const row = sql.query<UploadLinkRow>(
    `SELECT ${COLUMNS} FROM _substrat_upload_links WHERE token_hash = ?`,
    [await capabilityTokenHash(secret)],
  )[0];
  if (!row) throw unknownLink();
  if (stateOf(row, now) !== 'pending') throw goneLink();
  return row;
}

/** What the route needs before it reads a byte, and who the write is made as. */
export interface UploadLinkInspection {
  view: UploadLinkView;
  mintedBy: PrincipalId;
}

/**
 * Look a secret up without spending it: `not_found` for one that names nothing, `conflict`
 * with reason `upload_link_gone` for one that is used, expired or revoked.
 */
export async function inspectUploadLink(
  deps: { sql: ScopedSql; now: Instant },
  secret: unknown,
): Promise<UploadLinkInspection> {
  const row = await liveRow(deps.sql, deps.now, secret);
  const r = recordOf(row, deps.now);
  return {
    view: {
      entity: r.entity,
      filename: r.filename,
      maxBytes: r.maxBytes,
      contentTypes: r.contentTypes,
      visibility: r.visibility,
    },
    mintedBy: r.mintedBy,
  };
}

/**
 * Spend the link for `record`, INSIDE the transaction that inserts the attachment row — so a
 * refusal anywhere rolls the spend back. Judges the record against the link, never the other
 * way round: the target, the author, the size and the type are all the link's to refuse.
 */
export async function redeemUploadLinkInTransaction(
  deps: {
    sql: ScopedSql;
    now: Instant;
    emit: (event: DomainEventInput) => void;
  },
  secret: unknown,
  record: AttachmentRecord,
): Promise<void> {
  const row = await liveRow(deps.sql, deps.now, secret);
  if (row.entity_type !== record.entity.entityType || row.entity_id !== record.entity.entityId) {
    // The path named another entity than the link was minted for: nothing is spent.
    throw substratError('not_found', 'This upload link is not valid for that target.', {
      reason: UPLOAD_LINK_WRONG_TARGET,
    });
  }
  if (record.createdBy !== row.minted_by) {
    throw substratError('internal', 'an upload link was redeemed as someone other than its minter');
  }
  if (record.size > row.max_bytes) {
    throw substratError('validation_failed', `The file is ${record.size} bytes; this link admits at most ${row.max_bytes}.`, {
      reason: UPLOAD_LINK_TOO_LARGE,
    });
  }
  const allowed = row.content_types === null ? null : (JSON.parse(row.content_types) as string[]);
  if (!uploadContentTypeAllowed(allowed, record.contentType)) {
    throw substratError('validation_failed', `A file of type ${record.contentType} is not admitted by this link.`, {
      reason: UPLOAD_LINK_TYPE_REFUSED,
    });
  }
  if (row.filename !== null && record.filename !== row.filename) {
    throw substratError('internal', 'an upload link with a fixed file name was redeemed under another');
  }
  const spent = deps.sql.exec(
    `UPDATE _substrat_upload_links SET redeemed_at = ?, attachment_id = ?
     WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL`,
    [deps.now, record.id, row.id],
  );
  if (spent.changes !== 1) throw goneLink();
  const payload: AttachmentUploadLinkRedeemedPayload = {
    linkId: row.id,
    entity: record.entity,
    attachmentId: record.id,
    size: record.size,
    sha256: record.sha256,
    mintedBy: principalIdSchema.parse(row.minted_by),
  };
  deps.emit({
    type: ATTACHMENT_UPLOAD_LINK_REDEEMED,
    schemaVersion: 1,
    entity: record.entity,
    piiClass: 'none',
    payload,
  });
}
