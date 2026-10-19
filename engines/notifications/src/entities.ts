import { defineEntities } from '@substrat-run/contracts';
import { z } from 'zod';

/** The cadences that hold a topic back for a digest — what a cadence row stores. */
export const digestCadence = z.enum(['daily-digest']);

/**
 * engine-notifications' entities.
 *
 * - **`notification-topic`** is a kind of notification this scope has sent: recorded by
 *   `notify` the first time a topic is used, and kept to the caller's latest description and
 *   `required`. It is what a preferences screen lists and what a mute must name — the topics
 *   are the vertical's code, so the scope learns them by being told, not by registration.
 * - **`notification-recipient`** is where a person's notifications go: one address per
 *   principal. It lives HERE rather than on an event because an address is erasable and an
 *   event is the one copy an erasure cannot rewrite (the same reason `todo.list-shared`
 *   carries a principal and no address), and module code has no other place to find one:
 *   the identity directory is not reachable through `ctx`. Erasing the principal deletes
 *   the row (K-46), and the send intents already written for them carry their `subjectId`,
 *   so a held send is cancelled by the same erasure.
 * - **`notification-mute`** is a channel a person has switched off for one topic. Its
 *   presence is the fact: a topic is on until muted, so a new topic reaches people without
 *   a preference row being written for each of them first.
 * - **`notification-delivery`** is what became of one (occasion, topic, person, channel). It
 *   names the principal and the platform request, never the address, so it is not
 *   personal data beyond the pseudonymous id the event spine already carries.
 *   `UNIQUE (dedupe_key, topic, principal, channel)` is the idempotency: the caller names the
 *   occasion (from a consumer, the event's id), and a repeat — a redelivered event — mails
 *   nobody twice. A digest is one delivery too, under the reserved topic `@digest`.
 * - **`notification-cadence`** is a topic a person has asked to receive in a digest rather
 *   than at once, per channel. Like a mute, its presence is the fact: no row is `immediate`,
 *   which is what every person had before digests existed.
 * - **`notification-digest-item`** is one occasion held for a person's next digest: the
 *   message as `notify` rendered it, keyed by the occasion's own delivery row (`id`). Only
 *   pending items are here — sending the digest deletes them, and so does switching the topic
 *   off. `failed_at` marks a person whose digest could not be composed, so the next attempt
 *   waits; `quarantined_at` marks one row that no longer reads, set aside so it is never sent
 *   and never holds up the rest. The rendered text is about the occasion and addressed to the
 *   person, so it is erasable, and an erasure of the person deletes their items with their
 *   address.
 */
export const notificationsEntities = defineEntities({
  'notification-topic': {
    table: 'notifications_topics',
    fields: z.object({
      topic: z.string(),
      description: z.string(),
      required: z.number(),
      recorded_at: z.string(),
    }),
    primaryKey: ['topic'],
  },
  'notification-recipient': {
    table: 'notifications_recipients',
    fields: z.object({
      principal: z.string(),
      email: z.string(),
      updated_at: z.string(),
    }),
    primaryKey: ['principal'],
    erasable: ['email'],
    // The address is the person's data whole; nothing about the row survives them.
    erasure: { subjects: ['principal'], mode: 'delete' },
  },
  'notification-mute': {
    table: 'notifications_mutes',
    fields: z.object({
      principal: z.string(),
      topic: z.string(),
      channel: z.string(),
      created_at: z.string(),
    }),
    primaryKey: ['principal', 'topic', 'channel'],
  },
  'notification-delivery': {
    table: 'notifications_deliveries',
    fields: z.object({
      id: z.string(),
      topic: z.string(),
      dedupe_key: z.string(),
      principal: z.string(),
      channel: z.string(),
      status: z.enum(['requested', 'skipped', 'sent', 'refused', 'dead_lettered']),
      reason: z.string().nullable(),
      request_id: z.string().nullable(),
      about_type: z.string().nullable(),
      about_id: z.string().nullable(),
      created_at: z.string(),
      settled_at: z.string().nullable(),
    }),
    key: ['dedupe_key', 'topic', 'principal', 'channel'],
  },
  'notification-cadence': {
    table: 'notifications_cadences',
    fields: z.object({
      principal: z.string(),
      topic: z.string(),
      channel: z.string(),
      cadence: digestCadence,
      updated_at: z.string(),
    }),
    primaryKey: ['principal', 'topic', 'channel'],
  },
  'notification-digest-item': {
    table: 'notifications_digest_items',
    fields: z.object({
      id: z.string(),
      principal: z.string(),
      channel: z.string(),
      topic: z.string(),
      dedupe_key: z.string(),
      subject: z.string(),
      text: z.string(),
      html: z.string(),
      about_type: z.string().nullable(),
      about_id: z.string().nullable(),
      queued_at: z.string(),
      /** When the last attempt to send this person's digest failed; the next waits a window. */
      failed_at: z.string().nullable(),
      /** When this row was found unreadable and set aside: never sent, kept for repair. */
      quarantined_at: z.string().nullable(),
    }),
    erasable: ['subject', 'text', 'html'],
    // Mail addressed to the person: nothing about a pending item survives them.
    erasure: { subjects: ['principal'], mode: 'delete' },
  },
});

/** One delivery, as stored and as published — it holds nothing the reader may not see. */
export const deliveryRow = notificationsEntities['notification-delivery'].fields;

/** One pending digest item, as stored — read back only to compose the digest. */
export const digestItemRow = notificationsEntities['notification-digest-item'].fields;
