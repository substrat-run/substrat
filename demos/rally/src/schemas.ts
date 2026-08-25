import { money, z } from '@substrat-run/contracts';
import { reservation } from '@substrat-run/engine-booking';
import { invitation } from '@substrat-run/engine-invites';
import { rallyEntities } from './entities.js';

/**
 * What RallyPoint's operations ANSWER, as schemas (#707/#865/#891).
 *
 * These were twenty hand-written `export interface`s in `module.ts`. They became
 * schemas because `defineOperations` declares an operation's `output`, and a
 * TypeScript interface cannot be one.
 *
 * `member` is derived from the registry rather than restated — `rally_members` is
 * described once, in `entities.ts`. The rest are tables and projections this
 * vertical owns that are deliberately not entities (`entities.ts` says why: a
 * ledger delta is not something a grant narrows to), so there is no registry
 * entry to derive them from.
 *
 * Two come from the ENGINES rally composes: `reservation` is engine-booking's
 * published projection and `invitation` is engine-invites'. Imported rather than
 * re-described — a vertical restating an engine's shape is the two-descriptions
 * defect decision 28 exists to prevent.
 *
 * `module.ts` re-exports every type below, so nothing that imported a row shape
 * from there had to change.
 */

export { reservation, invitation };

export const memberRow = rallyEntities.member.fields;
export type MemberRow = z.infer<typeof memberRow>;

export const venueRow = z.object({
  id: z.string(),
  name: z.string(),
  timezone: z.string(),
  hold_minutes: z.number(),
});
export type VenueRow = z.infer<typeof venueRow>;

export const walletEntryRow = z.object({
  id: z.string(),
  member_id: z.string(),
  delta_ore: z.number(),
  reason: z.string(),
  reservation_id: z.string().nullable(),
  created_at: z.string(),
});
export type WalletEntryRow = z.infer<typeof walletEntryRow>;

export const creditPackRow = z.object({
  key: z.string(),
  title: z.string(),
  price_ore: z.number(),
  credit_ore: z.number(),
});
export type CreditPackRow = z.infer<typeof creditPackRow>;

export const planRow = z.object({
  key: z.string(),
  title: z.string(),
  monthly_ore: z.number(),
  monthly_credit_ore: z.number(),
});
export type PlanRow = z.infer<typeof planRow>;

export const subscriptionRow = z.object({
  id: z.string(),
  member_id: z.string(),
  plan_key: z.string(),
  status: z.enum(['active', 'cancelled']),
  started_on: z.string(),
  next_charge_on: z.string(),
  cancelled_at: z.string().nullable(),
});
export type SubscriptionRow = z.infer<typeof subscriptionRow>;

export const hoursRow = z.object({
  weekday: z.number(),
  opens_at: z.string().nullable(),
  closes_at: z.string().nullable(),
  closed: z.number(),
});
export type HoursRow = z.infer<typeof hoursRow>;

export const courtHoursRow = hoursRow.extend({ resource_id: z.string() });
export type CourtHoursRow = z.infer<typeof courtHoursRow>;

export const closureRow = z.object({
  id: z.string(),
  resource_id: z.string().nullable(),
  on_date: z.string(),
  opens_at: z.string().nullable(),
  closes_at: z.string().nullable(),
  reason: z.string(),
  created_at: z.string(),
});
export type ClosureRow = z.infer<typeof closureRow>;

export const priceRuleRow = z.object({
  id: z.string(),
  label: z.string(),
  resource_id: z.string().nullable(),
  weekday: z.number().nullable(),
  from_time: z.string().nullable(),
  to_time: z.string().nullable(),
  from_date: z.string().nullable(),
  to_date: z.string().nullable(),
  duration: z.number().nullable(),
  amount: z.string(),
  currency: z.string(),
  created_at: z.string(),
});
export type PriceRuleRow = z.infer<typeof priceRuleRow>;

export const cover = z.enum(['indoor', 'covered', 'open']);
export type Cover = z.infer<typeof cover>;

export const courtRow = z.object({
  resource_id: z.string(),
  durations: z.string(),
  cover,
});
export type CourtRow = z.infer<typeof courtRow>;

/** What the slot picker needs: per start, the longest duration that actually fits. */
export const slotFit = z.object({
  startsAt: z.string(),
  maxFitMinutes: z.number(),
  fits: z.array(z.number()),
});
export type SlotFit = z.infer<typeof slotFit>;

export const courtListing = z.object({
  id: z.string(),
  name: z.string(),
  durations: z.string(),
  cover,
});
export type CourtListing = z.infer<typeof courtListing>;

export const venueSnapshot = z.object({
  venue: venueRow,
  hours: z.array(hoursRow),
  courtHours: z.array(courtHoursRow),
  courts: z.array(courtRow),
  creditPacks: z.array(creditPackRow),
  plans: z.array(planRow),
  priceRules: z.array(priceRuleRow),
  closures: z.array(closureRow),
});
export type VenueSnapshot = z.infer<typeof venueSnapshot>;

export const rosterEntry = z.object({
  partyRef: z.string(),
  name: z.string(),
  level: z.string().nullable(),
  share: money.nullable(),
});
export type RosterEntry = z.infer<typeof rosterEntry>;

export const venueSlot = z.object({
  startsAt: z.string(),
  /** Durations that fit on at least one court in the filtered pool. */
  fits: z.array(z.number()),
  courts: z.array(
    z.object({ id: z.string(), name: z.string(), cover, fits: z.array(z.number()) }),
  ),
});
export type VenueSlot = z.infer<typeof venueSlot>;

export const openMatchListing = z.object({
  reservationId: z.string(),
  resourceId: z.string(),
  courtName: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  joined: z.number(),
  fillTarget: z.number(),
  levelMin: z.string(),
  levelMax: z.string(),
  share: money,
  players: z.array(rosterEntry),
});
export type OpenMatchListing = z.infer<typeof openMatchListing>;

export const matchLanding = z.object({
  status: z.enum(['open', 'full', 'expired', 'gone']),
  reservationId: z.string(),
  courtName: z.string(),
  venueName: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  joined: z.number(),
  fillTarget: z.number(),
  levelMin: z.string(),
  levelMax: z.string(),
  share: money,
  players: z.array(rosterEntry),
});
export type MatchLanding = z.infer<typeof matchLanding>;

export const occupancy = z.object({
  from: z.string(),
  to: z.string(),
  bookedHours: z.number(),
  openHours: z.number(),
  offPeakGapHours: z.number(),
  revenue: money,
  cancellations: z.number(),
  noShows: z.number(),
  /** [weekday 0-6][hour 0-23] → booked count, for the heatmap. */
  heat: z.array(z.array(z.number())),
});
export type Occupancy = z.infer<typeof occupancy>;

/**
 * One entry of the spine, as `rally/timeline` answers it — the KERNEL's shape (#800),
 * re-exported rather than re-described.
 *
 * This was a local `z.object({ type, occurred_at, actor })`, and so were three
 * other demos' — four descriptions of one table, none of which said that `actor`
 * is stored as JSON over a union and is not the id it looks like. `readTimeline`
 * owns the walk, so it owns the entry.
 */
export { timelineEntry, type TimelineEntry } from '@substrat-run/contracts';

/** An invitation as rally lists it — the engine's row, plus the member's name. */
export const invitationListing = invitation.extend({ name: z.string().nullable() });
