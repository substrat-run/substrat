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
  ownerClaimTarget,
  recordOwnerClaim,
  ownerClaimMatches,
  claimOwnerByCapability,
  transferOwner,
  completeOwnerTransfer,
  abandonOwnerTransfer,
  unbindSubject,
} from '../src/owner-seat.js';
import type { RegistrySql } from '../src/site-registry.js';

/**
 * The owner seat (#925), exercised against a real SQLite through the same `exec` seam the
 * IdentityDO's `ctx.storage.sql` has. These are the rules behind `setPendingOwner`,
 * `resolvePrincipal`, `needsSetup`, `ownerSeat`, and the claim link's `recordOwnerClaim` /
 * `claimOwnerByCapability` (#1686).
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

/** A fresh in-memory directory with the owner-seat tables, migrated. */
function freshSql(): RegistrySql {
  const db = new Database(':memory:');
  for (const stmt of OWNER_SEAT_DDL) db.exec(stmt);
  const sql = sqlOver(db);
  migrateOwnerSeat(sql);
  return sql;
}

/** Record `id` as the scope's claim link at `now`, as `mintOwnerClaimLink` does after the scope mints it. */
const claimLink = (sql: RegistrySql, scopeId: string, id: string, now: number) =>
  recordOwnerClaim(sql, scopeId, OWNER, { capabilityId: id, tokenHash: `hash-${id}`, expiresAt: now + OWNER_CLAIM_TTL_MS });

describe('owner seat', () => {
  let sql: RegistrySql;

  beforeEach(() => {
    sql = freshSql();
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
    claimLink(sql, SCOPE, '01CAPABILITY1', T0 + 61 * MIN);
    expect(claimOwnerByCapability(sql, SCOPE, 'sub-installer', '01CAPABILITY1', OWNER, T0 + 62 * MIN)).toBe(OWNER);
    recordOwnerSeat(sql, SCOPE, OWNER, T0 + 63 * MIN);
    expect(needsSetup(sql, SCOPE)).toBe(false);
    expect(ownerSeat(sql, SCOPE, T0 + 63 * MIN).state).toBe('claimed');
    expect(resolvePrincipal(sql, SCOPE, 'sub-stranger', T0 + 63 * MIN)).toBeNull();
    expect(resolvePrincipal(sql, SCOPE, 'sub-installer', T0 + 63 * MIN)).toBe(OWNER);
  });

  it('a re-provision naming a DIFFERENT owner changes nothing — the first record wins', () => {
    recordOwnerSeat(sql, SCOPE, OWNER, T0);
    expect(resolvePrincipal(sql, SCOPE, 'sub-installer', T0 + MIN)).toBe(OWNER);
    // A later provision with another principal must neither re-point the seat nor re-open it.
    recordOwnerSeat(sql, SCOPE, '01PRINCIPALOTHER', T0 + 2 * MIN);
    expect(ownerOfRecord(sql, SCOPE)).toBe(OWNER);
    expect(needsSetup(sql, SCOPE)).toBe(false);
    expect(resolvePrincipal(sql, SCOPE, 'sub-stranger', T0 + 3 * MIN)).toBeNull();
    // Same for a seat still pending: the window and the principal stay as first recorded.
    const other = '01SCOPEOTHER';
    recordOwnerSeat(sql, other, OWNER, T0);
    recordOwnerSeat(sql, other, '01PRINCIPALOTHER', T0 + MIN);
    expect(ownerSeat(sql, other, T0 + MIN)).toMatchObject({ owner: OWNER, firstSignIn: { until: new Date(T0 + FIRST_SIGN_IN_WINDOW_MS).toISOString() } });
    expect(resolvePrincipal(sql, other, 'sub-installer', T0 + 2 * MIN)).toBe(OWNER);
  });

  it('a seat from before the window existed reads as closed, not open', () => {
    // A row an older IdentityDO wrote: no claim_until.
    sql.exec('INSERT INTO pending_owner (scope_id, principal) VALUES (?, ?)', SCOPE, OWNER);
    sql.exec('INSERT INTO owner_of_record (scope_id, principal) VALUES (?, ?)', SCOPE, OWNER);
    expect(resolvePrincipal(sql, SCOPE, 'sub-stranger', T0)).toBeNull();
    expect(ownerSeat(sql, SCOPE, T0)).toMatchObject({ state: 'unclaimed', firstSignIn: { open: false, until: null } });
    // Still claimable the bounded way.
    claimLink(sql, SCOPE, '01CAPABILITY1', T0);
    expect(claimOwnerByCapability(sql, SCOPE, 'sub-installer', '01CAPABILITY1', OWNER, T0 + MIN)).toBe(OWNER);
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

  it('migrateOwnerSeat drops the pre-#1686 hash-link table, whose rows nothing redeems, and is idempotent', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE owner_claim (scope_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    db.exec(`INSERT INTO owner_claim VALUES ('${SCOPE}', 'old-hash', ${T0 + OWNER_CLAIM_TTL_MS})`);
    for (const stmt of OWNER_SEAT_DDL) db.exec(stmt);
    const old = sqlOver(db);
    migrateOwnerSeat(old);
    migrateOwnerSeat(old);
    expect([...old.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'owner_claim'")]).toEqual([]);
    // The seat itself is untouched by it, and still claims by its capability link.
    recordOwnerSeat(old, SCOPE, OWNER, T0);
    claimLink(old, SCOPE, '01CAPABILITY1', T0 + FIRST_SIGN_IN_WINDOW_MS + MIN);
    expect(claimOwnerByCapability(old, SCOPE, 'sub-installer', '01CAPABILITY1', OWNER, T0 + FIRST_SIGN_IN_WINDOW_MS + 2 * MIN)).toBe(OWNER);
  });

  it('a scope never provisioned here is unknown — no seat, and nothing to mint', () => {
    expect(ownerSeat(sql, SCOPE, T0)).toEqual({ state: 'unknown', owner: null, firstSignIn: null, claimLink: null });
    expect(needsSetup(sql, SCOPE)).toBe(false);
    expect(resolvePrincipal(sql, SCOPE, 'sub-anyone', T0)).toBeNull();
    expect(ownerClaimTarget(sql, SCOPE)).toBeNull();
  });
});

/**
 * The claim link as a `become` capability (#1686) — the directory's half. The capability itself
 * (its secret, single use, expiry and revocation) lives in the scope's DO and is held by
 * `packages/adapter-cloudflare/test/owner-claim.test.ts`; what is held here is which capability
 * the directory accepts as THE link: one live link, bound once, expiring, retired by a re-mint
 * and by a first sign-in that claims first.
 */
describe('owner claim link (capability)', () => {
  let sql: RegistrySql;
  const late = T0 + FIRST_SIGN_IN_WINDOW_MS + MIN;
  const link = (n: number, at = late) => ({ capabilityId: `01CAPABILITY${n}`, tokenHash: `cap-hash-${n}`, expiresAt: at + OWNER_CLAIM_TTL_MS });

  beforeEach(() => {
    sql = freshSql();
    recordOwnerSeat(sql, SCOPE, OWNER, T0);
  });

  it('records the link, matches only its hash, and binds once for the capability it names', () => {
    expect(ownerClaimTarget(sql, SCOPE)).toBe(OWNER);
    expect(recordOwnerClaim(sql, SCOPE, OWNER, link(1))).toEqual({ previous: null });
    expect(ownerSeat(sql, SCOPE, late).claimLink).toEqual({ expiresAt: new Date(late + OWNER_CLAIM_TTL_MS).toISOString() });
    expect(ownerClaimMatches(sql, SCOPE, 'cap-hash-1', late + MIN)).toBe(true);
    expect(ownerClaimMatches(sql, SCOPE, 'cap-hash-2', late + MIN)).toBe(false);
    // A capability that is not the recorded one, or that became someone other than the owner: nothing.
    expect(claimOwnerByCapability(sql, SCOPE, 'sub-stranger', '01CAPABILITY9', OWNER, late + MIN)).toBeNull();
    expect(claimOwnerByCapability(sql, SCOPE, 'sub-stranger', '01CAPABILITY1', '01PRINCIPALOTHER', late + MIN)).toBeNull();
    expect(needsSetup(sql, SCOPE)).toBe(true);
    // The twin: the recorded capability, naming the owner, binds — and consumes seat and link.
    expect(claimOwnerByCapability(sql, SCOPE, 'sub-installer', '01CAPABILITY1', OWNER, late + MIN)).toBe(OWNER);
    expect(ownerSeat(sql, SCOPE, late + MIN)).toEqual({ state: 'claimed', owner: OWNER, firstSignIn: null, claimLink: null });
    expect(resolvePrincipal(sql, SCOPE, 'sub-installer', late + 2 * MIN)).toBe(OWNER);
    // Replayed: the link is gone with the seat.
    expect(ownerClaimMatches(sql, SCOPE, 'cap-hash-1', late + 2 * MIN)).toBe(false);
    expect(claimOwnerByCapability(sql, SCOPE, 'sub-stranger', '01CAPABILITY1', OWNER, late + 2 * MIN)).toBeNull();
    // And there is nothing more to mint for, nor to record.
    expect(ownerClaimTarget(sql, SCOPE)).toBeNull();
    expect(recordOwnerClaim(sql, SCOPE, OWNER, link(2))).toBeNull();
  });

  it('an expired link matches nothing and binds nobody — the moment before, it does', () => {
    recordOwnerClaim(sql, SCOPE, OWNER, link(1));
    const expiry = late + OWNER_CLAIM_TTL_MS;
    expect(ownerClaimMatches(sql, SCOPE, 'cap-hash-1', expiry)).toBe(false);
    expect(claimOwnerByCapability(sql, SCOPE, 'sub-installer', '01CAPABILITY1', OWNER, expiry)).toBeNull();
    expect(ownerSeat(sql, SCOPE, expiry).claimLink).toBeNull();
    expect(ownerClaimMatches(sql, SCOPE, 'cap-hash-1', expiry - 1)).toBe(true);
    expect(claimOwnerByCapability(sql, SCOPE, 'sub-installer', '01CAPABILITY1', OWNER, expiry - 1)).toBe(OWNER);
  });

  it('a re-mint names the previous capability to revoke, and only the new one binds', () => {
    recordOwnerClaim(sql, SCOPE, OWNER, link(1));
    expect(recordOwnerClaim(sql, SCOPE, OWNER, link(2, late + MIN))).toEqual({ previous: '01CAPABILITY1' });
    expect(ownerClaimMatches(sql, SCOPE, 'cap-hash-1', late + 2 * MIN)).toBe(false);
    expect(claimOwnerByCapability(sql, SCOPE, 'sub-installer', '01CAPABILITY1', OWNER, late + 2 * MIN)).toBeNull();
    expect(ownerClaimMatches(sql, SCOPE, 'cap-hash-2', late + 2 * MIN)).toBe(true);
    expect(claimOwnerByCapability(sql, SCOPE, 'sub-installer', '01CAPABILITY2', OWNER, late + 2 * MIN)).toBe(OWNER);
  });

  it('a capability link is also retired by a first sign-in that claims first', () => {
    recordOwnerClaim(sql, SCOPE, OWNER, link(1, T0));
    expect(resolvePrincipal(sql, SCOPE, 'sub-installer', T0 + MIN)).toBe(OWNER);
    expect(ownerClaimMatches(sql, SCOPE, 'cap-hash-1', T0 + 2 * MIN)).toBe(false);
    expect(claimOwnerByCapability(sql, SCOPE, 'sub-stranger', '01CAPABILITY1', OWNER, T0 + 2 * MIN)).toBeNull();
    expect(ownerSeat(sql, SCOPE, T0 + 2 * MIN).claimLink).toBeNull();
  });

  it('records nothing for a principal that is not the pending owner', () => {
    expect(recordOwnerClaim(sql, SCOPE, '01PRINCIPALOTHER', link(1))).toBeNull();
    expect(ownerSeat(sql, SCOPE, late).claimLink).toBeNull();
    expect(recordOwnerClaim(sql, '01SCOPEUNKNOWN', OWNER, link(1))).toBeNull();
  });
});

/**
 * The owner hand-over (#1665). `transferOwner` moves the record a reconcile's lockout repair
 * re-seats from, and only that — the seat and revoke around it are the host's. Every refusal
 * has a twin that goes through, so each test fails if its precondition stops being checked.
 */
describe('owner transfer', () => {
  let sql: RegistrySql;
  const SUCCESSOR = '01PRINCIPALSUCCESSOR';
  /** A member: what an accepted invite writes — a subject bound to a pre-minted principal. */
  const bindMember = (principal: string, sub: string, scope = SCOPE) =>
    sql.exec('INSERT INTO identity (scope_id, sub, principal) VALUES (?, ?, ?)', scope, sub, principal);
  /** A provisioned scope whose owner has claimed the seat, with SUCCESSOR a member. */
  const claimedWithMember = () => {
    recordOwnerSeat(sql, SCOPE, OWNER, T0);
    expect(resolvePrincipal(sql, SCOPE, 'sub-installer', T0 + MIN)).toBe(OWNER);
    bindMember(SUCCESSOR, 'sub-successor');
  };

  beforeEach(() => {
    sql = freshSql();
  });

  it('moves the record to a member, and the seat stays claimed', () => {
    claimedWithMember();
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true)).toEqual({ outcome: 'transferred', owner: SUCCESSOR });
    expect(ownerOfRecord(sql, SCOPE)).toBe(SUCCESSOR);
    expect(ownerSeat(sql, SCOPE, T0 + 2 * MIN)).toEqual({
      state: 'claimed',
      owner: SUCCESSOR,
      firstSignIn: null,
      claimLink: null,
    });
    // Nothing re-opened: no pending seat, nothing to mint, a stranger still resolves to nobody.
    expect(needsSetup(sql, SCOPE)).toBe(false);
    expect(ownerClaimTarget(sql, SCOPE)).toBeNull();
    expect(resolvePrincipal(sql, SCOPE, 'sub-stranger', T0 + 2 * MIN)).toBeNull();
    // Both logins keep their bindings: the hand-over moves ownership, not identities.
    expect(resolvePrincipal(sql, SCOPE, 'sub-installer', T0 + 2 * MIN)).toBe(OWNER);
    expect(resolvePrincipal(sql, SCOPE, 'sub-successor', T0 + 2 * MIN)).toBe(SUCCESSOR);
  });

  it('a repeat while open answers `already`; once closed, `done` — both write nothing', () => {
    claimedWithMember();
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true).outcome).toBe('transferred');
    // The platform's flow failed after the record moved: its retry is `already`, and it finishes.
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true)).toEqual({ outcome: 'already', owner: SUCCESSOR });
    expect(completeOwnerTransfer(sql, SCOPE, OWNER, SUCCESSOR)).toBe(true);
    // Closed: a repeat is `done`, which the flow answers without seating or revoking anyone.
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true)).toEqual({ outcome: 'done', owner: SUCCESSOR });
    expect(completeOwnerTransfer(sql, SCOPE, OWNER, SUCCESSOR)).toBe(false); // already closed
    expect(ownerOfRecord(sql, SCOPE)).toBe(SUCCESSOR);
  });

  it('a record naming `to` is NOT a retry for any other `from` — open or closed (review MAJOR)', () => {
    claimedWithMember();
    const OTHER = '01PRINCIPALOTHERHOLDER';
    transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true);
    // Open: only OWNER → SUCCESSOR is `already`; any other pair is refused while it is.
    expect(transferOwner(sql, SCOPE, OTHER, SUCCESSOR, true)).toMatchObject({ outcome: 'refused', reason: 'in-flight' });
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true).outcome).toBe('already');
    completeOwnerTransfer(sql, SCOPE, OWNER, SUCCESSOR);
    // Closed: likewise.
    expect(transferOwner(sql, SCOPE, OTHER, SUCCESSOR, true)).toMatchObject({ outcome: 'refused', reason: 'not-owner' });
    // Closing names the hand-over too: another pair cannot close it.
    const s2 = '01SCOPESECOND';
    recordOwnerSeat(sql, s2, OWNER, T0);
    resolvePrincipal(sql, s2, 'sub-installer-2', T0 + MIN);
    bindMember(SUCCESSOR, 'sub-successor', s2);
    transferOwner(sql, s2, OWNER, SUCCESSOR, true);
    expect(completeOwnerTransfer(sql, s2, OTHER, SUCCESSOR)).toBe(false);
    expect(transferOwner(sql, s2, OWNER, SUCCESSOR, true).outcome).toBe('already');
  });

  it('refuses a second hand-over while one is open, naming it — and takes it once that one is closed', () => {
    claimedWithMember();
    const THIRD = '01PRINCIPALTHIRDMEMBER';
    bindMember(THIRD, 'sub-third');
    transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true); // open: seat and revoke not yet run
    const inFlight = { outcome: 'refused', owner: SUCCESSOR, reason: 'in-flight', inFlight: { from: OWNER, to: SUCCESSOR } };
    // Chained on top of it (the new owner handing on), and a competing one from the same owner.
    expect(transferOwner(sql, SCOPE, SUCCESSOR, THIRD, true)).toEqual(inFlight);
    expect(transferOwner(sql, SCOPE, OWNER, THIRD, true)).toEqual(inFlight);
    expect(ownerOfRecord(sql, SCOPE)).toBe(SUCCESSOR);
    completeOwnerTransfer(sql, SCOPE, OWNER, SUCCESSOR);
    expect(transferOwner(sql, SCOPE, SUCCESSOR, THIRD, true).outcome).toBe('transferred');
  });

  it('a hand-over whose `to` was removed after step 1 is `wedged`, and only an abandon clears it', () => {
    claimedWithMember();
    const THIRD = '01PRINCIPALTHIRDMEMBER';
    bindMember(THIRD, 'sub-third');
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true).outcome).toBe('transferred'); // then the flow failed
    const open = { from: OWNER, to: SUCCESSOR };
    // The tenant takes SUCCESSOR's role away: its resend must not finish (it would seat them).
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, false)).toEqual({
      outcome: 'refused', owner: SUCCESSOR, reason: 'wedged', inFlight: open,
    });
    // …and unbinds them: the same, whichever of the two went.
    unbindSubject(sql, SCOPE, 'sub-successor');
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true)).toMatchObject({ reason: 'wedged' });
    // Every other hand-over is stuck behind it.
    expect(transferOwner(sql, SCOPE, SUCCESSOR, THIRD, true)).toMatchObject({ reason: 'in-flight', inFlight: open });
    // Abandon closes ONLY the open pair — another pair changes nothing.
    expect(abandonOwnerTransfer(sql, SCOPE, SUCCESSOR, THIRD, true)).toBe('not-open');
    expect(abandonOwnerTransfer(sql, SCOPE, OWNER, SUCCESSOR, true)).toBe('abandoned'); // unbound: wedged
    expect(abandonOwnerTransfer(sql, SCOPE, OWNER, SUCCESSOR, true)).toBe('not-open'); // already closed
    expect(ownerOfRecord(sql, SCOPE)).toBe(SUCCESSOR); // the record stays where step 1 put it
    // An abandoned hand-over is no retry: its resend is not `done`.
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true)).toMatchObject({ outcome: 'refused', reason: 'not-member' });
    bindMember(SUCCESSOR, 'sub-successor');
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true)).toMatchObject({ outcome: 'refused', reason: 'not-owner' });
    // And a fresh hand-over from the record goes through.
    expect(transferOwner(sql, SCOPE, SUCCESSOR, THIRD, true).outcome).toBe('transferred');
  });

  it('abandons only a WEDGED hand-over: a healthy open one is refused (resend it), and changes nothing', () => {
    claimedWithMember();
    transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true); // open, and SUCCESSOR can still take it
    expect(abandonOwnerTransfer(sql, SCOPE, OWNER, SUCCESSOR, true)).toBe('healthy');
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true).outcome).toBe('already'); // still open
    // The twin: once SUCCESSOR has lost its role, the same abandon goes through.
    expect(abandonOwnerTransfer(sql, SCOPE, OWNER, SUCCESSOR, false)).toBe('abandoned');
    expect(ownerOfRecord(sql, SCOPE)).toBe(SUCCESSOR);
  });

  it('a bound `to` the host says holds no role is `no-role`; an unbound one `not-member` — and the twin goes through', () => {
    claimedWithMember();
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, false)).toMatchObject({ outcome: 'refused', reason: 'no-role' });
    expect(transferOwner(sql, SCOPE, OWNER, '01PRINCIPALUNBOUND', true)).toMatchObject({ outcome: 'refused', reason: 'not-member' });
    expect(transferOwner(sql, SCOPE, OWNER, '01PRINCIPALUNBOUND', false)).toMatchObject({ outcome: 'refused', reason: 'not-member' });
    expect(ownerOfRecord(sql, SCOPE)).toBe(OWNER);
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true).outcome).toBe('transferred');
  });

  it('a stale resend after a later hand-over is refused, not replayed', () => {
    claimedWithMember();
    const THIRD = '01PRINCIPALTHIRDMEMBER';
    bindMember(THIRD, 'sub-third');
    transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true);
    completeOwnerTransfer(sql, SCOPE, OWNER, SUCCESSOR);
    transferOwner(sql, SCOPE, SUCCESSOR, THIRD, true);
    completeOwnerTransfer(sql, SCOPE, SUCCESSOR, THIRD);
    // The first request arrives again (a retry queued somewhere): the scope has moved on.
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true)).toEqual({ outcome: 'refused', owner: THIRD, reason: 'not-owner' });
    expect(ownerOfRecord(sql, SCOPE)).toBe(THIRD);
  });

  it('refuses a `from` that is not the current record — and a hand-over onward from the new owner works', () => {
    claimedWithMember();
    bindMember('01PRINCIPALTHIRD', 'sub-third');
    // A stale caller naming someone who never owned it.
    expect(transferOwner(sql, SCOPE, '01PRINCIPALNOBODY', SUCCESSOR, true)).toEqual({
      outcome: 'refused',
      owner: OWNER,
      reason: 'not-owner',
    });
    expect(ownerOfRecord(sql, SCOPE)).toBe(OWNER);
    transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true);
    completeOwnerTransfer(sql, SCOPE, OWNER, SUCCESSOR);
    // The ORIGINAL owner is no longer the record, so it cannot hand the scope on.
    expect(transferOwner(sql, SCOPE, OWNER, '01PRINCIPALTHIRD', true)).toMatchObject({ outcome: 'refused', reason: 'not-owner' });
    expect(ownerOfRecord(sql, SCOPE)).toBe(SUCCESSOR);
    // The twin: the current owner can.
    expect(transferOwner(sql, SCOPE, SUCCESSOR, '01PRINCIPALTHIRD', true).outcome).toBe('transferred');
    expect(ownerOfRecord(sql, SCOPE)).toBe('01PRINCIPALTHIRD');
  });

  it('refuses a `to` nobody is bound to — and goes through once someone is', () => {
    recordOwnerSeat(sql, SCOPE, OWNER, T0);
    resolvePrincipal(sql, SCOPE, 'sub-installer', T0 + MIN);
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true)).toEqual({ outcome: 'refused', owner: OWNER, reason: 'not-member' });
    // A binding in ANOTHER scope does not make it a member of this one.
    bindMember(SUCCESSOR, 'sub-successor', '01SCOPEOTHER');
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true)).toMatchObject({ outcome: 'refused', reason: 'not-member' });
    expect(ownerOfRecord(sql, SCOPE)).toBe(OWNER);
    bindMember(SUCCESSOR, 'sub-successor');
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true).outcome).toBe('transferred');
  });

  it('refuses an UNCLAIMED seat, touching neither the pending seat nor its link — and goes through once claimed', () => {
    recordOwnerSeat(sql, SCOPE, OWNER, T0);
    bindMember(SUCCESSOR, 'sub-successor');
    const late = T0 + FIRST_SIGN_IN_WINDOW_MS + MIN;
    claimLink(sql, SCOPE, '01CAPABILITY1', late);
    const before = ownerSeat(sql, SCOPE, late);
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true)).toEqual({ outcome: 'refused', owner: OWNER, reason: 'unclaimed' });
    expect(ownerSeat(sql, SCOPE, late)).toEqual(before);
    // The link still binds the OWNER principal, as minted.
    expect(claimOwnerByCapability(sql, SCOPE, 'sub-installer', '01CAPABILITY1', OWNER, late + MIN)).toBe(OWNER);
    expect(transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true).outcome).toBe('transferred');
  });

  it('refuses a hand-over to oneself, and a scope never provisioned here', () => {
    claimedWithMember();
    expect(transferOwner(sql, SCOPE, OWNER, OWNER, true)).toEqual({ outcome: 'refused', owner: OWNER, reason: 'same-principal' });
    expect(transferOwner(sql, '01SCOPENEVER', OWNER, SUCCESSOR, true)).toEqual({ outcome: 'refused', owner: null, reason: 'unknown' });
    expect(ownerOfRecord(sql, SCOPE)).toBe(OWNER);
  });

  it('a re-provision after a transfer keeps the NEW record — first-write-wins still holds', () => {
    claimedWithMember();
    transferOwner(sql, SCOPE, OWNER, SUCCESSOR, true);
    // The platform re-runs provision with the principal it minted at install: the old owner.
    recordOwnerSeat(sql, SCOPE, OWNER, T0 + 10 * MIN);
    expect(ownerOfRecord(sql, SCOPE)).toBe(SUCCESSOR);
    expect(needsSetup(sql, SCOPE)).toBe(false);
  });
});
