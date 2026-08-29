/**
 * RallyPoint's declared operation surface (#707/#865/#891).
 *
 * ## Why this file exists now
 *
 * Thirty-eight handlers registered as `'rally/wallet': walletOp as never`, and
 * the only description of what each one checked was its body. Eight of those
 * checks narrow to an entity, and `entityCheckConformanceSuite` derives its
 * behavioural pair from an operation's `permission` — so undeclared, they were
 * not merely untested but **undeclarable**. To a compiler `ctx.check(BK.read,
 * memberRef(id))` and `ctx.check(BK.read)` are the same, and the second hands
 * every player the whole club's book. Rally mints per-member grants for exactly
 * that reason (§4 of its `PERMISSIONS.md`): a player's `booking:read` is narrowed
 * to their own record, which is the only thing standing between them and every
 * other member's wallet, partners and bookings.
 *
 * ## The engine entity rally narrows to
 *
 * `reservation` belongs to **engine-booking**, not to rally — `entities.ts` says
 * so, and the club's `reservation → member` edge is declared in the manifest
 * against the engine's registry. Three operations narrow to it, which is what
 * `defineOperations`' composed-engine parameter is for.
 *
 * ## Two checks the format cannot state, named rather than hidden
 *
 * **`rally/cancel-subscription`** narrows to `memberRef(sub.member_id)` — the
 * member is read off the SUBSCRIPTION row, and the input carries only a
 * subscription id. That is `resolved`: the kit cannot reach the entity, and says
 * so in its uncovered list rather than skipping it quietly.
 *
 * **`rally/portal-bookings`** declares `narrows`. It walks every reservation and
 * asks per row, which is a proof walk rather than one entity check — the same
 * shape as Callout's portal read, and the scenario's portal-isolation beat is
 * what proves it.
 *
 * `rally/timeline` takes a caller-named `entityType` and declares the constant
 * every call site passes. That is #890, and rally is its fourth instance.
 */
import { defineOperations, z } from '@substrat-run/contracts';
import { bookingEntities } from '@substrat-run/engine-booking';
import { rallyEntities } from './entities.js';
import {
  addClosureInput,
  addPlayerInput,
  availabilityInput,
  blockMaintenanceInput,
  bookInput,
  buyCreditsInput,
  cancelSubscriptionInput,
  confirmBookingInput,
  createMemberInput,
  invitePlayerInput,
  joinMatchInput,
  memberIdInput,
  occupancyInput,
  openMatchInput,
  openUpInput,
  orgIdInput,
  priceMatrixInput,
  quoteInput,
  registerCourtInput,
  reservationIdInput,
  revokeInviteInput,
  runBillingInput,
  setCourtHoursInput,
  setHoursInput,
  setVenueInput,
  subscribeInput,
  timelineInput,
  upsertPackInput,
  upsertPlanInput,
  upsertPriceRuleInput,
  venueAvailabilityInput,
} from './inputs.js';
import {
  closureRow,
  courtHoursRow,
  courtListing,
  courtRow,
  creditPackRow,
  hoursRow,
  invitationListing,
  matchLanding,
  memberRow,
  occupancy,
  openMatchListing,
  planRow,
  priceRuleRow,
  reservation,
  rosterEntry,
  slotFit,
  subscriptionRow,
  timelineEntry,
  venueRow,
  venueSlot,
  venueSnapshot,
  walletEntryRow,
} from './schemas.js';
import { money } from '@substrat-run/contracts';

/**
 * Every key these operations check — rally's own, plus engine-booking's.
 *
 * `booking:*` belongs to engine-booking (aliased as `BK` at its reference sites,
 * so the ownership is visible). The keys appear here because `defineOperations`
 * checks each declared `permission` against this list; the MANIFEST still
 * declares only the five keys rally owns.
 */
export const RALLY_PERMISSIONS = [
  'rally:browse',
  'rally:wallet',
  'rally:manage-members',
  'rally:manage-pricing',
  'rally:manage-venue',
  'booking:read',
  'booking:hold',
  'booking:create',
  'booking:confirm',
] as const;

/** The narrowed check three member-facing reads share. */
const onMember = (key: (typeof RALLY_PERMISSIONS)[number]) =>
  ({ key, entity: 'member', idFrom: 'memberId' }) as const;

/** The narrowed check three reservation-facing mutations share. */
const onReservation = (key: (typeof RALLY_PERMISSIONS)[number]) =>
  ({ key, entity: 'reservation', idFrom: 'reservationId' }) as const;

const pricedReservation = z.object({
  reservation,
  price: money,
  label: z.string(),
});

export const rallyOperations = defineOperations(
  rallyEntities,
  RALLY_PERMISSIONS,
  // engine-booking, so an operation may narrow to `reservation` — the entity the
  // ENGINE owns and rally's manifest hangs its `member` edge off.
  [bookingEntities],
)({
  // --- venue configuration --------------------------------------------------
  'rally/set-venue': {
    summary: 'Set the club name, timezone and hold window',
    permission: 'rally:manage-venue',
    input: setVenueInput,
    output: venueRow,
  },
  'rally/set-hours': {
    summary: 'Set the club opening hours for one weekday',
    permission: 'rally:manage-venue',
    input: setHoursInput,
    output: hoursRow,
  },
  'rally/set-court-hours': {
    summary: "Set one court's hours for one weekday",
    permission: 'rally:manage-venue',
    input: setCourtHoursInput,
    output: courtHoursRow,
  },
  'rally/register-court': {
    summary: 'Register a court against an engine resource',
    permission: 'rally:manage-venue',
    input: registerCourtInput,
    output: courtRow,
  },
  'rally/add-closure': {
    summary: 'Close the club or one court for a date',
    permission: 'rally:manage-venue',
    input: addClosureInput,
    output: closureRow,
  },
  'rally/upsert-price-rule': {
    summary: 'Create or update a price rule',
    permission: 'rally:manage-pricing',
    input: upsertPriceRuleInput,
    output: priceRuleRow,
  },
  'rally/upsert-pack': {
    summary: 'Create or update a credit pack',
    permission: 'rally:manage-pricing',
    input: upsertPackInput,
    output: creditPackRow,
  },
  'rally/upsert-plan': {
    summary: 'Create or update a membership plan',
    permission: 'rally:manage-pricing',
    input: upsertPlanInput,
    output: planRow,
  },

  // --- money ----------------------------------------------------------------
  'rally/wallet': {
    summary: "One member's balance and wallet history",
    permission: onMember('booking:read'),
    input: memberIdInput,
    output: z.object({ balance: money, entries: z.array(walletEntryRow) }),
  },
  'rally/buy-credits': {
    summary: 'Buy a credit pack',
    permission: 'rally:wallet',
    input: buyCreditsInput,
    output: z.object({ balance: money, paid: money, received: money }),
  },
  'rally/subscribe': {
    summary: 'Subscribe a member to a plan',
    permission: 'rally:wallet',
    input: subscribeInput,
    output: subscriptionRow,
  },
  'rally/cancel-subscription': {
    summary: 'Cancel a subscription',
    // Narrowed to the member the SUBSCRIPTION names, which the input does not
    // carry — see the header.
    permission: {
      key: 'booking:read',
      entity: 'member',
      resolved: 'the member is read off the subscription row',
    },
    input: cancelSubscriptionInput,
    output: subscriptionRow,
  },
  'rally/run-billing': {
    summary: 'Charge every subscription due on a date',
    permission: 'rally:manage-pricing',
    input: runBillingInput,
    output: z.object({ charged: z.number(), creditedOre: z.number() }),
  },

  // --- directory ------------------------------------------------------------
  'rally/create-member': {
    summary: 'Create a club member',
    permission: 'rally:manage-members',
    input: createMemberInput,
    output: memberRow,
  },
  'rally/list-members': {
    summary: 'Club members',
    permission: 'rally:manage-members',
    output: memberRow,
    paged: {
      over: { entity: 'member', sortable: ['name', 'created_at'], filterable: ['level'] },
    },
  },

  // --- reads ----------------------------------------------------------------
  'rally/courts': {
    summary: 'Courts as a player may see them',
    permission: 'rally:browse',
    output: courtListing,
    paged: { sortKey: 'id' },
  },
  'rally/get-venue': {
    summary: "The club's shape — hours, courts, prices, closures",
    permission: 'booking:read',
    output: venueSnapshot,
  },
  'rally/availability': {
    summary: 'Free starts on one court for a date',
    permission: 'rally:browse',
    input: availabilityInput,
    output: slotFit,
    // Computed segments, disjoint and in order — so `startsAt` is unique here.
    paged: { sortKey: 'startsAt' },
  },
  'rally/venue-availability': {
    summary: 'Free starts across the club for a date',
    permission: 'rally:browse',
    input: venueAvailabilityInput,
    output: venueSlot,
    paged: { sortKey: 'startsAt' },
  },
  'rally/played-with': {
    summary: "Who this member has played with, most often first",
    permission: onMember('booking:read'),
    input: memberIdInput,
    output: z.object({
      /**
       * The tally's own key, and the cursor this list pages on. It was already
       * what the fold keyed by; it simply was not published, and a page needs a
       * unique field to walk.
       */
      partyRef: z.string(),
      name: z.string(),
      level: z.string().nullable(),
      times: z.number(),
      lastPlayed: z.string(),
    }),
    paged: { sortKey: 'partyRef' },
  },
  'rally/quote': {
    summary: 'What a slot would cost',
    permission: 'rally:browse',
    input: quoteInput,
    output: z.object({
      price: money,
      label: z.string(),
      courts: z.array(z.object({ id: z.string(), name: z.string(), cover: courtRow.shape.cover })),
    }),
  },
  'rally/price-matrix': {
    summary: 'The price grid for a date',
    permission: 'rally:manage-pricing',
    input: priceMatrixInput,
    output: z.object({
      time: z.string(),
      cells: z.array(
        z.object({ duration: z.number(), amount: z.string(), label: z.string() }),
      ),
    }),
    // One row per hour, so `time` is unique within the grid.
    paged: { sortKey: 'time' },
  },

  // --- booking --------------------------------------------------------------
  'rally/book-court': {
    summary: 'Hold a court',
    permission: 'booking:hold',
    input: bookInput,
    output: pricedReservation,
  },
  'rally/confirm-booking': {
    summary: 'Confirm a held booking and take payment',
    permission: onReservation('booking:confirm'),
    input: confirmBookingInput,
    output: pricedReservation,
  },
  'rally/create-open-match': {
    summary: 'Hold a court as an open match',
    permission: 'booking:hold',
    input: openMatchInput,
    output: pricedReservation,
  },
  'rally/join-match': {
    summary: 'Join an open match',
    permission: 'rally:wallet',
    input: joinMatchInput,
    output: z.object({ reservation, share: money }),
  },
  'rally/block-maintenance': {
    summary: 'Block a court for maintenance',
    permission: 'rally:manage-venue',
    input: blockMaintenanceInput,
    output: reservation,
  },
  'rally/open-matches': {
    summary: 'Open matches a player may join',
    permission: 'rally:browse',
    output: openMatchListing,
    paged: { sortKey: 'reservationId' },
  },
  'rally/match': {
    summary: 'One open match, as its landing page shows it',
    permission: 'rally:browse',
    input: reservationIdInput,
    output: matchLanding.nullable(),
  },
  'rally/add-player': {
    summary: 'Add a player to a reservation',
    permission: onReservation('booking:create'),
    input: addPlayerInput,
    output: z.object({ participants: z.number() }),
  },
  'rally/occupancy': {
    summary: 'Utilisation and revenue over a range',
    permission: 'rally:manage-venue',
    input: occupancyInput,
    output: occupancy,
  },
  'rally/can-admin': {
    summary: 'Whether the caller may open the back office',
    permission: 'rally:manage-venue',
    output: z.object({ ok: z.literal(true) }),
  },
  'rally/open-up': {
    summary: 'Put spare places on a booking on offer',
    permission: onReservation('booking:confirm'),
    input: openUpInput,
    output: z.object({ reservation, share: money }),
  },
  'rally/portal-bookings': {
    summary: "The caller's own bookings",
    // A per-row proof walk, not one entity check — see the header.
    narrows: {
      reason: 'walks every reservation and asks per row, so a player sees only their own',
      checks: [],
    },
    output: reservation,
    paged: { sortKey: 'id' },
  },
  'rally/timeline': {
    summary: 'The spine, for one entity',
    permission: { key: 'booking:read', entity: 'member', idFrom: 'entityId' },
    input: timelineInput,
    output: timelineEntry,
    // The cursor is `id` — the event's ULID, and this member's version at that
    // point (#901). It said `occurred_at`, and so did the handler's walk, which
    // is how the page came to drop every event sharing an instant (#800).
    paged: { sortKey: 'id' },
  },

  // --- invitations ----------------------------------------------------------
  'rally/invite-player': {
    summary: 'Invite a player to the club',
    permission: 'rally:manage-members',
    input: invitePlayerInput,
    output: z.object({ invitationId: z.string() }),
  },
  'rally/list-invites': {
    summary: 'Outstanding invitations',
    permission: 'rally:manage-members',
    input: orgIdInput,
    output: invitationListing,
    paged: { sortKey: 'id' },
  },
  'rally/revoke-invite': {
    summary: 'Revoke an invitation',
    permission: 'rally:manage-members',
    input: revokeInviteInput,
    output: z.object({ ok: z.literal(true) }),
  },
});
