/**
 * engine-notifications' event contract — what a VERTICAL imports so that reading this
 * engine's outcomes by event is checked rather than guessed.
 *
 * Types plus one stamp, the same shape as every other engine's `events.ts`: the runtime
 * contract is the fat payload and the consumer's own Zod parse; `emitNotificationsEvent`
 * forwards to `ctx.emit`, adding only the `schemaVersion` from
 * `notificationsEventVersions` (#1597).
 *
 * **No address appears.** Each payload but `topic-recorded`'s names a principal (pseudonymous, and the event's
 * `subjectId`) and never where their mail goes: the address is erasable and lives only on
 * the engine's recipient row and on the platform's send intent, both of which an erasure
 * reaches. A field added here must keep that true.
 *
 * Additive, like every other engine surface: a new event type may appear, an existing
 * payload field does not change shape without a `schemaVersion` bump.
 */
import type { DomainEventInput, EntityRef } from '@substrat-run/contracts';
import type { OperationContext } from '@substrat-run/kernel';

/**
 * What `notify` did for one (occasion, topic, person, channel).
 *
 * `requested`: a send intent was written, and `request` is its id. `skipped`: nothing was
 * sent on its own, by preference (`reason: 'muted'`), for want of an address (`'no_address'`),
 * or because the person takes this topic in a digest (`'digest'`): the occasion is held for
 * their next one, and that digest's `notifications.digest-sent` names it by this `deliveryId`.
 * `dedupeKey` is the occasion as the caller named it — from a consumer, the triggering event's id.
 *
 * A digest is a delivery as well, under the reserved topic `@digest` (no vertical topic can be
 * spelled that way), with `about: null`.
 */
export interface NotificationsDeliveryRecordedPayload {
  deliveryId: string;
  topic: string;
  principal: string;
  channel: string;
  status: 'requested' | 'skipped';
  reason: string | null;
  request: string | null;
  dedupeKey: string;
  about: EntityRef | null;
}

/**
 * What the platform reported back for a `requested` delivery: the provider accepted it
 * (`sent`), refused it for good (`refused`), or every attempt failed (`dead_lettered`).
 * `code` is the platform's taxonomy code for a refusal or the last failure; null on `sent`.
 */
export interface NotificationsDeliverySettledPayload {
  deliveryId: string;
  topic: string;
  principal: string;
  channel: string;
  status: 'sent' | 'refused' | 'dead_lettered';
  code: string | null;
  request: string;
}

/**
 * A person switched one topic on or off for one channel, and perhaps chose when it arrives.
 * A switch-off also withdraws that topic's items still held for their digest.
 */
export interface NotificationsPreferenceSetPayload {
  principal: string;
  topic: string;
  channel: string;
  enabled: boolean;
  /**
   * When the topic reaches them after the call — always `immediate` for a required topic.
   * Absent on events written before digests existed.
   */
  cadence?: 'immediate' | 'daily-digest';
}

/** A person set or cleared where their notifications go — whether, never what. */
export interface NotificationsRecipientUpdatedPayload {
  principal: string;
  hasAddress: boolean;
}

/** A topic was first used, or its description or `required` changed. Names nobody. */
export interface NotificationsTopicRecordedPayload {
  topic: string;
  description: string;
  required: boolean;
}

/** One occasion a digest carried, named by its own (`skipped`, `digest`) delivery. */
export interface NotificationsDigestItem {
  deliveryId: string;
  topic: string;
  dedupeKey: string;
  about: EntityRef | null;
  queuedAt: string;
}

/**
 * One person's digest was composed from everything held for them: the occasions it carried,
 * oldest first, and the digest's own delivery (topic `@digest`). `status` is that delivery's:
 * `requested` with the send intent's `request`, or `skipped` with `reason: 'no_address'` when
 * the person had cleared their address since. Either way the items are no longer held, and the
 * digest's delivery settles like any other.
 */
export interface NotificationsDigestSentPayload {
  deliveryId: string;
  principal: string;
  channel: string;
  cadence: 'daily-digest';
  status: 'requested' | 'skipped';
  reason: string | null;
  request: string | null;
  items: NotificationsDigestItem[];
}

export type NotificationsEvents = {
  events: {
    'notifications.delivery-recorded': NotificationsDeliveryRecordedPayload;
    'notifications.delivery-settled': NotificationsDeliverySettledPayload;
    'notifications.preference-set': NotificationsPreferenceSetPayload;
    'notifications.recipient-updated': NotificationsRecipientUpdatedPayload;
    'notifications.topic-recorded': NotificationsTopicRecordedPayload;
    'notifications.digest-sent': NotificationsDigestSentPayload;
  };
};

/** Every event type this engine emits. */
export type NotificationsEventType = keyof NotificationsEvents['events'];

/** The one home for each event's `schemaVersion` (#1597); `emits` is read off it. */
export const notificationsEventVersions = {
  'notifications.delivery-recorded': 1,
  'notifications.delivery-settled': 1,
  'notifications.preference-set': 1,
  'notifications.recipient-updated': 1,
  'notifications.topic-recorded': 1,
  'notifications.digest-sent': 1,
} as const satisfies Record<NotificationsEventType, number>;

/** The manifest's `events.emits`, read off {@link notificationsEventVersions}. */
export const notificationsEmitDeclarations: { type: string; schemaVersion: number }[] = Object.entries(
  notificationsEventVersions,
).map(([type, schemaVersion]) => ({ type, schemaVersion }));

/** `ctx.emit` with the event type and its payload welded together, and the version stamped. */
export function emitNotificationsEvent<K extends NotificationsEventType>(
  ctx: OperationContext,
  event: Omit<DomainEventInput, 'type' | 'payload' | 'schemaVersion'> & {
    type: K;
    payload: NotificationsEvents['events'][K];
  },
): void {
  ctx.emit({ ...event, schemaVersion: notificationsEventVersions[event.type] });
}
