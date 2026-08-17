import { defineEntities } from '@substrat-run/contracts';
import { z } from 'zod';

/**
 * engine-booking's entities (#697/#707).
 *
 * The first engine with TWO entities and a parent edge INSIDE itself: a
 * reservation hangs off the resource it books. Everywhere else so far the parent
 * has been the vertical's noun, so `parents` has been empty in engine registries
 * — here the edge is genuinely the engine's, because a reservation cannot exist
 * without the resource it reserves.
 */
export const bookingEntities = defineEntities({
  resource: {
    table: 'booking_resources',
    fields: z.object({
      id: z.string(),
      kind: z.string(),
      name: z.string(),
      capacity: z.number(),
      active: z.number(),
      created_at: z.string(),
    }),
  },
  reservation: {
    table: 'booking_reservations',
    fields: z.object({
      id: z.string(),
      resource_id: z.string(),
      starts_at: z.string(),
      ends_at: z.string(),
      state: z.enum(['held', 'confirmed', 'in_service', 'completed', 'expired', 'cancelled', 'no_show']),
      quantity: z.number(),
      expires_at: z.string().nullable(),
      fill_target: z.number().nullable(),
      note: z.string().nullable(),
      created_by: z.string(),
      created_at: z.string(),
    }),
    // The engine's OWN edge, not the vertical's: a reservation reserves a
    // resource, and that is true in every vertical that composes this.
    parents: ['resource'],
  },
  // `booking_participants` is a join row, not an entity — never an EntityRef.
});

export const resourceRow = bookingEntities.resource.fields;
export const reservationRow = bookingEntities.reservation.fields;
