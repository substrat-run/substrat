import {
  connectLink,
  type ConnectLink,
  type ConnectLinkConsume,
  type ConnectLinkRefusal,
} from '@substrat-run/contracts';
import type { RedactionSql } from './subject-redaction.js';

/**
 * The platform-held connect link (connections.md §3.5.4), as statements both adapters run
 * against their directory — the SQLite host over better-sqlite3, the hosted one inside
 * ControlPlaneDO — so the lifecycle is written once, the way the findings store is.
 *
 * A vertical mints one to be MAILED: a bookkeeping bureau's staff send it to a client
 * company's Fortnox administrator, who opens it days later. A signature alone cannot be
 * withdrawn and cannot be spent, which is what §3.5.3's in-session URL gets away with by
 * living minutes; a link living a week cannot. So the signed state names this row, and the
 * row decides: outstanding and unexpired opens, anything else refuses.
 *
 * Every read and write is keyed by (tenant, scope, id). A link of another scope or tenant
 * is not a forbidden row — it is an absent one, and answers exactly as `unknown` does.
 *
 * Expiry is judged against the `now` the caller passes: the pure host's clock, or the
 * coordinator's wall clock on the hosted one. ISO 8601 UTC text on both sides, so a string
 * comparison is a chronological one.
 */
export const CONNECT_LINKS_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_connect_links (
    id            TEXT PRIMARY KEY,
    tenant_id     TEXT NOT NULL,
    scope_id      TEXT NOT NULL,
    vertical      TEXT NOT NULL,
    provider      TEXT NOT NULL,
    status        TEXT NOT NULL,
    created_by    TEXT NOT NULL,
    subject_ref   TEXT,
    return_url    TEXT,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    used_at       TEXT,
    account_ref   TEXT,
    account_label TEXT
  );
  CREATE INDEX IF NOT EXISTS _substrat_connect_links_scope
    ON _substrat_connect_links (tenant_id, scope_id, created_at);
`;

/** Named, never `*`: the row a read returns is the shape below, whatever the table grows. */
const COLUMNS =
  'id, tenant_id, scope_id, vertical, provider, status, created_by, subject_ref, return_url, ' +
  'created_at, expires_at, used_at, account_ref, account_label';

interface ConnectLinkRow {
  id: string;
  tenant_id: string;
  scope_id: string;
  vertical: string;
  provider: string;
  status: string;
  created_by: string;
  subject_ref: string | null;
  return_url: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  account_ref: string | null;
  account_label: string | null;
}

const toConnectLink = (r: ConnectLinkRow): ConnectLink =>
  connectLink.parse({
    id: r.id,
    tenantId: r.tenant_id,
    scopeId: r.scope_id,
    vertical: r.vertical,
    provider: r.provider,
    status: r.status,
    createdBy: r.created_by,
    subjectRef: r.subject_ref,
    returnUrl: r.return_url,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    accountRef: r.account_ref,
    accountLabel: r.account_label,
  });

export interface ConnectLinkKeyRow {
  tenantId: string;
  scopeId: string;
  id: string;
}

const readRow = (sql: RedactionSql, key: ConnectLinkKeyRow): ConnectLinkRow | undefined =>
  sql(`SELECT ${COLUMNS} FROM _substrat_connect_links WHERE id = ? AND tenant_id = ? AND scope_id = ?`, [
    key.id,
    key.tenantId,
    key.scopeId,
  ])[0] as ConnectLinkRow | undefined;

export function insertConnectLink(
  sql: RedactionSql,
  row: {
    id: string;
    tenantId: string;
    scopeId: string;
    vertical: string;
    provider: string;
    createdBy: string;
    subjectRef: string | null;
    returnUrl: string | null;
    createdAt: string;
    expiresAt: string;
  },
): ConnectLink {
  const inserted = sql(
    `INSERT INTO _substrat_connect_links
       (id, tenant_id, scope_id, vertical, provider, status, created_by, subject_ref, return_url,
        created_at, expires_at, used_at, account_ref, account_label)
     VALUES (?, ?, ?, ?, ?, 'outstanding', ?, ?, ?, ?, ?, NULL, NULL, NULL)
     RETURNING ${COLUMNS}`,
    [
      row.id,
      row.tenantId,
      row.scopeId,
      row.vertical,
      row.provider,
      row.createdBy,
      row.subjectRef,
      row.returnUrl,
      row.createdAt,
      row.expiresAt,
    ],
  )[0] as ConnectLinkRow;
  return toConnectLink(inserted);
}

export function readConnectLink(sql: RedactionSql, key: ConnectLinkKeyRow): ConnectLink | undefined {
  const row = readRow(sql, key);
  return row ? toConnectLink(row) : undefined;
}

export function listConnectLinks(
  sql: RedactionSql,
  filter: { tenantId: string; scopeId?: string; provider?: string; outstandingOnly?: boolean },
  now: string,
): ConnectLink[] {
  const where = ['tenant_id = ?'];
  const params: string[] = [filter.tenantId];
  if (filter.scopeId) (where.push('scope_id = ?'), params.push(filter.scopeId));
  if (filter.provider) (where.push('provider = ?'), params.push(filter.provider));
  if (filter.outstandingOnly) (where.push(`status = 'outstanding' AND expires_at > ?`), params.push(now));
  return (
    sql(
      `SELECT ${COLUMNS} FROM _substrat_connect_links WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC`,
      params,
    ) as ConnectLinkRow[]
  ).map(toConnectLink);
}

/**
 * Withdraw an outstanding link. Idempotent, and only an outstanding row moves: a used link
 * has already been spent (its connection is what to disconnect), and a revoked one stays
 * revoked. `undefined` when no such link exists in this scope; `changed` says whether this
 * call is the one that revoked it, so a no-op is not audited.
 */
export function revokeConnectLinkRow(
  sql: RedactionSql,
  key: ConnectLinkKeyRow,
): { link: ConnectLink; changed: boolean } | undefined {
  const moved = sql(
    `UPDATE _substrat_connect_links SET status = 'revoked'
     WHERE id = ? AND tenant_id = ? AND scope_id = ? AND status = 'outstanding'
     RETURNING ${COLUMNS}`,
    [key.id, key.tenantId, key.scopeId],
  )[0] as ConnectLinkRow | undefined;
  if (moved) return { link: toConnectLink(moved), changed: true };
  const row = readRow(sql, key);
  return row ? { link: toConnectLink(row), changed: false } : undefined;
}

/**
 * Spend a link — the callback's act, BEFORE it stores the credential, so of two racing
 * callbacks exactly one gets past it. Single-use is decided by the UPDATE's WHERE, not by
 * the read in front of it: the read only picks which refusal to answer with.
 */
export function consumeConnectLinkRow(
  sql: RedactionSql,
  input: ConnectLinkKeyRow & { provider: string; accountRef?: string; accountLabel?: string },
  now: string,
): ConnectLinkConsume {
  const row = readRow(sql, input);
  const refuse = (reason: ConnectLinkRefusal): ConnectLinkConsume => ({ ok: false, reason });
  // A link minted for another provider is not this round's link at all.
  if (!row || row.provider !== input.provider) return refuse('unknown');
  if (row.status === 'used') return refuse('used');
  if (row.status === 'revoked') return refuse('revoked');
  if (row.expires_at <= now) return refuse('expired');
  const spent = sql(
    `UPDATE _substrat_connect_links SET status = 'used', used_at = ?, account_ref = ?, account_label = ?
     WHERE id = ? AND tenant_id = ? AND scope_id = ? AND status = 'outstanding' AND expires_at > ?
     RETURNING ${COLUMNS}`,
    [now, input.accountRef ?? null, input.accountLabel ?? null, input.id, input.tenantId, input.scopeId, now],
  )[0] as ConnectLinkRow | undefined;
  return spent ? { ok: true, link: toConnectLink(spent) } : refuse('used');
}

/**
 * The compensating half of consume: the callback spent the link, then failed to store the
 * credential, so nothing was connected and the link goes back to outstanding — a platform
 * hiccup costs a retry, not a fresh link mailed to a client. Only a `used` row moves (a
 * revocation is never undone by this), and only an unexpired one: a link that lapsed while
 * the store failed stays spent rather than coming back already dead.
 */
export function restoreConnectLinkRow(
  sql: RedactionSql,
  key: ConnectLinkKeyRow,
  now: string,
): ConnectLink | undefined {
  const restored = sql(
    `UPDATE _substrat_connect_links
     SET status = 'outstanding', used_at = NULL, account_ref = NULL, account_label = NULL
     WHERE id = ? AND tenant_id = ? AND scope_id = ? AND status = 'used' AND expires_at > ?
     RETURNING ${COLUMNS}`,
    [key.id, key.tenantId, key.scopeId, now],
  )[0] as ConnectLinkRow | undefined;
  return restored ? toConnectLink(restored) : undefined;
}
