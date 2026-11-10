/**
 * The invite half of the identity directory (#1150, #1686), against a real SQLite through the
 * same `exec` seam the IdentityDO's storage has — the rules behind `inviteMatches`,
 * `claimInviteByCapability`, the legacy `claimInvite`, `revokeInvite` and the column migration,
 * and the address an invite names (K-61 phase 3): who may spend its link, and whom it admits.
 * Each refusal is paired with the case that goes through.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  INVITE_DDL,
  MEMBER_DIRECTORY_DDL,
  admitInvite,
  claimInvite,
  claimInviteByCapability,
  countLegacyInvites,
  createInvite,
  createLegacyInvite,
  getInvite,
  inviteExists,
  inviteMatches,
  listInvites,
  migrateInvites,
  openInviteFor,
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

describe('the address an invite names (K-61 phase 3)', () => {
  beforeEach(() => createInvite(sql, SCOPE, ANN, 'editor', 'Ann@Acme.example', 'hash-ann', CAP));

  it.each([
    ['the invited address, in any case', ' ann@acme.EXAMPLE ', true],
    ['another verified address', 'eve@acme.example', false],
    ['no verified address', null, false],
  ])('a link matches a session holding %s: %s', (_label, verified, matches) => {
    expect(inviteMatches(sql, SCOPE, 'hash-ann', verified)).toBe(matches);
  });

  it('compares Unicode-normalised: a composed and a decomposed accent are one address', () => {
    const composed = `jos${String.fromCodePoint(0xe9)}@acme.example`;
    const decomposed = `jose${String.fromCodePoint(0x301)}@acme.example`;
    createInvite(sql, SCOPE, BOB, 'editor', composed, 'hash-jose', '01CAPABILITYJOSE');
    expect(inviteMatches(sql, SCOPE, 'hash-jose', decomposed)).toBe(true);
    expect(openInviteFor(sql, SCOPE, decomposed)).toEqual({ principal: BOB, capabilityId: '01CAPABILITYJOSE' });
  });

  it('lowercases ASCII only: two letters a full lowercase would merge stay two addresses', () => {
    // U+03F4 (the theta symbol) and U+03B8 (small theta) are distinct, and no normalisation joins
    // them; `toLowerCase()` would, since it maps U+03F4 to U+03B8.
    const symbol = `${String.fromCodePoint(0x3f4)}eo@acme.example`;
    const small = `${String.fromCodePoint(0x3b8)}eo@acme.example`;
    createInvite(sql, SCOPE, BOB, 'editor', symbol, 'hash-theta', '01CAPABILITYTHETA');
    expect(inviteMatches(sql, SCOPE, 'hash-theta', small)).toBe(false);
    expect(openInviteFor(sql, SCOPE, small)).toBeNull();
    expect(openInviteFor(sql, SCOPE, symbol)).toEqual({ principal: BOB, capabilityId: '01CAPABILITYTHETA' });
  });

  it('admits a subject bound to nobody here, and never re-binds one a racing admission bound first', () => {
    createInvite(sql, SCOPE, BOB, 'viewer', 'ann@acme.example', 'hash-ann-2', '01CAPABILITYANN2');
    expect(admitInvite(sql, SCOPE, 'sub-ann', '01CAPABILITYANN2', BOB)).toBe(BOB);
    expect(admitInvite(sql, SCOPE, 'sub-ann', CAP, ANN)).toBeNull();
    expect(resolvePrincipal(sql, SCOPE, 'sub-ann', NOW)).toBe(BOB);
    expect(listInvites(sql, SCOPE).map((r) => r.principal)).toEqual([ANN]);
  });

  it('an invite naming no address is a bearer link, and a caller that passes no address is not judged', () => {
    createInvite(sql, SCOPE, BOB, 'editor', null, 'hash-bob', '01CAPABILITYBOB');
    expect(inviteMatches(sql, SCOPE, 'hash-bob', null)).toBe(true);
    expect(inviteMatches(sql, SCOPE, 'hash-ann')).toBe(true);
  });

  it('a legacy invite is held to the same rule', () => {
    createLegacyInvite(sql, SCOPE, BOB, 'editor', 'bob@acme.example', 'legacy-bob');
    expect(claimInvite(sql, SCOPE, 'sub-eve', 'legacy-bob', 'eve@acme.example')).toBeNull();
    expect(claimInvite(sql, SCOPE, 'sub-bob', 'legacy-bob', 'BOB@acme.example')).toBe(BOB);
  });

  it('admits the invited address in its own scope only, newest invite first', () => {
    createInvite(sql, SCOPE, BOB, 'viewer', 'ann@acme.example', 'hash-ann-2', '01CAPABILITYANN2');
    sql.exec('UPDATE invite SET created_at = created_at + 1 WHERE principal = ?', BOB);
    expect(openInviteFor(sql, SCOPE, 'ANN@acme.example')).toEqual({ principal: BOB, capabilityId: '01CAPABILITYANN2' });
    expect(openInviteFor(sql, OTHER_SCOPE, 'ann@acme.example')).toBeNull();
    expect(openInviteFor(sql, SCOPE, 'eve@acme.example')).toBeNull();
    expect(openInviteFor(sql, SCOPE, null)).toBeNull();
  });

  it('admits by no invite that is claimed, legacy, or names no address', () => {
    claimInviteByCapability(sql, SCOPE, 'sub-ann', CAP, ANN);
    createLegacyInvite(sql, SCOPE, BOB, 'editor', 'ann@acme.example', 'legacy-ann');
    createInvite(sql, SCOPE, '01PRINCIPALCAL', 'editor', null, 'hash-cal', '01CAPABILITYCAL');
    expect(openInviteFor(sql, SCOPE, 'ann@acme.example')).toBeNull();
  });
});

describe('a legacy invite — minted before #1686, by hash alone', () => {
  beforeEach(() => createLegacyInvite(sql, SCOPE, BOB, 'editor', null, 'hash-bob'));

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

describe('the write path (#2496) — no new hash-only row', () => {
  const stored = () => [...sql.exec('SELECT principal, capability_id FROM invite')];

  it('refuses an invite with no capability id, and writes nothing', () => {
    // The type forbids each of these; the check is for an RPC from untyped code or a cast.
    for (const none of [null, undefined, '']) {
      expect(() => createInvite(sql, SCOPE, BOB, 'editor', null, 'hash-bob', none as unknown as string)).toThrow(/hash-only/);
    }
    expect(stored()).toEqual([]);
    expect(countLegacyInvites(sql, SCOPE)).toBe(0);
    expect(inviteExists(sql, SCOPE, 'hash-bob')).toBe(false);
  });

  it('writes the same row once it names a capability — and that row is no legacy one', () => {
    createInvite(sql, SCOPE, BOB, 'editor', null, 'hash-bob', CAP);
    expect(stored()).toEqual([{ principal: BOB, capability_id: CAP }]);
    expect(countLegacyInvites(sql, SCOPE)).toBe(0);
    expect(claimInvite(sql, SCOPE, 'sub-bob', 'hash-bob')).toBeNull(); // not redeemable by hash
    expect(claimInviteByCapability(sql, SCOPE, 'sub-bob', CAP, BOB)).toBe(BOB);
  });

  it('createLegacyInvite is the explicit way to the old row: no capability, redeemable by hash', () => {
    createLegacyInvite(sql, SCOPE, BOB, 'editor', null, 'hash-bob');
    expect(stored()).toEqual([{ principal: BOB, capability_id: null }]);
    expect(countLegacyInvites(sql, SCOPE)).toBe(1);
  });
});

describe('countLegacyInvites (#2175)', () => {
  it('counts unclaimed hash-only invites at the scope — and only those', () => {
    expect(countLegacyInvites(sql, SCOPE)).toBe(0);
    createLegacyInvite(sql, SCOPE, BOB, 'editor', 'bob@acme.example', 'hash-bob');
    createLegacyInvite(sql, SCOPE, '01PRINCIPALCAL', 'editor', null, 'hash-cal');
    expect(countLegacyInvites(sql, SCOPE)).toBe(2);
    // Not counted: a capability-era invite, and a legacy one at another scope.
    createInvite(sql, SCOPE, ANN, 'editor', null, 'hash-ann', CAP);
    createLegacyInvite(sql, OTHER_SCOPE, '01PRINCIPALDAN', 'editor', null, 'hash-dan');
    expect(countLegacyInvites(sql, SCOPE)).toBe(2);
    expect(countLegacyInvites(sql, OTHER_SCOPE)).toBe(1);
  });

  it('stops counting an invite once it is claimed', () => {
    createLegacyInvite(sql, SCOPE, BOB, 'editor', null, 'hash-bob');
    expect(claimInvite(sql, SCOPE, 'sub-bob', 'hash-bob')).toBe(BOB);
    expect(countLegacyInvites(sql, SCOPE)).toBe(0);
  });

  it('stops counting an invite once it is withdrawn — a withdrawal, and so a member removal, deletes the row', () => {
    createLegacyInvite(sql, SCOPE, BOB, 'editor', null, 'hash-bob');
    createLegacyInvite(sql, SCOPE, '01PRINCIPALCAL', 'editor', null, 'hash-cal');
    revokeInvite(sql, SCOPE, BOB);
    expect(countLegacyInvites(sql, SCOPE)).toBe(1);
    expect(listInvites(sql, SCOPE).filter((i) => i.capabilityId === null)).toHaveLength(1);
  });

  it('counts a pre-#1686 row the migration left without a capability', () => {
    const db = new Database(':memory:');
    const old = sqlOver(db);
    for (const stmt of MEMBER_DIRECTORY_DDL.filter((s) => !INVITE_DDL.includes(s))) db.exec(stmt);
    db.exec('CREATE TABLE invite (token_hash TEXT PRIMARY KEY, scope_id TEXT NOT NULL, principal TEXT NOT NULL, role_key TEXT NOT NULL, email TEXT, claimed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0)');
    db.exec("INSERT INTO invite (token_hash, scope_id, principal, role_key) VALUES ('h', '01SCOPEDESK', '01PRINCIPALBOB', 'editor')");
    migrateInvites(old);
    expect(countLegacyInvites(old, SCOPE)).toBe(1);
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
