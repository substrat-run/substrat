/**
 * The notifications engine's declared operation surface.
 *
 * Two audiences. A person manages their OWN notifications — where they go, and which topics
 * reach them — under `notifications:self`, and every one of those operations acts on the
 * caller's principal and takes no principal as input, so holding the key never reaches
 * anybody else's address. An administrator reads the delivery log for the scope under
 * `notifications:read`, which is how "why did nobody hear about this" gets an answer. The
 * third key, `notifications:send-digests`, is the digest schedule's: the engine's system
 * principal holds it, and no person may (`lint:permissions` refuses a role granting it).
 *
 * Node checks only, and that is the design: the entities are a person's own preferences and
 * a log about the scope, neither of which narrows to a record somebody else holds a grant on.
 *
 * No `http`: an engine owns no URL shape; a composing vertical binds these with
 * `defineEngineRoutes`.
 */
import { defineOperations, z } from '@substrat-run/contracts';
import { deliveryRow, digestCadence, notificationsEntities } from './entities.js';

/** The keys these operations check. Mirrors `NOTIFICATIONS_PERM` in index.ts. */
export const NOTIFICATIONS_PERMISSIONS = ['notifications:self', 'notifications:read', 'notifications:send-digests'] as const;

/** The channels a delivery can go out on. One today; the enum is where the next one is added. */
export const notificationChannel = z.enum(['email']);
export type NotificationChannel = z.infer<typeof notificationChannel>;

/**
 * When a topic reaches a person: `immediate`, one mail per occasion, or held for their
 * `daily-digest`. Immediate is the default and is never stored.
 */
export const notificationCadence = z.enum(['immediate', ...digestCadence.options]);
export type NotificationCadence = z.infer<typeof notificationCadence>;

/** One topic as a person sees it on their own preferences screen. */
export const topicPreference = z.object({
  topic: z.string(),
  description: z.string(),
  channel: notificationChannel,
  enabled: z.boolean(),
  /** A required topic cannot be switched off — a security notice, a signature to give. */
  required: z.boolean(),
  /** When it reaches them. A required topic is always `immediate`. */
  cadence: notificationCadence,
});

export const myPreferences = z.object({
  /** Where this person's notifications go; null until they (or the vertical on their behalf) set one. */
  email: z.string().nullable(),
  topics: z.array(topicPreference),
});

export const notificationsOperations = defineOperations(notificationsEntities, NOTIFICATIONS_PERMISSIONS)({
  'notifications/my-preferences': {
    summary: "The caller's notification address and every topic's switch",
    permission: 'notifications:self',
    input: z.object({}),
    inputOptional: true,
    output: myPreferences,
  },

  'notifications/set-my-address': {
    summary: "Set or clear where the caller's notifications go",
    permission: 'notifications:self',
    // `null` clears it: every topic then records `skipped: no_address` for this person.
    input: z.object({ email: z.string().email().nullable() }),
    output: myPreferences,
  },

  'notifications/set-my-preference': {
    summary: 'Switch one topic on or off for the caller, on one channel, and choose when it arrives',
    permission: 'notifications:self',
    input: z.object({
      topic: z.string().min(1),
      channel: notificationChannel.default('email'),
      enabled: z.boolean(),
      // Absent leaves the cadence as it is. A required topic refuses `daily-digest`.
      cadence: notificationCadence.optional(),
    }),
    output: myPreferences,
  },

  'notifications/list-deliveries': {
    summary: 'What became of each notification, newest first',
    permission: 'notifications:read',
    input: z.object({
      status: deliveryRow.shape.status.optional(),
      topic: z.string().optional(),
      principal: z.string().optional(),
    }),
    inputOptional: true,
    output: deliveryRow,
    paged: {
      over: {
        entity: 'notification-delivery',
        sortable: ['created_at'],
        filterable: ['status', 'topic', 'principal'],
      },
      order: 'desc',
    },
  },

  'notifications/send-digests': {
    summary: 'Send each person whose digest is due one mail of what was held for it',
    // The digest schedule's key, held by the engine's system principal: no person needs it.
    permission: 'notifications:send-digests',
    input: z.object({}),
    inputOptional: true,
    output: z.object({
      /** People who were sent a digest, or had one recorded as skipped for want of an address. */
      digests: z.number().int(),
      /** The occasions those digests carried. */
      items: z.number().int(),
      /** People whose digest could not be composed; theirs stay held, and a window passes before the next try. */
      failed: z.number().int(),
      /** People who were due but left for a later pass, for want of room in the scope's send backlog. */
      deferred: z.number().int(),
      /** Held occasions found unreadable and set aside this pass, unsent. */
      quarantined: z.number().int(),
      /** Set-aside occasions that read again this pass and are held for the digest once more. */
      released: z.number().int(),
    }),
  },
});
