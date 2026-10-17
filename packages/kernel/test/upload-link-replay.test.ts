/**
 * The replay window and the replay's lookup (#2315), against a real SQLite with an injected `now`
 * — what a Durable Object cannot take (#956), so the contract suite holds the rest on both
 * adapters and this holds the edges: the far end of the window, the condemned id, what the spend
 * records, and a malformed key judged before the lookup.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  UPLOAD_LINK_REPLAY_GRACE_SECONDS,
  principalId,
  type AttachmentRecord,
  type Instant,
} from '@substrat-run/contracts';
import { ATTACHMENT_CONDEMNED_DDL } from '../src/attachment-sweep.js';
import { capabilityTokenHash } from '../src/capability.js';
import type { ScopedSql, SqlValue } from '../src/scope-host.js';
import { ulid } from '../src/ulid.js';
import {
  UPLOAD_LINK_DDL,
  UPLOAD_LINK_GONE,
  inspectUploadLink,
  mintUploadLinkSecret,
  redeemUploadLinkInTransaction,
} from '../src/upload-link.js';

const ATTACHMENTS_DDL = `CREATE TABLE _substrat_attachments (
  id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, filename TEXT NOT NULL,
  content_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, visibility TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL)`;

const MINTED = Date.parse('2026-10-17T10:00:00.000Z');
const TTL_MS = 600_000;
const GRACE_MS = UPLOAD_LINK_REPLAY_GRACE_SECONDS * 1000;
const at = (ms: number): Instant => new Date(ms).toISOString() as Instant;
const minter = principalId.parse(ulid());
const entity = { entityType: 'doc', entityId: 'd1' };
const KEY = 'a-key-of-the-redeemer-0001';

const reasonOf = (e: unknown): unknown => (e as { extensions?: { reason?: unknown } }).extensions?.reason;
const refusal = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

async function scope() {
  const db = new DatabaseSync(':memory:');
  db.exec(UPLOAD_LINK_DDL);
  db.exec(ATTACHMENTS_DDL);
  db.exec(ATTACHMENT_CONDEMNED_DDL);
  const sql: ScopedSql = {
    query: <T>(q: string, params: readonly SqlValue[] = []) => db.prepare(q).all(...(params as never[])) as T[],
    exec: (q: string, params: readonly SqlValue[] = []) => ({
      changes: Number(db.prepare(q).run(...(params as never[])).changes),
    }),
  };
  const secret = mintUploadLinkSecret();
  const linkId = ulid();
  db.prepare(
    `INSERT INTO _substrat_upload_links
       (id, token_hash, entity_type, entity_id, filename, max_bytes, content_types, visibility, minted_by, minted_at, expires_at)
     VALUES (?, ?, 'doc', 'd1', NULL, 64, NULL, 'internal', ?, ?, ?)`,
  ).run(linkId, await capabilityTokenHash(secret), minter, at(MINTED), at(MINTED + TTL_MS));
  /** The attachment write and the spend, as an adapter makes them: one transaction, at `ms`. */
  const redeem = async (ms: number, idempotencyKey?: string): Promise<AttachmentRecord> => {
    const record: AttachmentRecord = {
      id: ulid(),
      entity,
      filename: 'a.txt',
      contentType: 'text/plain',
      size: 5,
      sha256: '0'.repeat(64),
      visibility: 'internal',
      createdBy: minter,
      createdAt: at(ms),
    };
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO _substrat_attachments VALUES (?, 'doc', 'd1', 'a.txt', 'text/plain', 5, ?, 'internal', ?, ?)`).run(
        record.id,
        record.sha256,
        minter,
        record.createdAt,
      );
      await redeemUploadLinkInTransaction({ sql, now: at(ms), emit: () => {} }, secret, record, idempotencyKey);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return record;
  };
  const inspect = (ms: number, key?: string) => inspectUploadLink({ sql, now: at(ms) }, secret, entity, key);
  return { db, secret, redeem, inspect };
}

describe('the replay window (#2315)', () => {
  it('replays up to the expiry plus the grace, and not one millisecond after', async () => {
    const s = await scope();
    // Redeemed in the link's last second: the retry lands after the expiry, inside the grace.
    const record = await s.redeem(MINTED + TTL_MS - 1000, KEY);
    expect((await s.inspect(MINTED + TTL_MS + 1, KEY)).replay).toEqual(record);
    expect((await s.inspect(MINTED + TTL_MS + GRACE_MS - 1, KEY)).replay).toEqual(record);
    expect(reasonOf(await refusal(s.inspect(MINTED + TTL_MS + GRACE_MS, KEY)))).toBe(UPLOAD_LINK_GONE);
  });

  it('past the window is the same refusal as no key at all', async () => {
    const s = await scope();
    await s.redeem(MINTED + 1000, KEY);
    const late = await refusal(s.inspect(MINTED + TTL_MS + GRACE_MS, KEY));
    const none = await refusal(s.inspect(MINTED + 2000));
    expect((late as Error).message).toBe((none as Error).message);
    expect((late as { extensions?: unknown }).extensions).toEqual((none as { extensions?: unknown }).extensions);
  });
});

describe('the replay lookup (#2315)', () => {
  it('records the hash of the key, never the key; a spend without a key records NULL', async () => {
    const s = await scope();
    await s.redeem(MINTED + 1000, KEY);
    const row = s.db.prepare('SELECT * FROM _substrat_upload_links').get() as Record<string, unknown>;
    expect(row.redeemed_key_hash).toBe(await capabilityTokenHash(KEY));
    expect(JSON.stringify(row)).not.toContain(KEY);

    const t = await scope();
    await t.redeem(MINTED + 1000);
    expect((t.db.prepare('SELECT redeemed_key_hash FROM _substrat_upload_links').get() as Record<string, unknown>).redeemed_key_hash).toBeNull();
    expect(reasonOf(await refusal(t.inspect(MINTED + 2000, KEY)))).toBe(UPLOAD_LINK_GONE);
  });

  it('an attachment the orphan sweep condemned is never replayed, even with its row present', async () => {
    const s = await scope();
    const record = await s.redeem(MINTED + 1000, KEY);
    expect((await s.inspect(MINTED + 2000, KEY)).replay).toEqual(record);
    s.db.prepare('INSERT INTO _substrat_attachment_condemned (id, condemned_at) VALUES (?, ?)').run(record.id, at(MINTED + 1500));
    expect(reasonOf(await refusal(s.inspect(MINTED + 2000, KEY)))).toBe(UPLOAD_LINK_GONE);
  });

  it('a pending link with a key is no replay: the inspection carries none, and the spend stays the transaction’s', async () => {
    const s = await scope();
    expect((await s.inspect(MINTED + 1000, KEY)).replay).toBeUndefined();
    await s.redeem(MINTED + 1000, KEY);
    // A second spend with the same key is still refused: a key never re-opens a link.
    expect(reasonOf(await refusal(s.redeem(MINTED + 2000, KEY)))).toBe(UPLOAD_LINK_GONE);
    expect((s.db.prepare('SELECT count(*) AS n FROM _substrat_attachments').get() as { n: number }).n).toBe(1);
  });

  it('a malformed key is validation_failed before the lookup: the same answer for a secret that names nothing', async () => {
    const s = await scope();
    for (const bad of ['short', 'x'.repeat(256), 'with space-in-the-key', 'tab\tin-the-key-here', 'a"quote-in-the-key', 'a\\backslash-in-the-key']) {
      const known = await refusal(s.inspect(MINTED + 1000, bad));
      const unknown = await refusal(inspectUploadLink({ sql: { query: () => [], exec: () => ({ changes: 0 }) }, now: at(MINTED) }, mintUploadLinkSecret(), entity, bad));
      expect((known as { code?: unknown }).code, bad).toBe('validation_failed');
      expect((unknown as Error).message).toBe((known as Error).message);
    }
    // The bounds themselves are keys.
    for (const good of ['x'.repeat(16), 'x'.repeat(255), '01JABCDEFGHJKMNPQRSTVWXYZ0', '8e03978e-40d5-43e8-bc93-6894a57f9324']) {
      expect((await s.inspect(MINTED + 1000, good)).replay, good).toBeUndefined();
    }
  });
});
