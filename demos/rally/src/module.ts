import { z } from 'zod';
import { listInvites, revokeInvite, sendInvite, type Invitation } from '@substrat-run/engine-invites';
import {
  dataSubjectId,
  orgId as orgIdSchema,
  manifestEntities,
  moduleManifest,
  moneyOf,
  permissionKey,
  type EntityRef,
  type Money,
  LIST_PAGE_DEFAULT,
  LIST_PAGE_MAX,
  listsDeclaredBy,
  mapPage,
  pageOf,
  type ListPage,
  type Page,
  operationInputsOf,
  substratError,
} from '@substrat-run/contracts';

/**
 * RallyPoint's own conflicts — the platform owns `conflict`, this vertical owns the
 * reason (§2 of the error model: a module never invents a code, it narrows one).
 *
 * `engine-booking`'s `SlotUnavailable` is deliberately NOT in here: it is the engine's
 * own published class, carrying its own `SLOT_UNAVAILABLE` string that both rally
 * clients switch on, and retyping it is a breaking engine-surface change rather than a
 * vertical's to make. `routes.ts` still answers it by hand, and says so.
 */
type RallyConflictReason =
  | 'no_venue'
  | 'no_price_rule'
  | 'insufficient_balance'
  | 'subscription_active'
  | 'club_closed'
  | 'outside_hours'
  | 'duration_not_bookable'
  | 'not_open_match'
  | 'no_level'
  | 'level_outside_band';
const conflict = (reason: RallyConflictReason, message: string) =>
  substratError('conflict', message, { reason });
import { bookingEntities } from '@substrat-run/engine-booking';
import { rallyEntities } from './entities.js';
import {
  assertAllowed,
  readTimeline,
  ulid,
  type ConsumerHandler,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
  type PageParams,
} from '@substrat-run/kernel';
import {
  availability as engineAvailability,
  confirmReservation,
  getReservation as engineGetReservation,
  holdReservation,
  joinReservation,
  listReservations,
  listResources,
  openReservation,
  SlotUnavailable,
  PERM as BK,
  type Reservation,
} from '@substrat-run/engine-booking';

// ============================================================================
// The RallyPoint vertical (spec/concept.md) — a padel/tennis club running on
// engine-booking. A court IS a resource, a booking IS a reservation, an open
// match IS a held reservation with a fill target.
//
// Everything here is vocabulary, opening hours, pricing and policy. The
// allocation invariant, the state machine and expiry stay in the engine —
// notably, this file contains NO locking and NO overlap arithmetic.
//
// The timezone split (engine-booking.md D-B): the engine takes absolute
// instants and never does calendar arithmetic. All local wall-clock reasoning
// — opening hours, the start grid, DST — lives here.
// ============================================================================

export const RALLY_PERM = {
  /**
   * Browse the club: courts, opening hours, and which slots are FREE.
   *
   * Deliberately distinct from `booking:read`. A player must see what is free in
   * order to book at all, but must never read the club's book — who holds which
   * court. `booking:read` for a player is narrowed to their own member record, so
   * a scope-level check on it would (correctly) deny them, and widening that
   * grant to the scope would hand every player the whole calendar. This key is
   * the capability that actually matches the need: free/busy, no identities.
   */
  browse: permissionKey.parse('rally:browse'),
  /**
   * Hold and spend a club balance. Scope-wide for players: topping up is
   * harmless (it only ever adds money), and SPENDING is gated separately — a
   * debit only happens inside a booking confirm, which walks the reservation to
   * its member. Reading a balance is likewise narrowed, so this key never
   * exposes someone else's wallet.
   */
  wallet: permissionKey.parse('rally:wallet'),
  manageVenue: permissionKey.parse('rally:manage-venue'),
  managePricing: permissionKey.parse('rally:manage-pricing'),
  manageMembers: permissionKey.parse('rally:manage-members'),
};

// The inputs and the row shapes are re-exported unchanged: they were declared
// here until `defineOperations` needed them below `module.ts` (see inputs.ts and
// schemas.ts for why the direction had to flip).
import { rallyOperations } from './operations.js';
import type { TimelineEntry } from './schemas.js';

export * from './inputs.js';
export * from './schemas.js';
export { rallyOperations, RALLY_PERMISSIONS } from './operations.js';

export const rallyManifest = moduleManifest.parse({
  id: '@substrat-run/demo-rally',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    {
      key: 'rally:browse',
      description: 'See courts, opening hours and free slots — free/busy only, never who booked',
    },
    {
      key: 'rally:wallet',
      description: 'Buy club credit and pay for a booking from a club balance',
    },
    {
      key: 'rally:manage-venue',
      description: 'Set club and court opening hours, closures, and maintenance blocks',
    },
    { key: 'rally:manage-pricing', description: 'Manage price rules, credit packs and subscription plans' },
    { key: 'rally:manage-members', description: 'Manage club members and their records' },
  ],
  events: {
    emits: [],
    // The vertical creates its own member record when someone accepts an
    // invitation. The kernel membership tuple is the executor's job (K-22 §4.2);
    // this row is RallyPoint's — balances, level, the things a club knows.
    consumes: [{ type: 'invites.accepted', schemaVersion: 1 }],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  ...manifestEntities(rallyEntities, {
    engines: [bookingEntities],
    attachmentTargets: [{ entityType: 'member', readPermission: 'rally:manage-members' }],
    // The portal walk is reservation → member: a player reaches their own booking
    // through an entity-narrowed grant on their member record. The engine already
    // declares reservation → resource for its own link; a reservation therefore
    // has two declared parents, and the proof walk follows the member edge.
    relations: [{ entityType: 'reservation', parentType: 'member' }],
  }),
  // #811: DERIVED from the operations' own `paged.over`, never written twice —
  // the index the kernel provisions and the vocabulary the operation offers are
  // one fact. `table` and `idColumn` come from the entity registry.
  lists: listsDeclaredBy(rallyOperations, rallyEntities, [bookingEntities]),
  entitlementKey: 'rallypoint',
});

export const rallyMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE rally_venue (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        timezone     TEXT NOT NULL,
        hold_minutes INTEGER NOT NULL DEFAULT 10
      );
      CREATE TABLE rally_members (
        id         TEXT PRIMARY KEY,
        party_ref  TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        phone      TEXT,
        level      TEXT,
        created_at TEXT NOT NULL
      );
      -- The club's prepaid balance for a member, as an APPEND-ONLY ledger:
      -- balance is the sum of deltas, never a mutable column. Öre as an integer
      -- so a balance can never carry a rounding error.
      CREATE TABLE rally_wallet_entries (
        id             TEXT PRIMARY KEY,
        member_id      TEXT NOT NULL REFERENCES rally_members(id),
        delta_ore      INTEGER NOT NULL,
        reason         TEXT NOT NULL,
        reservation_id TEXT,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX rally_wallet_member ON rally_wallet_entries (member_id);
      -- What a club sells: pay for 4 games, get 5. price_ore is what the member
      -- PAYS and credit_ore is what they RECEIVE; keeping them apart is what lets
      -- the ledger record the credit while an invoice records the payment.
      CREATE TABLE rally_credit_packs (
        key        TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        price_ore  INTEGER NOT NULL,
        credit_ore INTEGER NOT NULL
      );
      CREATE TABLE rally_plans (
        key            TEXT PRIMARY KEY,
        title          TEXT NOT NULL,
        monthly_ore    INTEGER NOT NULL,
        monthly_credit_ore INTEGER NOT NULL
      );
      CREATE TABLE rally_subscriptions (
        id             TEXT PRIMARY KEY,
        member_id      TEXT NOT NULL REFERENCES rally_members(id),
        plan_key       TEXT NOT NULL REFERENCES rally_plans(key),
        status         TEXT NOT NULL CHECK (status IN ('active','cancelled')),
        started_on     TEXT NOT NULL,
        next_charge_on TEXT NOT NULL,
        cancelled_at   TEXT
      );
      CREATE INDEX rally_subs_member ON rally_subscriptions (member_id);
      CREATE TABLE rally_courts (
        resource_id TEXT PRIMARY KEY,
        durations   TEXT NOT NULL DEFAULT '60,90,120',
        -- "Has it got a roof" is the question a player asks in November, and a
        -- boolean could not answer it: covered-but-open-sided is dry without
        -- being warm, and that is a different product.
        cover       TEXT NOT NULL DEFAULT 'indoor'
                    CHECK (cover IN ('indoor','covered','open'))
      );
      CREATE TABLE rally_venue_hours (
        weekday   INTEGER PRIMARY KEY,
        opens_at  TEXT,
        closes_at TEXT,
        closed    INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE rally_court_hours (
        resource_id TEXT NOT NULL,
        weekday     INTEGER NOT NULL,
        opens_at    TEXT,
        closes_at   TEXT,
        closed      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (resource_id, weekday)
      );
      CREATE TABLE rally_closures (
        id          TEXT PRIMARY KEY,
        resource_id TEXT,
        on_date     TEXT NOT NULL,
        opens_at    TEXT,
        closes_at   TEXT,
        reason      TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE rally_price_rules (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        resource_id TEXT,
        weekday     INTEGER,
        from_time   TEXT,
        to_time     TEXT,
        -- SEASON. A floodlight surcharge is not a fixed clock window: Stockholm
        -- sunset runs from ~14:45 in December to ~22:00 in June, so "after 17:00"
        -- bills for lights in June daylight and misses 15:00 in December dark.
        -- Clubs set explicit seasonal windows they can predict, rather than the
        -- system deriving sunset and surprising them.
        from_date   TEXT,
        to_date     TEXT,
        duration    INTEGER,
        amount      TEXT NOT NULL,
        currency    TEXT NOT NULL DEFAULT 'SEK',
        created_at  TEXT NOT NULL
      );
      CREATE TABLE rally_bookings (
        reservation_id TEXT PRIMARY KEY,
        -- NULL when the CLUB opened the game rather than a player: there is no
        -- customer to bill or to hang a portal grant on until someone signs up.
        member_id      TEXT REFERENCES rally_members(id),
        price_amount   TEXT NOT NULL,
        currency       TEXT NOT NULL,
        rule_label     TEXT NOT NULL,
        created_at     TEXT NOT NULL
      );
      CREATE TABLE rally_matches (
        reservation_id TEXT PRIMARY KEY,
        level_min      TEXT NOT NULL,
        level_max      TEXT NOT NULL,
        -- Who OWNS the game. NULL = the club opened it and every place is on
        -- offer; a member id = that player owns it, is on it, and pays a share.
        host_member_id TEXT REFERENCES rally_members(id)
      );
    `,
  },
  {
    // Appended, never edited: 0001 has shipped, and migrations are ordered and
    // append-only. What RallyPoint knows about an invitation the engine keeps
    // deliberately opaque — the engine stores a hash, this stores the name to put
    // on the member record when they accept.
    version: '0002-invited-player',
    sql: `
      CREATE TABLE rally_invited_player (
        invitation_id TEXT PRIMARY KEY,
        party_ref     TEXT NOT NULL,
        name          TEXT NOT NULL
      );
    `,
  }
];

// ---------------------------------------------------------------------------
// Local time ↔ instants. The engine refuses to do this; the vertical must.
// ---------------------------------------------------------------------------

/** What wall clock does `ms` show in `timeZone`, expressed as a UTC-epoch value? */
function wallClockInZone(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) === 24 ? 0 : Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
}

/**
 * `2026-07-20` + `19:00` in `Europe/Stockholm` → an absolute instant.
 *
 * Two passes: the first estimates the offset, the second re-reads it at the
 * candidate instant so a DST boundary resolves correctly. Ambiguous local times
 * (the autumn repeat) settle on the earlier instant, which is the convention
 * spec/concept.md §4.1 committed to.
 */
export function zonedToInstant(date: string, time: string, timeZone: string): string {
  const naive = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}Z`);
  if (Number.isNaN(naive)) throw substratError('validation_failed', `invalid local time: ${date} ${time}`);
  let candidate = naive - (wallClockInZone(naive, timeZone) - naive);
  candidate = naive - (wallClockInZone(candidate, timeZone) - candidate);
  return new Date(candidate).toISOString();
}

/** Weekday (0=Sun…6=Sat) of a local calendar date — read at local noon to dodge edges. */
function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

const addMinutes = (instant: string, minutes: number): string =>
  new Date(Date.parse(instant) + minutes * 60_000).toISOString();

const minutesBetween = (a: string, b: string): number =>
  Math.round((Date.parse(b) - Date.parse(a)) / 60_000);

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface VenueRow {
  id: string;
  name: string;
  timezone: string;
  hold_minutes: number;
}
export interface MemberRow {
  id: string;
  party_ref: string;
  name: string;
  phone: string | null;
  level: string | null;
  created_at: string;
}
export interface WalletEntryRow {
  id: string;
  member_id: string;
  delta_ore: number;
  reason: string;
  reservation_id: string | null;
  created_at: string;
}
export interface CreditPackRow {
  key: string;
  title: string;
  price_ore: number;
  credit_ore: number;
}
export interface PlanRow {
  key: string;
  title: string;
  monthly_ore: number;
  monthly_credit_ore: number;
}
export interface SubscriptionRow {
  id: string;
  member_id: string;
  plan_key: string;
  status: 'active' | 'cancelled';
  started_on: string;
  next_charge_on: string;
  cancelled_at: string | null;
}
export interface HoursRow {
  weekday: number;
  opens_at: string | null;
  closes_at: string | null;
  closed: number;
}
export interface CourtHoursRow extends HoursRow {
  resource_id: string;
}
export interface ClosureRow {
  id: string;
  resource_id: string | null;
  on_date: string;
  opens_at: string | null;
  closes_at: string | null;
  reason: string;
  created_at: string;
}
export interface PriceRuleRow {
  id: string;
  label: string;
  resource_id: string | null;
  weekday: number | null;
  from_time: string | null;
  to_time: string | null;
  from_date: string | null;
  to_date: string | null;
  duration: number | null;
  amount: string;
  currency: string;
  created_at: string;
}
export type Cover = 'indoor' | 'covered' | 'open';
export interface CourtRow {
  resource_id: string;
  durations: string;
  cover: Cover;
}

/** What the slot picker needs: per start, the longest duration that actually fits. */
export interface SlotFit {
  startsAt: string;
  maxFitMinutes: number;
  fits: number[];
}

const memberRef = (id: string): EntityRef => ({ entityType: 'member', entityId: id });
const reservationRef = (id: string): EntityRef => ({ entityType: 'reservation', entityId: id });

function venue(ctx: OperationContext): VenueRow {
  const row = ctx.sql.query<VenueRow>('SELECT * FROM rally_venue WHERE id = ?', ['venue'])[0];
  if (!row) throw conflict('no_venue', 'venue not configured — run rally/set-venue first');
  return row;
}

// ---------------------------------------------------------------------------
// The bookable window: club hours ∩ court hours − closures
// ---------------------------------------------------------------------------

/**
 * The effective open window for one court on one local date, as instants.
 *
 * Court hours **narrow, never widen** (spec §4.1): the intersection is taken
 * deliberately rather than letting a court override the club, so the two tables
 * cannot disagree and hand a customer a bookable slot on a shut day.
 */
export function bookableWindow(
  ctx: OperationContext,
  resourceId: string,
  date: string,
): { startsAt: string; endsAt: string } | null {
  const v = venue(ctx);
  const weekday = weekdayOf(date);

  const club = ctx.sql.query<HoursRow>('SELECT * FROM rally_venue_hours WHERE weekday = ?', [
    weekday,
  ])[0];
  if (!club || club.closed === 1 || !club.opens_at || !club.closes_at) return null;

  let opens = club.opens_at;
  let closes = club.closes_at;

  const court = ctx.sql.query<CourtHoursRow>(
    'SELECT * FROM rally_court_hours WHERE resource_id = ? AND weekday = ?',
    [resourceId, weekday],
  )[0];
  if (court) {
    if (court.closed === 1) return null;
    if (court.opens_at && court.opens_at > opens) opens = court.opens_at;
    if (court.closes_at && court.closes_at < closes) closes = court.closes_at;
  }

  // Closures: a whole-day closure kills the window; a partial one trims it.
  const closures = ctx.sql.query<ClosureRow>(
    'SELECT * FROM rally_closures WHERE on_date = ? AND (resource_id IS NULL OR resource_id = ?)',
    [date, resourceId],
  );
  for (const c of closures) {
    if (!c.opens_at || !c.closes_at) return null;
    if (c.opens_at <= opens && c.closes_at >= closes) return null;
    if (c.opens_at <= opens && c.closes_at > opens) opens = c.closes_at;
    else if (c.closes_at >= closes && c.opens_at < closes) closes = c.opens_at;
  }

  if (opens >= closes) return null;
  return {
    startsAt: zonedToInstant(date, opens, v.timezone),
    // A club open past midnight stores closes_at < opens_at, meaning "next day"
    // (spec §4.1). Rolling it forward here is what stops prime time vanishing.
    endsAt:
      closes > opens
        ? zonedToInstant(date, closes, v.timezone)
        : addMinutes(zonedToInstant(date, closes, v.timezone), 24 * 60),
  };
}

// ---------------------------------------------------------------------------
// Pricing — the vertical's moment
// ---------------------------------------------------------------------------

/**
 * Resolve the price for a slot: most specific rule wins
 * (court > duration > season > time-of-day > weekday > base). Duration is an
 * input, not a multiplier (spec §4). There is no per-customer discount: padel
 * prices the court, not the customer.
 */
export function resolvePrice(
  ctx: OperationContext,
  input: { resourceId: string; date: string; time: string; duration: number },
): { price: Money; label: string } {
  const weekday = weekdayOf(input.date);
  const rules = ctx.sql.query<PriceRuleRow>('SELECT * FROM rally_price_rules');

  const applicable = rules.filter((r) => {
    if (r.resource_id && r.resource_id !== input.resourceId) return false;
    if (r.weekday !== null && r.weekday !== weekday) return false;
    if (r.duration !== null && r.duration !== input.duration) return false;
    if (r.from_time && input.time < r.from_time) return false;
    if (r.to_time && input.time >= r.to_time) return false;
    // Seasonal window — how a floodlight surcharge tracks the actual dark.
    if (r.from_date && input.date < r.from_date) return false;
    if (r.to_date && input.date > r.to_date) return false;
    return true;
  });
  if (applicable.length === 0)
    throw conflict('no_price_rule', `no price rule matches ${input.date} ${input.time}`);

  // Most specific wins: court > duration > season > time-of-day > weekday.
  const specificity = (r: PriceRuleRow): number =>
    (r.resource_id ? 16 : 0) +
    (r.duration !== null ? 8 : 0) +
    (r.from_date || r.to_date ? 4 : 0) +
    (r.from_time ? 2 : 0) +
    (r.weekday !== null ? 1 : 0);
  const winner = applicable.reduce((best, r) => (specificity(r) > specificity(best) ? r : best));

  // No membership discount: padel prices the COURT, not the customer. What a
  // club sells instead is prepaid credit (rally_credit_packs) — see the wallet.
  return { price: moneyOf(winner.amount, winner.currency), label: winner.label };
}

// ---------------------------------------------------------------------------
// The wallet — a club's prepaid balance, as an append-only ledger
// ---------------------------------------------------------------------------

const oreOf = (m: Money): number => Math.round(Number(m.amount) * 100);
const kronor = (ore: number, currency = 'SEK'): Money =>
  moneyOf((ore / 100).toFixed(2).replace(/\.00$/, ''), currency);

/** Balance is the SUM of entries, never a stored column that could drift from them. */
export function walletBalance(ctx: OperationContext, memberId: string): number {
  return (
    ctx.sql.query<{ b: number | null }>(
      'SELECT COALESCE(SUM(delta_ore), 0) AS b FROM rally_wallet_entries WHERE member_id = ?',
      [memberId],
    )[0]?.b ?? 0
  );
}

function addEntry(
  ctx: OperationContext,
  input: { memberId: string; deltaOre: number; reason: string; reservationId?: string },
): void {
  ctx.sql.exec(
    `INSERT INTO rally_wallet_entries (id, member_id, delta_ore, reason, reservation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      ulid(),
      input.memberId,
      input.deltaOre,
      input.reason,
      input.reservationId ?? null,
      ctx.now(),
    ],
  );
}

/**
 * Spend from the balance. Throws rather than going negative.
 *
 * Composed INSIDE the booking's own transaction, which is why this needs no
 * two-phase anything: the scope is one Durable Object, so debiting the wallet and
 * confirming the court either both happen or neither does. The classic
 * "charged but not booked" failure cannot occur here.
 */
export function debitWallet(
  ctx: OperationContext,
  input: { memberId: string; amountOre: number; reason: string; reservationId?: string },
): number {
  const balance = walletBalance(ctx, input.memberId);
  if (input.amountOre > balance) {
    throw conflict(
      'insufficient_balance',
      `insufficient balance: ${(balance / 100).toFixed(2)} available, ${(input.amountOre / 100).toFixed(2)} required`,
    );
  }
  addEntry(ctx, { ...input, deltaOre: -input.amountOre });
  return balance - input.amountOre;
}

/**
 * Top up. `price_ore` is what the member PAID, `credit_ore` what they RECEIVED —
 * "5 games for the price of 4" is the gap between them. Keeping them separate is
 * what lets the ledger record the credit while an invoice records the payment.
 */
export function creditFromPack(
  ctx: OperationContext,
  input: { memberId: string; packKey: string },
): { balanceOre: number; paid: Money; received: Money } {
  const pack = ctx.sql.query<CreditPackRow>('SELECT * FROM rally_credit_packs WHERE key = ?', [
    input.packKey,
  ])[0];
  if (!pack) throw substratError('not_found', `no such credit pack: ${input.packKey}`);
  addEntry(ctx, {
    memberId: input.memberId,
    deltaOre: pack.credit_ore,
    reason: `pack:${pack.key}`,
  });
  return {
    balanceOre: walletBalance(ctx, input.memberId),
    paid: kronor(pack.price_ore),
    received: kronor(pack.credit_ore),
  };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const setVenueOp: OperationHandler<
  { name: string; timezone: string; holdMinutes?: number },
  VenueRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageVenue));
  ctx.sql.exec(
    `INSERT OR REPLACE INTO rally_venue (id, name, timezone, hold_minutes) VALUES ('venue', ?, ?, ?)`,
    [input.name, input.timezone, input.holdMinutes ?? 10],
  );
  return venue(ctx);
};

const setHoursOp: OperationHandler<
  { weekday: number; opensAt?: string; closesAt?: string; closed?: boolean },
  HoursRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageVenue));
  ctx.sql.exec(
    `INSERT OR REPLACE INTO rally_venue_hours (weekday, opens_at, closes_at, closed)
     VALUES (?, ?, ?, ?)`,
    [input.weekday, input.opensAt ?? null, input.closesAt ?? null, input.closed ? 1 : 0],
  );
  return ctx.sql.query<HoursRow>('SELECT * FROM rally_venue_hours WHERE weekday = ?', [
    input.weekday,
  ])[0]!;
};

const setCourtHoursOp: OperationHandler<
  { resourceId: string; weekday: number; opensAt?: string; closesAt?: string; closed?: boolean },
  CourtHoursRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageVenue));
  ctx.sql.exec(
    `INSERT OR REPLACE INTO rally_court_hours (resource_id, weekday, opens_at, closes_at, closed)
     VALUES (?, ?, ?, ?, ?)`,
    [
      input.resourceId,
      input.weekday,
      input.opensAt ?? null,
      input.closesAt ?? null,
      input.closed ? 1 : 0,
    ],
  );
  return ctx.sql.query<CourtHoursRow>(
    'SELECT * FROM rally_court_hours WHERE resource_id = ? AND weekday = ?',
    [input.resourceId, input.weekday],
  )[0]!;
};

const registerCourtOp: OperationHandler<
  { resourceId: string; durations?: string; cover?: Cover },
  CourtRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageVenue));
  ctx.sql.exec(
    `INSERT OR REPLACE INTO rally_courts (resource_id, durations, cover) VALUES (?, ?, ?)`,
    [input.resourceId, input.durations ?? '60,90,120', input.cover ?? 'indoor'],
  );
  return ctx.sql.query<CourtRow>('SELECT * FROM rally_courts WHERE resource_id = ?', [
    input.resourceId,
  ])[0]!;
};

const addClosureOp: OperationHandler<
  { resourceId?: string; onDate: string; opensAt?: string; closesAt?: string; reason: string },
  ClosureRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageVenue));
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO rally_closures (id, resource_id, on_date, opens_at, closes_at, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.resourceId ?? null,
      input.onDate,
      input.opensAt ?? null,
      input.closesAt ?? null,
      input.reason,
      ctx.now(),
    ],
  );
  return ctx.sql.query<ClosureRow>('SELECT * FROM rally_closures WHERE id = ?', [id])[0]!;
};

const upsertPriceRuleOp: OperationHandler<
  {
    id?: string;
    label: string;
    resourceId?: string;
    weekday?: number;
    fromTime?: string;
    toTime?: string;
    fromDate?: string;
    toDate?: string;
    duration?: number;
    amount: string;
    currency?: string;
  },
  PriceRuleRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.managePricing));
  const id = input.id ?? ulid();
  ctx.sql.exec(
    `INSERT OR REPLACE INTO rally_price_rules
       (id, label, resource_id, weekday, from_time, to_time, from_date, to_date,
        duration, amount, currency, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.label,
      input.resourceId ?? null,
      input.weekday ?? null,
      input.fromTime ?? null,
      input.toTime ?? null,
      input.fromDate ?? null,
      input.toDate ?? null,
      input.duration ?? null,
      input.amount,
      input.currency ?? 'SEK',
      ctx.now(),
    ],
  );
  return ctx.sql.query<PriceRuleRow>('SELECT * FROM rally_price_rules WHERE id = ?', [id])[0]!;
};

const upsertPackOp: OperationHandler<
  { key: string; title: string; priceOre: number; creditOre: number },
  CreditPackRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.managePricing));
  ctx.sql.exec(
    `INSERT OR REPLACE INTO rally_credit_packs (key, title, price_ore, credit_ore)
     VALUES (?, ?, ?, ?)`,
    [input.key, input.title, input.priceOre, input.creditOre],
  );
  return ctx.sql.query<CreditPackRow>('SELECT * FROM rally_credit_packs WHERE key = ?', [
    input.key,
  ])[0]!;
};

const upsertPlanOp: OperationHandler<
  { key: string; title: string; monthlyOre: number; monthlyCreditOre: number },
  PlanRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.managePricing));
  ctx.sql.exec(
    `INSERT OR REPLACE INTO rally_plans (key, title, monthly_ore, monthly_credit_ore)
     VALUES (?, ?, ?, ?)`,
    [input.key, input.title, input.monthlyOre, input.monthlyCreditOre],
  );
  return ctx.sql.query<PlanRow>('SELECT * FROM rally_plans WHERE key = ?', [input.key])[0]!;
};

/** Read a balance and its history — narrowed to the member, so only your own. */
const walletOp: OperationHandler<
  { memberId: string },
  { balance: Money; entries: WalletEntryRow[] }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(BK.read, memberRef(input.memberId)));
  return {
    balance: kronor(walletBalance(ctx, input.memberId)),
    entries: ctx.sql.query<WalletEntryRow>(
      'SELECT * FROM rally_wallet_entries WHERE member_id = ? ORDER BY id DESC',
      [input.memberId],
    ),
  };
};

const buyCreditsOp: OperationHandler<
  { memberId: string; packKey: string },
  { balance: Money; paid: Money; received: Money }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.wallet));
  const r = creditFromPack(ctx, input);
  return { balance: kronor(r.balanceOre), paid: r.paid, received: r.received };
};

const subscribeOp: OperationHandler<
  { memberId: string; planKey: string; on: string },
  SubscriptionRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.wallet));
  const plan = ctx.sql.query<PlanRow>('SELECT * FROM rally_plans WHERE key = ?', [input.planKey])[0];
  if (!plan) throw substratError('not_found', `no such plan: ${input.planKey}`);
  const open = ctx.sql.query<SubscriptionRow>(
    `SELECT * FROM rally_subscriptions WHERE member_id = ? AND status = 'active'`,
    [input.memberId],
  )[0];
  if (open) throw conflict('subscription_active', `member already has an active subscription`);

  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO rally_subscriptions
       (id, member_id, plan_key, status, started_on, next_charge_on)
     VALUES (?, ?, ?, 'active', ?, ?)`,
    [id, input.memberId, plan.key, input.on, input.on],
  );
  return ctx.sql.query<SubscriptionRow>('SELECT * FROM rally_subscriptions WHERE id = ?', [id])[0]!;
};

const cancelSubscriptionOp: OperationHandler<{ subscriptionId: string }, SubscriptionRow> = async (
  ctx,
  input,
) => {
  const sub = ctx.sql.query<SubscriptionRow>('SELECT * FROM rally_subscriptions WHERE id = ?', [
    input.subscriptionId,
  ])[0];
  if (!sub) throw substratError('not_found', `subscription not found: ${input.subscriptionId}`);
  assertAllowed(await ctx.check(BK.read, memberRef(sub.member_id)));
  ctx.sql.exec(
    `UPDATE rally_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE id = ?`,
    [ctx.now(), sub.id],
  );
  return ctx.sql.query<SubscriptionRow>('SELECT * FROM rally_subscriptions WHERE id = ?', [sub.id])[0]!;
};

/**
 * Charge every subscription due on or before `on`, crediting the wallet.
 *
 * A subscription that grants monthly credit IS a wallet topped up on a schedule —
 * one mechanism, not two. In production the schedule is a Workflow (durable,
 * long-waiting, per-step retry, per docs/rfc/booking-social.md §7), and the
 * actual card charge is a payment connector; this operation is the step such a
 * workflow would invoke, and it is idempotent per (subscription, due date)
 * because it advances `next_charge_on` in the same transaction as the credit.
 */
const runBillingOp: OperationHandler<
  { on: string },
  { charged: number; creditedOre: number }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.managePricing));
  const due = ctx.sql.query<SubscriptionRow>(
    `SELECT * FROM rally_subscriptions WHERE status = 'active' AND next_charge_on <= ?`,
    [input.on],
  );
  let creditedOre = 0;
  for (const sub of due) {
    const plan = ctx.sql.query<PlanRow>('SELECT * FROM rally_plans WHERE key = ?', [sub.plan_key])[0];
    if (!plan) continue;
    addEntry(ctx, {
      memberId: sub.member_id,
      deltaOre: plan.monthly_credit_ore,
      reason: `plan:${plan.key}`,
    });
    creditedOre += plan.monthly_credit_ore;
    const next = new Date(`${sub.next_charge_on}T12:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    ctx.sql.exec('UPDATE rally_subscriptions SET next_charge_on = ? WHERE id = ?', [
      next.toISOString().slice(0, 10),
      sub.id,
    ]);
  }
  return { charged: due.length, creditedOre };
};

const createMemberOp: OperationHandler<
  { partyRef: string; name: string; phone?: string; level?: string },
  MemberRow
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageMembers));
  const id = ulid();
  // Parse at the boundary: a member's party_ref is the global player identity and
  // must be a real data-subject id, or crypto-shredding has nothing to key on.
  const partyRef = dataSubjectId.parse(input.partyRef);
  ctx.sql.exec(
    `INSERT INTO rally_members (id, party_ref, name, phone, level, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, partyRef, input.name, input.phone ?? null, input.level ?? null, ctx.now()],
  );
  return ctx.sql.query<MemberRow>('SELECT * FROM rally_members WHERE id = ?', [id])[0]!;
};

/**
 * Page a list this vertical already has in memory, on one of its own fields.
 *
 * Most of rally's reads are FOLDS — a slot grid derived from opening hours and
 * the engine's free intervals, a partner tally over every reservation, a price
 * matrix computed per hour. There is no partial computation to push into SQL, so
 * the fold runs and the page is taken off it. `rally/list-members` is the one
 * plain table walk and is kernel-composed instead.
 *
 * The cursor field must be UNIQUE among the rows, which each call site's
 * declaration in `operations.ts` states and this cannot check.
 */
function pageBy<T>(rows: T[], page: ListPage, key: (row: T) => string): Page<T> {
  const limit = Math.min(page.limit ?? LIST_PAGE_DEFAULT, LIST_PAGE_MAX);
  const cursor = page.cursor;
  const after =
    cursor === undefined
      ? 0
      : (() => {
          const i = rows.findIndex((r) => key(r) > cursor);
          return i < 0 ? rows.length : i;
        })();
  return pageOf(rows.slice(after, after + limit), limit, key);
}

const listMembersOp: OperationHandler<PageParams | undefined, Page<MemberRow>> = async (
  ctx,
  page,
) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageMembers));
  // Kernel-composed (#811): the only plain table walk in this vertical.
  return ctx.page<MemberRow>('member', page ?? {});
};

export interface CourtListing {
  id: string;
  name: string;
  durations: string;
  cover: Cover;
}

/**
 * Courts as a player may see them. The engine's own `booking/list-resources`
 * binding requires `booking:read`, which a player deliberately does not hold at
 * scope level — so this reaches the engine through its exported in-scope
 * function and joins the vertical's own side table in memory — never a SELECT
 * against the engine's own tables, which are private to it (decision 28).
 */
const browseCourtsOp: OperationHandler<ListPage | undefined, Page<CourtListing>> = async (
  ctx,
  page,
) => {
  assertAllowed(await ctx.check(RALLY_PERM.browse));
  const config = new Map(
    ctx.sql
      .query<CourtRow>('SELECT * FROM rally_courts')
      .map((c) => [c.resource_id, c] as const),
  );
  const courts = listResources(ctx, 'court')
    .filter((r) => r.active)
    .map((r) => ({
      id: r.id,
      name: r.name,
      durations: config.get(r.id)?.durations ?? '60,90,120',
      cover: config.get(r.id)?.cover ?? 'indoor',
    }));
  return pageBy(courts, page ?? {}, (c) => c.id);
};

export interface VenueSnapshot {
  venue: VenueRow;
  hours: HoursRow[];
  courtHours: CourtHoursRow[];
  courts: CourtRow[];
  creditPacks: CreditPackRow[];
  plans: PlanRow[];
  priceRules: PriceRuleRow[];
  closures: ClosureRow[];
}

/**
 * Everything both surfaces need to render a calendar: the club's shape.
 * Guarded by `booking:read` rather than `rally:manage-venue` — the player app
 * must know when the club opens without being able to change it.
 */
const getVenueOp: OperationHandler<undefined, VenueSnapshot> = async (ctx) => {
  assertAllowed(await ctx.check(RALLY_PERM.browse));
  return {
    venue: venue(ctx),
    hours: ctx.sql.query<HoursRow>('SELECT * FROM rally_venue_hours ORDER BY weekday'),
    courtHours: ctx.sql.query<CourtHoursRow>('SELECT * FROM rally_court_hours'),
    courts: ctx.sql.query<CourtRow>('SELECT * FROM rally_courts'),
    creditPacks: ctx.sql.query<CreditPackRow>('SELECT * FROM rally_credit_packs ORDER BY price_ore'),
    plans: ctx.sql.query<PlanRow>('SELECT * FROM rally_plans ORDER BY monthly_ore'),
    priceRules: ctx.sql.query<PriceRuleRow>('SELECT * FROM rally_price_rules ORDER BY created_at'),
    closures: ctx.sql.query<ClosureRow>('SELECT * FROM rally_closures ORDER BY on_date'),
  };
};

/**
 * THE SLOT PICKER FEED. For every start on the club's 30-minute grid, the
 * longest duration that actually fits — the "fit dots" the design handover
 * hangs its core interaction on.
 *
 * Availability is the engine's (free intervals between reservations); the
 * opening-hours intersection is the vertical's. The engine would happily report
 * 03:00 as free.
 */
const availabilityOp: OperationHandler<
  { resourceId: string; date: string; now?: string } & ListPage,
  Page<SlotFit>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.browse));
  const window = bookableWindow(ctx, input.resourceId, input.date);
  if (!window) return pageBy<SlotFit>([], input, (f) => f.startsAt);

  const court = ctx.sql.query<CourtRow>('SELECT * FROM rally_courts WHERE resource_id = ?', [
    input.resourceId,
  ])[0];
  const durations = (court?.durations ?? '60,90,120')
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => d > 0)
    .sort((a, b) => a - b);

  const free = engineAvailability(ctx, {
    resourceId: input.resourceId,
    from: window.startsAt,
    to: window.endsAt,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  const out: SlotFit[] = [];
  const gridStep = 30;
  const total = minutesBetween(window.startsAt, window.endsAt);
  for (let offset = 0; offset < total; offset += gridStep) {
    const startsAt = addMinutes(window.startsAt, offset);
    const fits = durations.filter((d) => {
      const endsAt = addMinutes(startsAt, d);
      if (endsAt > window.endsAt) return false;
      // The whole [start, end) must sit inside ONE free interval.
      return free.some((f) => f.startsAt <= startsAt && f.endsAt >= endsAt);
    });
    if (fits.length > 0) {
      out.push({ startsAt, maxFitMinutes: fits[fits.length - 1]!, fits });
    }
  }
  return pageBy(out, input, (f) => f.startsAt);
};

export interface RosterEntry {
  partyRef: string;
  name: string;
  level: string | null;
  share: Money | null;
}

/**
 * Who is on a reservation, by name.
 *
 * The club's member roster is never readable by a player — but the participants
 * of a match they can see are (spec §4.4). Publishing a match IS the consent:
 * you cannot ask someone to commit 90 minutes and a payment to three anonymous
 * slots, and the people in it opted in by joining. The line is "participants of
 * a match you can see", never "the club's customer list".
 */
function rosterOf(ctx: OperationContext, reservationId: string): RosterEntry[] {
  const members = new Map(
    ctx.sql
      .query<MemberRow>('SELECT * FROM rally_members')
      .map((m) => [m.party_ref, m] as const),
  );
  return engineGetReservation(ctx, reservationId)
    .participants.filter((p) => !p.leftAt)
    .map((p) => ({
      partyRef: p.partyRef,
      name: members.get(p.partyRef)?.name ?? 'Spelare',
      level: members.get(p.partyRef)?.level ?? null,
      share: p.share,
    }));
}

export interface VenueSlot {
  startsAt: string;
  /** Durations that fit on at least one court in the filtered pool. */
  fits: number[];
  courts: { id: string; name: string; cover: Cover; fits: number[] }[];
}

/** Courts in the pool, after the player's filters — applied BEFORE the time grid. */
function courtPool(ctx: OperationContext, cover?: Cover[]): (CourtListing & { name: string })[] {
  const config = new Map(
    ctx.sql.query<CourtRow>('SELECT * FROM rally_courts').map((c) => [c.resource_id, c] as const),
  );
  return listResources(ctx, 'court')
    .filter((r) => r.active)
    .map((r) => ({
      id: r.id,
      name: r.name,
      durations: config.get(r.id)?.durations ?? '60,90,120',
      cover: config.get(r.id)?.cover ?? ('indoor' as Cover),
    }))
    .filter((c) => !cover || cover.length === 0 || cover.includes(c.cover));
}

/**
 * Availability for the whole VENUE (spec §4.2): a start time is offered if any
 * court can take it. Players book a time; the court is chosen last, or never.
 *
 * The engine's `availability()` stays per-resource because the invariant is
 * per-resource. Aggregating is the vertical's job — the same split as opening
 * hours: the engine answers about one court, the vertical answers about a club.
 */
const venueAvailabilityOp: OperationHandler<
  { date: string; cover?: Cover[]; now?: string } & ListPage,
  Page<VenueSlot>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.browse));
  const byStart = new Map<string, VenueSlot>();

  for (const court of courtPool(ctx, input.cover)) {
    const window = bookableWindow(ctx, court.id, input.date);
    if (!window) continue;
    const durations = court.durations
      .split(',')
      .map((d) => Number(d.trim()))
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    const free = engineAvailability(ctx, {
      resourceId: court.id,
      from: window.startsAt,
      to: window.endsAt,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });

    const total = minutesBetween(window.startsAt, window.endsAt);
    for (let offset = 0; offset < total; offset += 30) {
      const startsAt = addMinutes(window.startsAt, offset);
      const fits = durations.filter((d) => {
        const endsAt = addMinutes(startsAt, d);
        if (endsAt > window.endsAt) return false;
        return free.some((f) => f.startsAt <= startsAt && f.endsAt >= endsAt);
      });
      if (fits.length === 0) continue;
      const slot = byStart.get(startsAt) ?? { startsAt, fits: [], courts: [] };
      slot.courts.push({ id: court.id, name: court.name, cover: court.cover, fits });
      slot.fits = [...new Set([...slot.fits, ...fits])].sort((a, b) => a - b);
      byStart.set(startsAt, slot);
    }
  }
  const slots = [...byStart.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return pageBy(slots, input, (s) => s.startsAt);
};

/** The people you have shared a court with HERE — see spec §10.2 for what this is not. */
const playedWithOp: OperationHandler<
  { memberId: string } & ListPage,
  Page<{ partyRef: string; name: string; level: string | null; times: number; lastPlayed: string }>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(BK.read, memberRef(input.memberId)));
  const me = ctx.sql.query<MemberRow>('SELECT * FROM rally_members WHERE id = ?', [
    input.memberId,
  ])[0];
  if (!me) throw substratError('not_found', `member not found: ${input.memberId}`);

  const tally = new Map<
    string,
    { partyRef: string; name: string; level: string | null; times: number; lastPlayed: string }
  >();
  for (const r of listReservations(ctx, {})) {
    if (r.effectiveState === 'cancelled' || r.effectiveState === 'expired') continue;
    const roster = rosterOf(ctx, r.id);
    if (!roster.some((p) => p.partyRef === me.party_ref)) continue;
    for (const other of roster) {
      if (other.partyRef === me.party_ref) continue;
      const seen = tally.get(other.partyRef);
      tally.set(other.partyRef, {
        // Published as of #891: it was always the tally's key, and a page needs a
        // unique field to walk.
        partyRef: other.partyRef,
        name: other.name,
        level: other.level,
        times: (seen?.times ?? 0) + 1,
        lastPlayed: seen && seen.lastPlayed > r.startsAt ? seen.lastPlayed : r.startsAt,
      });
    }
  }
  const partners = [...tally.values()].sort((a, b) => b.times - a.times);
  return pageBy(partners, input, (p) => p.partyRef);
};

/**
 * Which court, when the player did not say. First that can take the interval,
 * within the filtered pool. Throws the engine's own SlotUnavailable so the whole
 * stack — including the 409 the UI acts on — behaves identically whether the
 * court was chosen by a person or by us.
 */
function pickCourt(
  ctx: OperationContext,
  input: { cover?: Cover[]; date: string; time: string; duration: number; now?: string },
): string {
  const startsAt = zonedToInstant(input.date, input.time, venue(ctx).timezone);
  const endsAt = addMinutes(startsAt, input.duration);
  for (const c of courtPool(ctx, input.cover)) {
    if (!c.durations.split(',').map((d) => Number(d.trim())).includes(input.duration)) continue;
    const w = bookableWindow(ctx, c.id, input.date);
    if (!w || startsAt < w.startsAt || endsAt > w.endsAt) continue;
    const free = engineAvailability(ctx, {
      resourceId: c.id,
      from: startsAt,
      to: endsAt,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    if (free.some((f) => f.startsAt <= startsAt && f.endsAt >= endsAt)) return c.id;
  }
  throw new SlotUnavailable('venue', startsAt, endsAt);
}

/**
 * What would this cost? Needed because the booking screen shows a price before
 * anything is committed, and until now the only way to learn a price was to take
 * the slot — which is a poor way to answer a question.
 *
 * Browse-guarded: a price list is public, and this is the same arithmetic
 * `book-court` will do, so the two cannot disagree.
 */
const quoteOp: OperationHandler<
  { date: string; time: string; duration: number; resourceId?: string; cover?: Cover[] },
  { price: Money; label: string; courts: { id: string; name: string; cover: Cover }[] }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.browse));
  const startsAt = zonedToInstant(input.date, input.time, venue(ctx).timezone);
  const endsAt = addMinutes(startsAt, input.duration);

  // Which courts could actually take it — step 2's picker, and the reason the
  // player never has to guess in step 1.
  const courts = courtPool(ctx, input.cover).filter((c) => {
    if (!c.durations.split(',').map((d) => Number(d.trim())).includes(input.duration)) return false;
    const w = bookableWindow(ctx, c.id, input.date);
    if (!w || startsAt < w.startsAt || endsAt > w.endsAt) return false;
    return engineAvailability(ctx, { resourceId: c.id, from: startsAt, to: endsAt }).some(
      (f) => f.startsAt <= startsAt && f.endsAt >= endsAt,
    );
  });
  if (courts.length === 0) throw new SlotUnavailable('venue', startsAt, endsAt);

  const { price, label } = resolvePrice(ctx, {
    resourceId: input.resourceId ?? courts[0]!.id,
    date: input.date,
    time: input.time,
    duration: input.duration,
  });
  return {
    price,
    label,
    courts: courts.map((c) => ({ id: c.id, name: c.name, cover: c.cover })),
  };
};

/**
 * The resolved price for a grid of times × durations, ignoring availability.
 *
 * A club's price table is a MATRIX, and its failure mode is a hole in that
 * matrix rather than a wrong number: leave out a (window × duration)
 * combination and the specificity ladder quietly falls back to a broader rule,
 * so peak hours sell at the base rate — or, as happened here, every duration
 * resolves to the same amount and nobody notices for weeks.
 *
 * Rendering what the rules ACTUALLY resolve to makes that visible at a glance,
 * which no amount of reading the rule list does. Deliberately not the quote
 * endpoint: this must price slots that are already booked.
 */
const priceMatrixOp: OperationHandler<
  { date: string } & ListPage,
  Page<{ time: string; cells: { duration: number; amount: string; label: string }[] }>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.managePricing));
  const rows: { time: string; cells: { duration: number; amount: string; label: string }[] }[] = [];
  const anyCourt = listResources(ctx, 'court')[0];
  for (let h = 7; h <= 22; h += 1) {
    const time = `${String(h).padStart(2, '0')}:00`;
    const cells: { duration: number; amount: string; label: string }[] = [];
    for (const duration of [60, 90, 120]) {
      try {
        const { price, label } = resolvePrice(ctx, {
          resourceId: anyCourt?.id ?? '',
          date: input.date,
          time,
          duration,
        });
        cells.push({ duration, amount: price.amount, label });
      } catch {
        cells.push({ duration, amount: '—', label: 'ingen regel' });
      }
    }
    rows.push({ time, cells });
  }
  return pageBy(rows, input, (r) => r.time);
};

const bookInput = z.object({
  /** Omitted = the vertical picks one (spec §4.2). Staff pass it; players rarely do. */
  resourceId: z.string().min(1).optional(),
  cover: z.array(z.enum(['indoor', 'covered', 'open'])).optional(),
  memberId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  duration: z.number().int().positive(),
  now: z.string().optional(),
});

/**
 * THE PRICING MOMENT. Validate the slot against the club's own rules (open
 * window, allowed duration), resolve the price from the rule table + the
 * then hand the engine an absolute interval and let it arbitrate.
 *
 * If the court is taken, the engine throws `SlotUnavailable` — this vertical
 * never checks for a clash itself, because it cannot do so correctly and the
 * engine already does.
 */
const bookCourtOp: OperationHandler<
  z.infer<typeof bookInput>,
  { reservation: Reservation; price: Money; ruleLabel: string }
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(BK.hold));
  const input = bookInput.parse(rawInput);
  const v = venue(ctx);

  const member = ctx.sql.query<MemberRow>('SELECT * FROM rally_members WHERE id = ?', [
    input.memberId,
  ])[0];
  if (!member) throw substratError('not_found', `member not found: ${input.memberId}`);

  const resourceId = input.resourceId ?? pickCourt(ctx, input);
  const window = bookableWindow(ctx, resourceId, input.date);
  if (!window) throw conflict('club_closed', `the club is closed on ${input.date}`);

  const startsAt = zonedToInstant(input.date, input.time, v.timezone);
  const endsAt = addMinutes(startsAt, input.duration);
  if (startsAt < window.startsAt || endsAt > window.endsAt) {
    throw conflict('outside_hours', `${input.time} +${input.duration}min falls outside opening hours`);
  }

  const court = ctx.sql.query<CourtRow>('SELECT * FROM rally_courts WHERE resource_id = ?', [
    resourceId,
  ])[0];
  const allowed = (court?.durations ?? '60,90,120').split(',').map((d) => Number(d.trim()));
  if (!allowed.includes(input.duration)) {
    throw conflict('duration_not_bookable', `${input.duration} min is not bookable on this court`);
  }

  const { price, label } = resolvePrice(ctx, {
    resourceId,
    date: input.date,
    time: input.time,
    duration: input.duration,
  });

  const now = input.now ?? ctx.now();
  const reservation = holdReservation(ctx, {
    resourceId,
    startsAt,
    endsAt,
    expiresAt: addMinutes(now, v.hold_minutes),
    now,
  });

  // The vertical's own side table, keyed by the engine's id — never a column
  // added upstream (CLAUDE.md, decision 28).
  ctx.sql.exec(
    `INSERT INTO rally_bookings (reservation_id, member_id, price_amount, currency, rule_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [reservation.id, member.id, price.amount, price.currency, label, now],
  );
  ctx.link(reservationRef(reservation.id), memberRef(member.id));

  // The booker is ON the court. Without this a booking has an empty roster, so
  // "open my game for three more" cannot tell that a place is already taken —
  // and "who is playing" is blank for the one person who certainly is.
  joinReservation(ctx, {
    reservationId: reservation.id,
    partyRef: dataSubjectId.parse(member.party_ref),
    share: price,
    now,
  });

  return { reservation, price, ruleLabel: label };
};

/**
 * Confirm, optionally paying from the club balance.
 *
 * The debit and the confirm are ONE transaction in ONE scope, which is a single
 * Durable Object — so "charged but not booked" and "booked but not charged" are
 * both unrepresentable. If the wallet is short, the whole confirm rolls back and
 * the slot stays held; if the court was taken while the hold lapsed, the engine
 * throws and no money moves. That property is free here and expensive almost
 * anywhere else.
 */
const confirmBookingOp: OperationHandler<
  { reservationId: string; payWith?: 'wallet' | 'card'; now?: string },
  { reservation: Reservation; price: Money; paidFromWallet: boolean; balance: Money | null }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(BK.confirm, reservationRef(input.reservationId)));
  const booking = ctx.sql.query<{ member_id: string; price_amount: string; currency: string }>(
    'SELECT member_id, price_amount, currency FROM rally_bookings WHERE reservation_id = ?',
    [input.reservationId],
  )[0];
  if (!booking) throw substratError('not_found', `no RallyPoint booking for ${input.reservationId}`);

  const price = moneyOf(booking.price_amount, booking.currency);
  const reservation = confirmReservation(ctx, {
    reservationId: input.reservationId,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  if (input.payWith !== 'wallet') {
    return { reservation, price, paidFromWallet: false, balance: null };
  }
  const remaining = debitWallet(ctx, {
    memberId: booking.member_id,
    amountOre: oreOf(price),
    reason: 'booking',
    reservationId: reservation.id,
  });
  return { reservation, price, paidFromWallet: true, balance: kronor(remaining, price.currency) };
};

const openMatchInput = bookInput.extend({
  /** Omitted = the CLUB opens the game: no host, every place on offer. */
  memberId: z.string().min(1).optional(),
  fillTarget: z.number().int().min(2).max(4).default(4),
  levelMin: z.string(),
  levelMax: z.string(),
});

/**
 * An open match is the SAME held reservation, with a fill target — the engine
 * mechanism that also powers the payment hold. The level band is vertical
 * policy the engine never learns.
 */
const createOpenMatchOp: OperationHandler<
  z.infer<typeof openMatchInput>,
  { reservation: Reservation; price: Money; sharePerPlayer: Money }
> = async (ctx, rawInput) => {
  assertAllowed(await ctx.check(BK.hold));
  const input = openMatchInput.parse(rawInput);
  const v = venue(ctx);

  // Two kinds of open game, and the difference is OWNERSHIP.
  //   host present — a player opened their own reservation to others: they are
  //                  on it, they pay a share, and the rest is on offer.
  //   host absent   — the CLUB opened a court: nobody owns it, every place is on
  //                  offer, and there is no customer to bill until someone signs
  //                  up. This is the common case in a real club.
  const host = input.memberId
    ? ctx.sql.query<MemberRow>('SELECT * FROM rally_members WHERE id = ?', [input.memberId])[0]
    : undefined;
  if (input.memberId && !host) throw substratError('not_found', `member not found: ${input.memberId}`);

  const resourceId = input.resourceId ?? pickCourt(ctx, input);
  const window = bookableWindow(ctx, resourceId, input.date);
  if (!window) throw conflict('club_closed', `the club is closed on ${input.date}`);
  const startsAt = zonedToInstant(input.date, input.time, v.timezone);
  const endsAt = addMinutes(startsAt, input.duration);
  if (startsAt < window.startsAt || endsAt > window.endsAt) {
    throw conflict('outside_hours', `${input.time} +${input.duration}min falls outside opening hours`);
  }

  const { price, label } = resolvePrice(ctx, {
    resourceId,
    date: input.date,
    time: input.time,
    duration: input.duration,
  });

  const now = input.now ?? ctx.now();
  const reservation = holdReservation(ctx, {
    resourceId,
    startsAt,
    endsAt,
    // An open match holds until it fills or the deadline passes — same field.
    expiresAt: startsAt,
    fillTarget: input.fillTarget,
    now,
  });

  ctx.sql.exec(
    `INSERT INTO rally_bookings (reservation_id, member_id, price_amount, currency, rule_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [reservation.id, host?.id ?? null, price.amount, price.currency, label, now],
  );
  ctx.sql.exec(
    `INSERT INTO rally_matches (reservation_id, level_min, level_max, host_member_id)
     VALUES (?, ?, ?, ?)`,
    [reservation.id, input.levelMin, input.levelMax, host?.id ?? null],
  );

  const share = moneyOf(String(Math.round(Number(price.amount) / input.fillTarget)), price.currency);
  if (!host) {
    // Club-opened: no owner, no portal link, and all places on offer.
    return { reservation, price, sharePerPlayer: share };
  }

  ctx.link(reservationRef(reservation.id), memberRef(host.id));
  // A host is IN their own match. Opening a court and then not being on it is
  // never what anyone meant, and without this a 4-player match starts at 0/4 —
  // the fill meter, the share split and the auto-confirm would all count short.
  const joined = joinReservation(ctx, {
    reservationId: reservation.id,
    partyRef: dataSubjectId.parse(host.party_ref),
    share,
    now,
  });

  return { reservation: joined.reservation, price, sharePerPlayer: share };
};

/**
 * Joining enforces the LEVEL BAND — pure vertical policy. A player outside the
 * band is refused here; the design's request-and-approve flow (all current
 * players must accept) is the next increment and lives in this layer too, never
 * in the engine.
 */
const joinMatchOp: OperationHandler<
  { reservationId: string; memberId: string; now?: string },
  { reservation: Reservation; share: Money }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(BK.create));
  const member = ctx.sql.query<MemberRow>('SELECT * FROM rally_members WHERE id = ?', [
    input.memberId,
  ])[0];
  if (!member) throw substratError('not_found', `member not found: ${input.memberId}`);

  const match = ctx.sql.query<{ level_min: string; level_max: string }>(
    'SELECT * FROM rally_matches WHERE reservation_id = ?',
    [input.reservationId],
  )[0];
  if (!match) throw conflict('not_open_match', `not an open match: ${input.reservationId}`);
  if (!member.level) throw conflict('no_level', `${member.name} has no rated level`);
  if (Number(member.level) < Number(match.level_min) || Number(member.level) > Number(match.level_max)) {
    throw conflict(
      'level_outside_band',
      `level ${member.level} is outside the band ${match.level_min}–${match.level_max}`,
    );
  }

  const booking = ctx.sql.query<{ price_amount: string; currency: string }>(
    'SELECT price_amount, currency FROM rally_bookings WHERE reservation_id = ?',
    [input.reservationId],
  )[0]!;
  const reservationRow = listReservations(ctx, {}).find((r) => r.id === input.reservationId)!;
  const share = moneyOf(
    String(Math.round(Number(booking.price_amount) / (reservationRow.fillTarget ?? 1))),
    booking.currency,
  );

  const result = joinReservation(ctx, {
    reservationId: input.reservationId,
    partyRef: dataSubjectId.parse(member.party_ref),
    share,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return { reservation: result.reservation, share };
};

/**
 * Blocking a court for maintenance is an ORDINARY reservation with no
 * participants (spec §4.1) — it rides the same overlap invariant, shows on the
 * calendar, and needs no second mechanism that could disagree with the first.
 */
const blockMaintenanceOp: OperationHandler<
  { resourceId: string; date: string; time: string; duration: number; reason: string; now?: string },
  Reservation
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageVenue));
  const v = venue(ctx);
  const startsAt = zonedToInstant(input.date, input.time, v.timezone);
  const now = input.now ?? ctx.now();
  const held = holdReservation(ctx, {
    resourceId: input.resourceId,
    startsAt,
    endsAt: addMinutes(startsAt, input.duration),
    expiresAt: addMinutes(now, 1),
    note: `maintenance: ${input.reason}`,
    now,
  });
  return confirmReservation(ctx, { reservationId: held.id, now });
};

/** Live participant count, via the engine's exported read — never its private tables. */
function joinedCount(ctx: OperationContext, reservationId: string): number {
  return engineGetReservation(ctx, reservationId).participants.filter((p) => !p.leftAt).length;
}

export interface OpenMatchListing {
  reservationId: string;
  resourceId: string;
  courtName: string;
  startsAt: string;
  endsAt: string;
  joined: number;
  fillTarget: number;
  levelMin: string;
  levelMax: string;
  share: Money;
  players: RosterEntry[];
}

/**
 * Open matches on offer. Browse-guarded rather than `booking:read`, because an
 * open match is PUBLISHED by definition — its whole purpose is to be found.
 *
 * It still reports counts, never identities: `joined: 2` of `fillTarget: 4`.
 * Showing who is already in would mean handing a browsing player other members'
 * names, which is precisely what `rally:browse` exists to avoid. Real rosters
 * with names and ratings are a player-tier concern (booking-social.md §4), fed
 * by participant events rather than read out of the club's scope.
 */
const openMatchesOp: OperationHandler<
  ({ now?: string } & ListPage) | undefined,
  Page<OpenMatchListing>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.browse));
  const now = input?.now ?? ctx.now();
  const courts = new Map(listResources(ctx, 'court').map((r) => [r.id, r.name] as const));
  const out: OpenMatchListing[] = [];

  for (const r of listReservations(ctx, { now })) {
    if (r.fillTarget === null) continue;
    if (r.effectiveState !== 'held' && r.effectiveState !== 'confirmed') continue;
    const band = ctx.sql.query<{ level_min: string; level_max: string }>(
      'SELECT level_min, level_max FROM rally_matches WHERE reservation_id = ?',
      [r.id],
    )[0];
    if (!band) continue;
    const booking = ctx.sql.query<{ price_amount: string; currency: string }>(
      'SELECT price_amount, currency FROM rally_bookings WHERE reservation_id = ?',
      [r.id],
    )[0];
    if (!booking) continue;
    const joined = joinedCount(ctx, r.id);
    if (joined >= r.fillTarget) continue; // full — no longer on offer
    out.push({
      reservationId: r.id,
      resourceId: r.resourceId,
      courtName: courts.get(r.resourceId) ?? '—',
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      joined,
      fillTarget: r.fillTarget,
      levelMin: band.level_min,
      levelMax: band.level_max,
      share: moneyOf(
        String(Math.round(Number(booking.price_amount) / r.fillTarget)),
        booking.currency,
      ),
      players: rosterOf(ctx, r.id),
    });
  }
  out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return pageBy(out, input ?? {}, (m) => m.reservationId);
};

export interface MatchLanding {
  status: 'open' | 'full' | 'expired' | 'gone';
  reservationId: string;
  courtName: string;
  venueName: string;
  startsAt: string;
  endsAt: string;
  joined: number;
  fillTarget: number;
  levelMin: string;
  levelMax: string;
  share: Money;
  players: RosterEntry[];
}

/**
 * One match, by id, for a shared link — INCLUDING the states a link dies in.
 *
 * `rally/open-matches` deliberately omits matches that are full or lapsed, which
 * makes it useless for a link someone taps an hour late: the honest answers are
 * "this filled up" and "this expired", and both need the row the list hides.
 *
 * Browse-guarded, like the list: a match link is published by definition. It
 * still reports counts and never identities.
 */
const matchLandingOp: OperationHandler<
  { reservationId: string; now?: string },
  MatchLanding | null
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.browse));
  const now = input.now ?? ctx.now();
  const r = listReservations(ctx, { now }).find((x) => x.id === input.reservationId);
  if (!r || r.fillTarget === null) return null;

  const band = ctx.sql.query<{ level_min: string; level_max: string }>(
    'SELECT level_min, level_max FROM rally_matches WHERE reservation_id = ?',
    [r.id],
  )[0];
  const booking = ctx.sql.query<{ price_amount: string; currency: string }>(
    'SELECT price_amount, currency FROM rally_bookings WHERE reservation_id = ?',
    [r.id],
  )[0];
  if (!band || !booking) return null;

  const joined = joinedCount(ctx, r.id);
  const dead = ['cancelled', 'expired', 'no_show'].includes(r.effectiveState);
  // A link dies at the start: turning up to join a match already underway is not
  // a thing, so time is as much an expiry as the hold deadline is.
  const started = r.startsAt <= now;
  const status: MatchLanding['status'] = dead
    ? 'gone'
    : started
      ? 'expired'
      : joined >= r.fillTarget
        ? 'full'
        : 'open';

  return {
    status,
    reservationId: r.id,
    courtName: listResources(ctx, 'court').find((c) => c.id === r.resourceId)?.name ?? '—',
    venueName: venue(ctx).name,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    joined,
    fillTarget: r.fillTarget,
    levelMin: band.level_min,
    levelMax: band.level_max,
    share: moneyOf(
      String(Math.round(Number(booking.price_amount) / r.fillTarget)),
      booking.currency,
    ),
    players: rosterOf(ctx, r.id),
  };
};

/**
 * Add a co-player to an ordinary booking — the "who else is playing" case, as
 * distinct from an open match anyone may join.
 *
 * KNOWN GAP: this cannot yet check that the caller is the booking's owner,
 * because the vertical has no principal → member mapping. `ctx.principal` is a
 * PrincipalId; a member is keyed by its party_ref (a DataSubjectId), and nothing
 * joins them. A player's `booking:create` is scope-wide (they must be able to
 * join a stranger's open match), so this currently admits adding a player to
 * anyone's booking. Closing it means either narrowing `booking:create` and
 * giving open-match joins their own key, or storing the principal on the member
 * row — a decision worth making deliberately rather than in passing.
 */
const addPlayerOp: OperationHandler<
  { reservationId: string; memberId: string; now?: string },
  { participants: number }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(BK.create, reservationRef(input.reservationId)));
  const member = ctx.sql.query<MemberRow>('SELECT * FROM rally_members WHERE id = ?', [
    input.memberId,
  ])[0];
  if (!member) throw substratError('not_found', `member not found: ${input.memberId}`);
  joinReservation(ctx, {
    reservationId: input.reservationId,
    partyRef: dataSubjectId.parse(member.party_ref),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return { participants: joinedCount(ctx, input.reservationId) };
};

export interface Occupancy {
  from: string;
  to: string;
  bookedHours: number;
  openHours: number;
  offPeakGapHours: number;
  revenue: Money;
  cancellations: number;
  noShows: number;
  /** [weekday 0-6][hour 0-23] → booked count, for the heatmap. */
  heat: number[][];
}

/**
 * Occupancy and revenue over a date range. Staff-only (`booking:read`): unlike
 * free/busy, this reports what the club actually earned.
 */
const occupancyOp: OperationHandler<{ from: string; to: string; now?: string }, Occupancy> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(BK.read));
  const v = venue(ctx);
  const now = input.now ?? ctx.now();
  const fromInstant = zonedToInstant(input.from, '00:00', v.timezone);
  const toInstant = zonedToInstant(input.to, '23:59', v.timezone);

  const heat: number[][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  let bookedMinutes = 0;
  let cancellations = 0;
  let noShows = 0;
  let revenue = 0;
  let currency = 'SEK';
  let offPeakGapMinutes = 0;

  const prices = new Map(
    ctx.sql
      .query<{ reservation_id: string; price_amount: string; currency: string }>(
        'SELECT reservation_id, price_amount, currency FROM rally_bookings',
      )
      .map((b) => [b.reservation_id, b] as const),
  );

  for (const r of listReservations(ctx, { from: fromInstant, to: toInstant, now })) {
    if (r.effectiveState === 'cancelled') {
      cancellations += 1;
      continue;
    }
    if (r.effectiveState === 'no_show') noShows += 1;
    if (!['confirmed', 'in_service', 'completed', 'no_show'].includes(r.effectiveState)) continue;

    const minutes = (Date.parse(r.endsAt) - Date.parse(r.startsAt)) / 60_000;
    bookedMinutes += minutes;

    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: v.timezone,
      weekday: 'short',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(new Date(r.startsAt));
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
      local.find((p) => p.type === 'weekday')?.value ?? 'Sun',
    );
    const hr = Number(local.find((p) => p.type === 'hour')?.value ?? '0') % 24;
    if (wd >= 0) heat[wd]![hr] = (heat[wd]![hr] ?? 0) + 1;

    const price = prices.get(r.id);
    if (price) {
      revenue += Number(price.price_amount);
      currency = price.currency;
    }
  }

  // Open capacity across the range: every court's bookable window per day.
  const courts = listResources(ctx, 'court').filter((c) => c.active);
  let openMinutes = 0;
  for (
    let d = Date.parse(`${input.from}T12:00:00Z`);
    d <= Date.parse(`${input.to}T12:00:00Z`);
    d += 86_400_000
  ) {
    const date = new Date(d).toISOString().slice(0, 10);
    for (const c of courts) {
      const w = bookableWindow(ctx, c.id, date);
      if (!w) continue;
      const span = (Date.parse(w.endsAt) - Date.parse(w.startsAt)) / 60_000;
      openMinutes += span;
      // Off-peak = outside 17–21, the hours a club most wants to fill.
      offPeakGapMinutes += Math.max(0, span - 4 * 60);
    }
  }

  return {
    from: input.from,
    to: input.to,
    bookedHours: Math.round(bookedMinutes / 60),
    openHours: Math.round(openMinutes / 60),
    offPeakGapHours: Math.max(0, Math.round((offPeakGapMinutes - bookedMinutes) / 60)),
    revenue: moneyOf(String(revenue), currency),
    cancellations,
    noShows,
    heat,
  };
};

/** A cheap "is this caller club staff?" probe, so the console can gate its own chrome. */
const canAdminOp: OperationHandler<undefined, { ok: true }> = async (ctx) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageVenue));
  return { ok: true };
};

/**
 * Open a booking you already hold, so others can join it.
 *
 * The third shape of open game, and the one a player reaches for most: you have
 * a court, you are short two, you put the spare places on offer. Composes the
 * engine's `openReservation` (fillTarget is engine state, because it drives the
 * auto-confirm) with this vertical's own level band.
 *
 * `spots` is what the player means — places to open — so the engine's target is
 * derived from it rather than asked for.
 */
const openUpOp: OperationHandler<
  { reservationId: string; spots: number; levelMin: string; levelMax: string; now?: string },
  { reservation: Reservation; share: Money }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(BK.confirm, reservationRef(input.reservationId)));
  const booking = ctx.sql.query<{ member_id: string | null; price_amount: string; currency: string }>(
    'SELECT member_id, price_amount, currency FROM rally_bookings WHERE reservation_id = ?',
    [input.reservationId],
  )[0];
  if (!booking) throw substratError('not_found', `no RallyPoint booking for ${input.reservationId}`);

  const onIt = joinedCount(ctx, input.reservationId);
  const fillTarget = onIt + input.spots;

  const reservation = openReservation(ctx, {
    reservationId: input.reservationId,
    fillTarget,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });

  ctx.sql.exec(
    `INSERT OR REPLACE INTO rally_matches (reservation_id, level_min, level_max, host_member_id)
     VALUES (?, ?, ?, ?)`,
    [input.reservationId, input.levelMin, input.levelMax, booking.member_id],
  );
  return {
    reservation,
    share: moneyOf(
      String(Math.round(Number(booking.price_amount) / Math.max(1, fillTarget))),
      booking.currency,
    ),
  };
};

/** Portal listing: a proof walk per reservation, never a WHERE clause on the caller. */
const portalBookingsOp: OperationHandler<
  ({ now?: string } & ListPage) | undefined,
  Page<Reservation>
> = async (ctx, input) => {
  const all = listReservations(ctx, input?.now !== undefined ? { now: input.now } : {});
  const visible: Reservation[] = [];
  for (const r of all) {
    const decision = await ctx.check(BK.read, reservationRef(r.id));
    if (decision.allowed) visible.push(r);
  }
  // A per-ROW filtered read cannot use `ctx.page`: a page of 20 filtered down to
  // 3 is not a page. The honest shape is the over-fetch this already does, paged
  // after the walk.
  return pageBy(visible, input ?? {}, (r) => r.id);
};

/**
 * #800. Like Meridian's, this paged on `occurred_at` with an `occurred_at > ?`
 * step — which drops every row sharing the last one's instant, and events emitted
 * by one operation all share it (`ctx.now()` is stable for the invocation,
 * #812). `readTimeline` walks the event id, so a page boundary inside a burst
 * resumes rather than skips.
 */
const timelineOp: OperationHandler<
  { entityType: string; entityId: string } & ListPage,
  Page<TimelineEntry>
> = async (ctx, input) => {
  const entity: EntityRef = z
    .object({ entityType: z.string().min(1), entityId: z.string().min(1) })
    .parse(input);
  assertAllowed(await ctx.check(BK.read, entity));
  return readTimeline(ctx, entity, input);
};

/**
 * Invite a player to this club, composing the invites engine (K-16).
 *
 * The engine records the invitation and keeps the identifier hashed; RallyPoint
 * keeps what only RallyPoint knows — the name to put on the member record and the
 * global party ref — in its OWN table, keyed by the invitation id. That is the
 * documented extension path: the engine's table is private, and a vertical never
 * adds a column upstream.
 */
const invitePlayerOp: OperationHandler<
  { orgId: string; identifier: string; name: string; partyRef?: string },
  { invitationId: string }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageMembers));
  // Optional since the admin screen landed: the desk invites a NEW person by
  // email and name, and a new person has no global player ref yet. A caller
  // that knows the ref (the same human from another club) still passes it.
  const partyRef = dataSubjectId.parse(input.partyRef ?? ulid());
  const { id } = await sendInvite(ctx, {
    orgId: orgIdSchema.parse(input.orgId),
    identifier: input.identifier,
    roleKey: 'player',
  });
  // INSERT OR REPLACE: re-inviting returns the SAME invitation id (the engine
  // refuses to reveal that it already exists), so this must be idempotent too or
  // a repeat invite would fail on the primary key and leak that fact.
  ctx.sql.exec(
    `INSERT OR REPLACE INTO rally_invited_player (invitation_id, party_ref, name) VALUES (?, ?, ?)`,
    [id, partyRef, input.name],
  );
  return { invitationId: id };
};

/**
 * The club's invitations, with the name the club filed them under.
 *
 * The engine's list is deliberately nameless — identifiers are hashed and never
 * returned — which is right for the engine and useless for a desk screen. The
 * name comes from RallyPoint's OWN side table, keyed by invitation id: the club
 * showing itself what it already knows, not the engine leaking anything.
 */
const listInvitesOp: OperationHandler<
  { orgId: string } & ListPage,
  Page<Invitation & { name: string | null }>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageMembers));
  const invitations = listInvites(ctx, orgIdSchema.parse(input.orgId));
  const names = new Map(
    ctx.sql
      .query<{ invitation_id: string; name: string }>(
        'SELECT invitation_id, name FROM rally_invited_player',
      )
      .map((r) => [r.invitation_id, r.name]),
  );
  const listing = invitations.map((i) => ({ ...i, name: names.get(i.id) ?? null }));
  return pageBy(listing, input, (i) => i.id);
};

/**
 * Withdraw an invitation. Same vocabulary as inviting: this is desk work, so it
 * checks `rally:manage-members` — the club's word — not the engine's key.
 * Idempotent and silent on settled invitations, like the function it composes.
 */
const revokeInviteOp: OperationHandler<{ invitationId: string }, { ok: true }> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(RALLY_PERM.manageMembers));
  revokeInvite(ctx, z.string().min(1).parse(input.invitationId));
  return { ok: true };
};

/**
 * A player accepted — give them a member record at this venue.
 *
 * Idempotent on `party_ref`, which is UNIQUE: delivery is at-least-once, so this
 * consumer will be re-run, and a second member row would give one human two
 * wallets at the same club.
 */
const onInviteAccepted: ConsumerHandler = (ctx, event) => {
  const payload = z
    .object({ invitationId: z.string(), principal: z.string() })
    .parse(event.payload);
  const invited = ctx.sql.query<{ party_ref: string; name: string }>(
    'SELECT party_ref, name FROM rally_invited_player WHERE invitation_id = ?',
    [payload.invitationId],
  )[0];
  // An invitation this club did not send — another vertical's, or a direct call.
  // Not an error: the kernel membership still stands, RallyPoint simply has no
  // record to create.
  if (!invited) return;
  const existing = ctx.sql.query<{ id: string }>(
    'SELECT id FROM rally_members WHERE party_ref = ?',
    [invited.party_ref],
  );
  if (existing[0]) return;
  ctx.sql.exec(
    `INSERT INTO rally_members (id, party_ref, name, phone, level, created_at)
     VALUES (?, ?, ?, NULL, NULL, ?)`,
    [ulid(), invited.party_ref, invited.name, ctx.now()],
  );
};

export const rallyModule: ModuleRegistration = {
  manifest: rallyManifest,
  migrations: rallyMigrations,
  consumers: { 'invites.accepted': onInviteAccepted },
  operations: {
    'rally/set-venue': setVenueOp as never,
    'rally/set-hours': setHoursOp as never,
    'rally/set-court-hours': setCourtHoursOp as never,
    'rally/register-court': registerCourtOp as never,
    'rally/add-closure': addClosureOp as never,
    'rally/upsert-price-rule': upsertPriceRuleOp as never,
    'rally/upsert-pack': upsertPackOp as never,
    'rally/upsert-plan': upsertPlanOp as never,
    'rally/invite-player': invitePlayerOp as never,
    'rally/list-invites': listInvitesOp as never,
    'rally/revoke-invite': revokeInviteOp as never,
    'rally/wallet': walletOp as never,
    'rally/buy-credits': buyCreditsOp as never,
    'rally/subscribe': subscribeOp as never,
    'rally/cancel-subscription': cancelSubscriptionOp as never,
    'rally/run-billing': runBillingOp as never,
    'rally/create-member': createMemberOp as never,
    'rally/list-members': listMembersOp as never,
    'rally/get-venue': getVenueOp as never,
    'rally/courts': browseCourtsOp as never,
    'rally/venue-availability': venueAvailabilityOp as never,
    'rally/quote': quoteOp as never,
    'rally/price-matrix': priceMatrixOp as never,
    'rally/played-with': playedWithOp as never,
    'rally/availability': availabilityOp as never,
    'rally/book-court': bookCourtOp as never,
    'rally/confirm-booking': confirmBookingOp as never,
    'rally/create-open-match': createOpenMatchOp as never,
    'rally/join-match': joinMatchOp as never,
    'rally/open-matches': openMatchesOp as never,
    'rally/open-up': openUpOp as never,
    'rally/match': matchLandingOp as never,
    'rally/occupancy': occupancyOp as never,
    'rally/can-admin': canAdminOp as never,
    'rally/add-player': addPlayerOp as never,
    'rally/block-maintenance': blockMaintenanceOp as never,
    'rally/portal-bookings': portalBookingsOp as never,
    'rally/timeline': timelineOp as never,
  },
  /**
   * #893: the host parses each operation's declared `input` before the guards
   * and the handler see it. Derived from the same declaration that produces the
   * manifest and the routes — the schema is written once, in `operations.ts`.
   */
  operationInputs: operationInputsOf(rallyOperations),
};
