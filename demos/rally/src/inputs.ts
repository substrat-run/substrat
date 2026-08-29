import { z } from '@substrat-run/contracts';
import { cover } from './schemas.js';

/**
 * What RallyPoint's operations ACCEPT (#707/#865/#891).
 *
 * Thirty-six of these were inline TypeScript object types on the handler
 * signatures; two (`bookInput`, `openMatchInput`) were already schemas and moved
 * here unchanged. `defineOperations` declares each operation's `input` as a
 * schema, and a declaration file that imports the implementation would close a
 * cycle — so they live below both, the way `entities.ts` and `schemas.ts` do.
 *
 * **These declare the shape; most handlers do not yet parse against them.**
 * Rally predates "parse, don't trust" for its own operations — only the booking
 * pair called `.parse()` — and turning thirty-six trusting handlers into
 * validating ones is a behaviour change to a live demo, not a declaration. It is
 * called out in the changeset rather than smuggled in here: the schemas are now
 * written down and the compiler holds `idFrom` to them, which is what #891 needs;
 * the parse call sites are the follow-up.
 *
 * `date` / `time` regexes match `bookInput`'s, which is where they came from.
 *
 * **No input below declares `now`, and that absence is the point (#1065).**
 * RallyPoint composes `engine-booking` by call, and the engine's `nowOr` prefers a
 * caller-supplied instant over `ctx.now()` — so an input that carried `now` would
 * hand an HTTP caller the clock every expiry decision is judged against: confirm a
 * lapsed hold by back-dating it, sweep someone's live hold by post-dating it, or
 * read a match landing page that lies about whether the link is still good. #1055
 * closed that on the engine's own wire (`atInstant`, `engines/booking/src/schemas.ts`);
 * declaring it here would have re-opened it one layer up. The reads carried it too
 * and are gone for the same reason: `rally/open-matches`, `rally/match`,
 * `rally/portal-bookings` and `rally/occupancy` all report the engine's lazily
 * computed `effectiveState`, so a chosen `now` decides what they say is expired.
 *
 * `now` stays a parameter of the engine's in-scope functions, which is what keeps
 * lazy expiry replayable; a test moves a `manualClock` on the host instead, so it
 * exercises the same path the wire does (`test/wire-clock.test.ts`).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const clockTime = z.string().regex(/^\d{2}:\d{2}$/);

// --- venue configuration ----------------------------------------------------

export const setVenueInput = z.object({
  name: z.string().min(1),
  timezone: z.string().min(1),
  holdMinutes: z.number().int().positive().optional(),
});

export const setHoursInput = z.object({
  weekday: z.number().int().min(0).max(6),
  opensAt: clockTime.optional(),
  closesAt: clockTime.optional(),
  closed: z.boolean().optional(),
});

export const setCourtHoursInput = setHoursInput.extend({ resourceId: z.string().min(1) });

export const registerCourtInput = z.object({
  resourceId: z.string().min(1),
  durations: z.string().optional(),
  cover: cover.optional(),
});

export const addClosureInput = z.object({
  resourceId: z.string().min(1).optional(),
  onDate: isoDate,
  opensAt: clockTime.optional(),
  closesAt: clockTime.optional(),
  reason: z.string().min(1),
});

export const upsertPriceRuleInput = z.object({
  id: z.string().min(1).optional(),
  label: z.string().min(1),
  resourceId: z.string().min(1).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  fromTime: clockTime.optional(),
  toTime: clockTime.optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  duration: z.number().int().positive().optional(),
  amount: z.string(),
  currency: z.string().optional(),
});

export const upsertPackInput = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  priceOre: z.number().int(),
  creditOre: z.number().int(),
});

export const upsertPlanInput = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  monthlyOre: z.number().int(),
  monthlyCreditOre: z.number().int(),
});

// --- money ------------------------------------------------------------------

export const memberIdInput = z.object({ memberId: z.string().min(1) });

export const buyCreditsInput = memberIdInput.extend({ packKey: z.string().min(1) });

export const subscribeInput = memberIdInput.extend({
  planKey: z.string().min(1),
  on: isoDate,
});

export const cancelSubscriptionInput = z.object({ subscriptionId: z.string().min(1) });

export const runBillingInput = z.object({ on: isoDate });

// --- directory --------------------------------------------------------------

export const createMemberInput = z.object({
  partyRef: z.string().min(1),
  name: z.string().min(1),
  phone: z.string().optional(),
  level: z.string().optional(),
});

// --- reads ------------------------------------------------------------------

export const availabilityInput = z.object({
  resourceId: z.string().min(1),
  date: isoDate,
});

export const venueAvailabilityInput = z.object({
  date: isoDate,
  cover: z.array(cover).optional(),
});

export const quoteInput = z.object({
  date: isoDate,
  time: clockTime,
  duration: z.number().int().positive(),
  resourceId: z.string().min(1).optional(),
  cover: z.array(cover).optional(),
});

export const priceMatrixInput = z.object({ date: isoDate });

export const timelineInput = z.object({
  entityType: z.string().min(1),
  entityId: z.string().min(1),
});

// --- booking ----------------------------------------------------------------

export const bookInput = z.object({
  /** Omitted = the vertical picks one (spec §4.2). Staff pass it; players rarely do. */
  resourceId: z.string().min(1).optional(),
  cover: z.array(z.enum(['indoor', 'covered', 'open'])).optional(),
  memberId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  duration: z.number().int().positive(),
});

export const openMatchInput = bookInput.extend({
  /** Omitted = the CLUB opens the game: no host, every place on offer. */
  memberId: z.string().min(1).optional(),
  fillTarget: z.number().int().min(2).max(4).default(4),
  levelMin: z.string(),
  levelMax: z.string(),
});

export const reservationIdInput = z.object({ reservationId: z.string().min(1) });

export const confirmBookingInput = reservationIdInput.extend({
  payWith: z.enum(['wallet', 'card']).optional(),
});

export const joinMatchInput = reservationIdInput.extend({
  memberId: z.string().min(1),
});

export const addPlayerInput = joinMatchInput;

export const blockMaintenanceInput = z.object({
  resourceId: z.string().min(1),
  date: isoDate,
  time: clockTime,
  duration: z.number().int().positive(),
  reason: z.string().min(1),
});

export const openUpInput = reservationIdInput.extend({
  spots: z.number().int().positive(),
  levelMin: z.string(),
  levelMax: z.string(),
});

export const occupancyInput = z.object({
  from: isoDate,
  to: isoDate,
});

// --- invitations ------------------------------------------------------------

export const orgIdInput = z.object({ orgId: z.string().min(1) });

export const invitePlayerInput = orgIdInput.extend({
  identifier: z.string().min(1),
  name: z.string().min(1),
  partyRef: z.string().min(1).optional(),
});

export const revokeInviteInput = z.object({ invitationId: z.string().min(1) });
