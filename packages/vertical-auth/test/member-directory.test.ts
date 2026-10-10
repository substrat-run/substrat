/**
 * The invite half of the identity directory (#1150, #1686), against a real SQLite through the
 * same `exec` seam the IdentityDO's storage has — the rules behind `inviteMatches`,
 * `claimInviteByCapability`, the legacy `claimInvite`, `revokeInvite` and the column migration.
 * Each refusal is paired with the case that goes through.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  INVITE_DDL,
  MEMBER_DIRECTORY_DDL,
  claimInvite,
  claimInviteByCapability,
  createInvite,
  getInvite,
  inviteExists,
  inviteMatches,
  listInvites,
  migrateInvites,
  revokeInvite,
} from '../src/member-directory.js';
import { migrateOwnerSeat, resolvePrincipal } from '../src/owner-seat.js';
import type { RegistrySql } from '../src/site-registry.js';

const SCOPE = '01SCOPEDESK';
const OTHER_SCOPE = '01SCOPEOTHER';
const ANN = '01PRINCIPALANN';
const BOB = '01PRINCIPALBOB';
const CAP = '01CAPABILITYANN';
const NOW = Date.UTC(2026, 9, 9);

function sqlOver(db: InstanceType<typeof Database>): RegistrySql {
  return {
    exec(query, ...params) {
      const stmt = db.prepare(query);
      if (stmt.reader) return stmt.all(...(params as never[])) as Record<string, unknown>[];
      stmt.run(...(params as never[]));
      return [];
    },
  };
}

let sql: RegistrySql;
beforeEach(() => {
  const db = new Database(':memory:');
  for (const stmt of MEMBER_DIRECTORY_DDL) db.exec(stmt);
  sql = sqlOver(db);
  migrateOwnerSeat(sql);
  migrateInvites(sql);
});

describe('a capability-era invite (#1686)', () => {
  beforeEach(() => createInvite(sql, SCOPE, ANN, 'editor', 'ann@acme.example', 'hash-ann', CAP));

  it('matches its secret\'s hash while open — and nothing else, in no other scope', () => {
    expect(inviteMatches(sql, SCOPE, 'hash-ann')).toBe(true);
    expect(inviteMatches(sql, SCOPE, 'hash-other')).toBe(false);
    expect(inviteMatches(sql, OTHER_SCOPE, 'hash-ann')).toBe(false);
  });

  it('binds once, for the capability AND the principal it names, then is consumed', () => {
    expect(claimInviteByCapability(sql, SCOPE, 'sub-ann', CAP, ANN)).toBe(ANN);
    expect(resolvePrincipal(sql, SCOPE, 'sub-ann', NOW)).toBe(ANN);
    expect(inviteMatches(sql, SCOPE, 'hash-ann')).toBe(false);
    expect(claimInviteByCapability(sql, SCOPE, 'sub-eve', CAP, ANN)).toBeNull();
    expect(resolvePrincipal(sql, SCOPE, 'sub-eve', NOW)).toBeNull();
    expect(listInvites(sql, SCOPE)).toEqual([]);
  });

  it('refuses another capability id, another principal, or another scope — binding nobody', () => {
    expect(claimInviteByCapability(sql, SCOPE, 'sub-x', '01CAPABILITYEVE', ANN)).toBeNull();
    expect(claimInviteByCapability(sql, SCOPE, 'sub-x', CAP, BOB)).toBeNull();
    expect(claimInviteByCapability(sql, OTHER_SCOPE, 'sub-x', CAP, ANN)).toBeNull();
    expect(resolvePrincipal(sql, SCOPE, 'sub-x', NOW)).toBeNull();
    expect(inviteMatches(sql, SCOPE, 'hash-ann')).toBe(true); // still open
  });

  it('is never accepted through the legacy hash path, even with the right hash', () => {
    expect(claimInvite(sql, SCOPE, 'sub-ann', 'hash-ann')).toBeNull();
    expect(resolvePrincipal(sql, SCOPE, 'sub-ann', NOW)).toBeNull();
    expect(inviteMatches(sql, SCOPE, 'hash-ann')).toBe(true);
  });

  it('withdrawing it answers the capability to revoke, and a later accept finds nothing', () => {
    expect(revokeInvite(sql, SCOPE, ANN)).toBe(CAP);
    expect(inviteMatches(sql, SCOPE, 'hash-ann')).toBe(false);
    expect(claimInviteByCapability(sql, SCOPE, 'sub-ann', CAP, ANN)).toBeNull();
    expect(revokeInvite(sql, SCOPE, ANN)).toBeNull(); // nothing open any more
  });

  it('reads as it always did: listed, fetched and gated by its hash, never its token', () => {
    expect(listInvites(sql, SCOPE)).toEqual([
      { principal: ANN, roleKey: 'editor', email: 'ann@acme.example', createdAt: expect.any(Number), capabilityId: CAP },
    ]);
    expect(getInvite(sql, SCOPE, ANN)).toMatchObject({ principal: ANN, roleKey: 'editor' });
    expect(inviteExists(sql, SCOPE, 'hash-ann')).toBe(true);
  });
});

describe('a legacy invite — minted before #1686, by hash alone', () => {
  beforeEach(() => createInvite(sql, SCOPE, BOB, 'editor', null, 'hash-bob'));

  it('still accepts by its hash, once', () => {
    expect(claimInvite(sql, SCOPE, 'sub-bob', 'hash-bob')).toBe(BOB);
    expect(resolvePrincipal(sql, SCOPE, 'sub-bob', NOW)).toBe(BOB);
    expect(claimInvite(sql, SCOPE, 'sub-eve', 'hash-bob')).toBeNull();
  });

  it('is no capability invite: it never matches, and no capability binds it', () => {
    expect(inviteMatches(sql, SCOPE, 'hash-bob')).toBe(false);
    expect(claimInviteByCapability(sql, SCOPE, 'sub-bob', CAP, BOB)).toBeNull();
  });

  it('withdrawing it answers no capability, and it accepts no more', () => {
    expect(revokeInvite(sql, SCOPE, BOB)).toBeNull();
    expect(claimInvite(sql, SCOPE, 'sub-bob', 'hash-bob')).toBeNull();
  });
});

describe('migrateInvites', () => {
  it('adds capability_id to a table from before it — its rows read as legacy — and is idempotent', () => {
    const db = new Database(':memory:');
    const old = sqlOver(db);
    for (const stmt of MEMBER_DIRECTORY_DDL.filter((s) => !INVITE_DDL.includes(s))) db.exec(stmt);
    // The `invite` table exactly as #1150 shipped it.
    db.exec(`CREATE TABLE invite (
      token_hash TEXT PRIMARY KEY, scope_id TEXT NOT NULL, principal TEXT NOT NULL,
      role_key TEXT NOT NULL, email TEXT, claimed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))`);
    db.prepare('INSERT INTO invite (token_hash, scope_id, principal, role_key) VALUES (?, ?, ?, ?)').run('hash-old', SCOPE, BOB, 'editor');
    migrateInvites(old);
    migrateInvites(old);
    expect(claimInvite(old, SCOPE, 'sub-bob', 'hash-old')).toBe(BOB);
    createInvite(old, SCOPE, ANN, 'editor', null, 'hash-new', CAP);
    expect(inviteMatches(old, SCOPE, 'hash-new')).toBe(true);
  });
});
