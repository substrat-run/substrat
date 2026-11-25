import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import type { SqlExec } from '../src/introspect.js';
import { nextPruneDue, pruneExpired, pruneSettingsOf, type PruneKind } from '../src/expiry-prune.js';

/**
 * K-71's first half: what has expired is deleted, and nothing a live session or token still
 * needs is. Rows are planted in SQL at exact times, so each boundary is a millisecond apart.
 * Foreign keys are ON, as a Durable Object's are: a guard that let `session_id`'s
 * `ON DELETE SET NULL` fire would show as a token whose session went missing.
 */

const NOW = Date.UTC(2026, 10, 25, 12);
const GRACE = 60 * 60_000;
const CUT = NOW - GRACE;
const LATER = NOW + 7 * 24 * 60 * 60_000;

let db: Database.Database;
let sql: SqlExec;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  sql = {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      const rows = stmt.reader ? (stmt.all(...(bindings as [])) as Record<string, unknown>[]) : (stmt.run(...(bindings as [])), []);
      return { columnNames: [], toArray: () => rows, raw: () => [][Symbol.iterator]() };
    },
  };
  db.prepare(`INSERT INTO user (id, name, email) VALUES ('u1', 'Ada', 'ada@example.com')`).run();
  db.prepare(`INSERT INTO oauth_client (id, client_id, redirect_uris) VALUES ('c1', 'client-1', '[]')`).run();
});

const session = (id: string, expires: number) =>
  db.prepare(`INSERT INTO session (id, expires_at, token, updated_at, user_id) VALUES (?, ?, ?, 0, 'u1')`).run(id, expires, `tok-${id}`);
const refresh = (id: string, expires: number, extra: { session?: string; replayUntil?: number } = {}) =>
  db.prepare(`INSERT INTO oauth_refresh_token (id, token, client_id, session_id, user_id, expires_at, created_at, rotation_replay_expires_at, scopes)
              VALUES (?, ?, 'client-1', ?, 'u1', ?, 0, ?, '[]')`).run(id, `rt-${id}`, extra.session ?? null, expires, extra.replayUntil ?? null);
const access = (id: string, expires: number, extra: { session?: string; refresh?: string } = {}) =>
  db.prepare(`INSERT INTO oauth_access_token (id, token, client_id, session_id, user_id, refresh_id, expires_at, created_at, scopes)
              VALUES (?, ?, 'client-1', ?, 'u1', ?, ?, 0, '[]')`).run(id, `at-${id}`, extra.session ?? null, extra.refresh ?? null, expires);
const verification = (id: string, expires: number) =>
  db.prepare(`INSERT INTO verification (id, identifier, value, expires_at) VALUES (?, ?, 'v', ?)`).run(id, `k-${id}`, expires);
const assertion = (id: string, expires: number) =>
  db.prepare(`INSERT INTO oauth_client_assertion (id, expires_at) VALUES (?, ?)`).run(id, expires);

const ids = (table: PruneKind): string[] =>
  (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map((r) => r.id);

describe('expired-row prune', () => {
  it.each<[PruneKind, (id: string, expires: number) => unknown]>([
    ['session', session],
    ['oauth_access_token', access],
    ['oauth_refresh_token', refresh],
    ['verification', verification],
    ['oauth_client_assertion', assertion],
  ])('%s: one millisecond past the grace goes, the cut itself stays; `count` deletes nothing', (kind, plant) => {
    plant('past', CUT - 1);
    plant('at-cut', CUT);
    plant('expired-in-grace', NOW - 1);
    plant('live', LATER);
    const counted = pruneExpired(sql, NOW, { mode: 'count', graceMs: GRACE });
    expect(counted.counts[kind]).toBe(1);
    expect(ids(kind)).toHaveLength(4);
    const pruned = pruneExpired(sql, NOW, { mode: 'on', graceMs: GRACE });
    expect(pruned.counts[kind]).toBe(1);
    expect(ids(kind)).toEqual(['at-cut', 'expired-in-grace', 'live']);
  });

  it('keeps an expired session while a live token names it, and never nulls the token\'s session', () => {
    session('s-access', CUT - 1);
    access('a-live', LATER, { session: 's-access' });
    session('s-refresh', CUT - 1);
    refresh('r-live', LATER, { session: 's-refresh' });
    pruneExpired(sql, NOW, { mode: 'on', graceMs: GRACE });
    expect(ids('session')).toEqual(['s-access', 's-refresh']);
    expect(db.prepare(`SELECT session_id FROM oauth_access_token`).get()).toEqual({ session_id: 's-access' });
    expect(db.prepare(`SELECT session_id FROM oauth_refresh_token`).get()).toEqual({ session_id: 's-refresh' });
  });

  it('keeps an expired refresh token while a live access token names it or its replay window is open', () => {
    refresh('r-named', CUT - 1);
    access('a-live', LATER, { refresh: 'r-named' });
    refresh('r-replay', CUT - 1, { replayUntil: NOW });
    pruneExpired(sql, NOW, { mode: 'on', graceMs: GRACE });
    expect(ids('oauth_refresh_token')).toEqual(['r-named', 'r-replay']);
  });

  it('takes a whole expired chain — access, its refresh, their session — in one run', () => {
    session('s1', CUT - 3);
    refresh('r1', CUT - 2, { session: 's1' });
    access('a1', CUT - 1, { session: 's1', refresh: 'r1' });
    const { counts } = pruneExpired(sql, NOW, { mode: 'on', graceMs: GRACE });
    expect(counts).toMatchObject({ oauth_access_token: 1, oauth_refresh_token: 1, session: 1 });
  });

  it('stops at its bound, says so, and the next run finishes the rest', () => {
    for (let i = 0; i < 5; i++) verification(`v${i}`, CUT - 10 + i);
    const first = pruneExpired(sql, NOW, { mode: 'on', graceMs: GRACE, batch: 2, maxBatches: 2 });
    expect(first).toMatchObject({ more: true, counts: { verification: 4 } });
    expect(ids('verification')).toEqual(['v4']);
    const second = pruneExpired(sql, NOW, { mode: 'on', graceMs: GRACE, batch: 2, maxBatches: 2 });
    expect(second).toMatchObject({ more: false, counts: { verification: 1 } });
    expect(pruneExpired(sql, NOW, { mode: 'on', graceMs: GRACE }).counts.verification).toBe(0);
  });

  it('arms for the earliest row not yet deletable, a held session waiting on its token, and for nothing when nothing expires', () => {
    expect(nextPruneDue(sql, NOW, GRACE)).toBeNull();
    session('s-held', CUT - 1);
    access('a-live', NOW + 5_000, { session: 's-held' });
    verification('v-later', NOW + 60_000);
    expect(nextPruneDue(sql, NOW, GRACE)).toBe(NOW + 5_000 + GRACE);
  });

  it('reads its settings off the issuer config: off and 24 hours unless set, a bad grace is the default', () => {
    expect(pruneSettingsOf({})).toEqual({ mode: 'off', graceMs: 24 * 3_600_000 });
    expect(pruneSettingsOf({ PRUNE_EXPIRED: ' Count ', PRUNE_GRACE_HOURS: '0' })).toEqual({ mode: 'count', graceMs: 0 });
    expect(pruneSettingsOf({ PRUNE_EXPIRED: 'yes', PRUNE_GRACE_HOURS: '-1' })).toEqual({ mode: 'off', graceMs: 24 * 3_600_000 });
  });
});
