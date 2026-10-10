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
 * sent, by preference (`reason: 'muted'`) or for want of an address (`'no_address'`).
 * `dedupeKey` is the occasion as the caller named it — from a consumer, the triggering event's id.
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

/** A person switched one topic on or off for one channel. */
export interface NotificationsPreferenceSetPayload {
  principal: string;
  topic: string;
  channel: string;
  enabled: boolean;
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

export type NotificationsEvents = {
  events: {
    'notifications.delivery-recorded': NotificationsDeliveryRecordedPayload;
    'notifications.delivery-settled': NotificationsDeliverySettledPayload;
    'notifications.preference-set': NotificationsPreferenceSetPayload;
    'notifications.recipient-updated': NotificationsRecipientUpdatedPayload;
    'notifications.topic-recorded': NotificationsTopicRecordedPayload;
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
