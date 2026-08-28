import { beforeEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  OWNER_SEAT_DDL,
  FIRST_SIGN_IN_WINDOW_MS,
  OWNER_CLAIM_TTL_MS,
  migrateOwnerSeat,
  recordOwnerSeat,
  ownerOfRecord,
  needsSetup,
  ownerSeat,
  resolvePrincipal,
  mintOwnerClaim,
  claimOwner,
} from '../src/owner-seat.js';
import type { RegistrySql } from '../src/site-registry.js';

/**
 * The owner seat (#925), exercised against a real SQLite through the same `exec` seam the
 * IdentityDO's `ctx.storage.sql` has. These are the rules behind `setPendingOwner`,
 * `resolvePrincipal`, `needsSetup`, `ownerSeat`, `mintOwnerClaim` and `claimOwner`.
 */

const SCOPE = '01SCOPEDESK';
const OWNER = '01PRINCIPALOWNER';
const T0 = Date.UTC(2026, 7, 28, 12, 0, 0);
const MIN = 60_000;

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

describe('owner seat', () => {
  let sql: RegistrySql;

  beforeEach(() => {
    const db = new Database(':memory:');
    for (const stmt of OWNER_SEAT_DDL) db.exec(stmt);
    sql = sqlOver(db);
    migrateOwnerSeat(sql);
  });

  it('the first sign-in inside the window claims the seat; the next subject gets nothing', () => {
    recordOwnerSeat(sql, SCOPE, OWNER, T0);
    expect(needsSetup(sql, SCOPE)).toBe(true);
    expect(ownerSeat(sql, SCOPE, T0)).toEqual({
      state: 'unclaimed',
      owner: OWNER,
      firstSignIn: { open: true, until: new Date(T0 + FIRST_SIGN_IN_WINDOW_MS).toISOString() },
      claimLink: null,
    });

    expect(resolvePrincipal(sql, SCOPE, 'sub-installer', T0 + MIN)).toBe(OWNER);
    expect(needsSetup(sql, SCOPE)).toBe(false);
    expect(ownerSeat(sql, SCOPE, T0 + MIN).state).toBe('claimed');
    // Bound now — resolves again without a seat.
    expect(resolvePrincipal(sql, SCOPE, 'sub-installer', T0 + 2 * MIN)).toBe(OWNER);
    // A second subject, still inside the window, is a valid login with no seat.
    expect(resolvePrincipal(sql, SCOPE, 'sub-stranger', T0 + 2 * MIN)).toBeNull();
    // The durable record outlives the claim.
    expect(ownerOfRecord(sql, SCOPE)).toBe(OWNER);
  });

  it('after the window a plain sign-in no longer claims — and the seat is still there to claim by link', () => {
    recordOwnerSeat(sql, SCOPE, OWNER, T0);
    const late = T0 + FIRST_SIGN_IN_WINDOW_MS + 1;
    expect(resolvePrincipal(sql, SCOPE, 'sub-stranger', late)).toBeNull();
    expect(needsSetup(sql, SCOPE)).toBe(true);
    expect(ownerSeat(sql, SCOPE, late)).toMatchObject({
      state: 'unclaimed',
      firstSignIn: { open: false },
      claimLink: null,
    });
  });

  it('a re-provision keeps the window it has, and never re-opens a claimed seat', () => {
    recordOwnerSeat(sql, SCOPE, OWNER, T0);
    const until = ownerSeat(sql, SCOPE, T0).firstSignIn!.until;
    // The reconciliation sweep re-runs provision an hour later: same window, not a fresh one.
    recordOwnerSeat(sql, SCOPE, OWNER, T0 + 60 * MIN);
    expect(ownerSeat(sql, SCOPE, T0 + 60 * MIN).firstSignIn).toEqual({ open: false, until });
    expect(resolvePrincipal(sql, SCOPE, 'sub-stranger', T0 + 60 * MIN)).toBeNull();

    // Claim by link, then re-provision again: the seat stays claimed. Before #925 this
    // INSERT OR REPLACEd a fresh pending row, and the next stranger to sign in became owner.
    mintOwnerClaim(sql, SCOPE, 'hash-1', T0 + 61 * MIN);
    expect(claimOwner(sql, SCOPE, 'sub-installer', 'hash-1', T0 + 62 * MIN)).toBe(OWNER);
    recordOwnerSeat(sql, SCOPE, OWNER, T0 + 63 * MIN);
    expect(needsSetup(sql, SCOPE)).toBe(false);
    expect(ownerSeat(sql, SCOPE, T0 + 63 * MIN).state).toBe('claimed');
    expect(resolvePrincipal(sql, SCOPE, 'sub-stranger', T0 + 63 * MIN)).toBeNull();
    expect(resolvePrincipal(sql, SCOPE, 'sub-installer', T0 + 63 * MIN)).toBe(OWNER);
  });

  it('a claim link binds exactly the presented token, once, while it lives', () => {
    recordOwnerSeat(sql, SCOPE, OWNER, T0);
    const late = T0 + FIRST_SIGN_IN_WINDOW_MS + MIN;
    const minted = mintOwnerClaim(sql, SCOPE, 'hash-a', late);
    expect(minted).toEqual({ expiresAt: new Date(late + OWNER_CLAIM_TTL_MS).toISOString() });
    expect(ownerSeat(sql, SCOPE, late).claimLink).toEqual({ expiresAt: minted!.expiresAt });

    // Wrong token: nothing, and the seat is untouched.
    expect(claimOwner(sql, SCOPE, 'sub-stranger', 'hash-b', late + MIN)).toBeNull();
    expect(needsSetup(sql, SCOPE)).toBe(true);
    // Expired: nothing.
    expect(claimOwner(sql, SCOPE, 'sub-installer', 'hash-a', late + OWNER_CLAIM_TTL_MS)).toBeNull();
    // Minting again retires the earlier link.
    mintOwnerClaim(sql, SCOPE, 'hash-c', late + MIN);
    expect(claimOwner(sql, SCOPE, 'sub-installer', 'hash-a', late + 2 * MIN)).toBeNull();
    // The live one binds, consumes the seat and the link.
    expect(claimOwner(sql, SCOPE, 'sub-installer', 'hash-c', late + 2 * MIN)).toBe(OWNER);
    expect(needsSetup(sql, SCOPE)).toBe(false);
    expect(ownerSeat(sql, SCOPE, late + 2 * MIN)).toEqual({ state: 'claimed', owner: OWNER, firstSignIn: null, claimLink: null });
    // Used: a replay of the same token binds nobody else.
    expect(claimOwner(sql, SCOPE, 'sub-stranger', 'hash-c', late + 3 * MIN)).toBeNull();
    // And nothing more can be minted for a claimed seat.
    expect(mintOwnerClaim(sql, SCOPE, 'hash-d', late + 3 * MIN)).toBeNull();
  });

  it('a first sign-in that claims also retires an outstanding link', () => {
    recordOwnerSeat(sql, SCOPE, OWNER, T0);
    mintOwnerClaim(sql, SCOPE, 'hash-a', T0);
    expect(resolvePrincipal(sql, SCOPE, 'sub-installer', T0 + MIN)).toBe(OWNER);
    expect(claimOwner(sql, SCOPE, 'sub-stranger', 'hash-a', T0 + 2 * MIN)).toBeNull();
    expect(ownerSeat(sql, SCOPE, T0 + 2 * MIN).claimLink).toBeNull();
  });

  it('a seat from before the window existed reads as closed, not open', () => {
    // A row an older IdentityDO wrote: no claim_until.
    sql.exec('INSERT INTO pending_owner (scope_id, principal) VALUES (?, ?)', SCOPE, OWNER);
    sql.exec('INSERT INTO owner_of_record (scope_id, principal) VALUES (?, ?)', SCOPE, OWNER);
    expect(resolvePrincipal(sql, SCOPE, 'sub-stranger', T0)).toBeNull();
    expect(ownerSeat(sql, SCOPE, T0)).toMatchObject({ state: 'unclaimed', firstSignIn: { open: false, until: null } });
    // Still claimable the bounded way.
    mintOwnerClaim(sql, SCOPE, 'hash-a', T0);
    expect(claimOwner(sql, SCOPE, 'sub-installer', 'hash-a', T0 + MIN)).toBe(OWNER);
  });

  it('migrateOwnerSeat adds claim_until to a table from before it, and is idempotent', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE pending_owner (scope_id TEXT PRIMARY KEY, principal TEXT NOT NULL)');
    for (const stmt of OWNER_SEAT_DDL) db.exec(stmt); // IF NOT EXISTS leaves the old shape alone
    const old = sqlOver(db);
    expect([...old.exec('PRAGMA table_info(pending_owner)')].map((r) => r.name)).not.toContain('claim_until');
    migrateOwnerSeat(old);
    migrateOwnerSeat(old);
    expect([...old.exec('PRAGMA table_info(pending_owner)')].map((r) => r.name)).toContain('claim_until');
    recordOwnerSeat(old, SCOPE, OWNER, T0);
    expect(resolvePrincipal(old, SCOPE, 'sub-installer', T0 + MIN)).toBe(OWNER);
  });

  it('a scope never provisioned here is unknown — no seat, and nothing to mint', () => {
    expect(ownerSeat(sql, SCOPE, T0)).toEqual({ state: 'unknown', owner: null, firstSignIn: null, claimLink: null });
    expect(needsSetup(sql, SCOPE)).toBe(false);
    expect(resolvePrincipal(sql, SCOPE, 'sub-anyone', T0)).toBeNull();
    expect(mintOwnerClaim(sql, SCOPE, 'hash', T0)).toBeNull();
  });
});
