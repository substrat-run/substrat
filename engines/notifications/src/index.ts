/**
 * engine-notifications — composed **by call**, not by event.
 *
 * The in-scope functions are the surface: `notify`, which turns one occasion into mail to the
 * people it concerns, and the preference functions behind the operations below. A vertical
 * decides WHEN to notify — usually in its own consumer of a domain event, e.g. Handlebar's
 * consumer of `workorder.assigned` — and calls `notify(ctx, …)` there, inside its own
 * transaction, with the template it owns. The engine owns everything after that call: the
 * mute and required check, the address, the escaped render, the send intent, and a delivery
 * row that follows the send to its outcome.
 *
 * Placement (K-47): notifications are domain logic over the kernel's primitives, so they are
 * an engine. The kernel's whole part is the transactional send intent (`requestEmail`, #2102)
 * and the outcome events its settle writes back; the transport behind that intent is
 * `adapter-email`. Nothing here reaches a provider.
 *
 * The registration is one frozen constant like every other engine's. Its only consumers are the
 * three email outcome events, which settle the deliveries it wrote; what triggers a notification
 * is the vertical's code, so nothing about that appears here.
 *
 * Digests are the person's choice, per topic: a topic they take as `daily-digest` is held
 * rather than mailed. The engine's own schedule (`notifications/send-digests`, run by its system
 * principal every `DIGEST_TICK_MINUTES`) sends each person whose oldest held message is a day old
 * one mail of up to `DIGEST_MAX_ITEMS` of them, oldest first, through the same send intent and
 * delivery row as any notification, one person at a time and never more at once than the
 * scope's send backlog has room for. A mute still wins, and a required topic always goes out at
 * once.
 *
 * Deferred, and stated so an absence reads as intent: channels other than email (SMS, push,
 * in-app — each a transport and a `notificationChannel` value), tenant-edited or per-locale
 * templates (a table keyed by topic overriding the template the caller passes, which is also
 * where a digest's own wording would come from), quiet hours and a digest's time of day, other
 * digest cadences (today any cadence row holds a topic for the one daily schedule: a second
 * cadence needs a `digestCadence` value, the cadence recorded on each held item, and a schedule
 * that sends only its own), and a person's own delivery history.
 */
import { z } from 'zod';
import {
  EMAIL_DEAD_LETTERED,
  EMAIL_REFUSED,
  EMAIL_SENT,
  dataSubjectId,
  listsDeclaredBy,
  mapPage,
  moduleManifest,
  permissionKey,
  subjectErasureOf,
  substratError,
  inList,
  isSubstratError,
  MAX_PENDING_PLATFORM_REQUESTS,
  type EmailOutcomeType,
  type EntityRef,
  type Page,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  operationsFor,
  requestEmail,
  ulid,
  type ConsumerHandler,
  type ModuleRegistration,
  type OperationContext,
  type PageParams,
} from '@substrat-run/kernel';

/**
 * The conflict reasons this engine raises, narrowing the platform's `conflict` code (#113).
 * Additive only: new reasons may appear, existing ones do not change spelling.
 */
export const NOTIFICATIONS_CONFLICT_REASONS = ['topic_required'] as const;
export type NotificationsConflictReason = (typeof NOTIFICATIONS_CONFLICT_REASONS)[number];

const conflict = (reason: NotificationsConflictReason, message: string) =>
  substratError('conflict', message, { reason });

export { notificationsEntities, deliveryRow } from './entities.js';
import { deliveryRow, digestItemRow, notificationsEntities } from './entities.js';
export {
  notificationsOperations,
  NOTIFICATIONS_PERMISSIONS,
  notificationCadence,
  notificationChannel,
  myPreferences,
  topicPreference,
  type NotificationCadence,
  type NotificationChannel,
} from './operations.js';
import {
  myPreferences,
  notificationsOperations,
  type NotificationCadence,
  type NotificationChannel,
} from './operations.js';
export {
  type NotificationsEvents,
  type NotificationsEventType,
  type NotificationsDeliveryRecordedPayload,
  type NotificationsDeliverySettledPayload,
  type NotificationsDigestFailedPayload,
  type NotificationsDigestItem,
  type NotificationsDigestQuarantinedPayload,
  type NotificationsDigestReleasedPayload,
  type NotificationsDigestSentPayload,
  type NotificationsPreferenceSetPayload,
  type NotificationsRecipientUpdatedPayload,
  type NotificationsTopicRecordedPayload,
} from './events.js';
import { emitNotificationsEvent, notificationsEmitDeclarations } from './events.js';
export { type NotificationTemplate } from './render.js';
import { digestOf, render, type RenderedMessage } from './render.js';
import { columnsOf, returns } from './seam.js';

export const NOTIFICATIONS_PERM = {
  self: permissionKey.parse('notifications:self'),
  read: permissionKey.parse('notifications:read'),
  sendDigests: permissionKey.parse('notifications:send-digests'),
};

/**
 * The topic of a digest's own delivery. A vertical's topic is a lowercase slug, so none can be
 * spelled this way: filtering the delivery list on it lists digests and nothing else.
 */
export const DIGEST_TOPIC = '@digest';

/** The outcome events the kernel's settle writes for a send intent (#2102), and what each settles to. */
const EMAIL_OUTCOMES = {
  [EMAIL_SENT]: 'sent',
  [EMAIL_REFUSED]: 'refused',
  [EMAIL_DEAD_LETTERED]: 'dead_lettered',
} as const satisfies Record<EmailOutcomeType, string>;

const CHANNEL: NotificationChannel = 'email';

/**
 * How often the digest schedule looks for people whose digest is due. Each pass is one indexed
 * query when nobody is; a backlog bigger than one pass's room drains over the next passes.
 */
export const DIGEST_TICK_MINUTES = 15;

/** A `daily-digest` person is due once their oldest held message is this old. */
const DIGEST_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The pending-send slots a digest pass leaves free, of the scope's
 * `MAX_PENDING_PLATFORM_REQUESTS`: digests can wait for the drain, and mail that must not —
 * a required topic above all — is never refused because digests filled the backlog.
 */
export const DIGEST_RESERVE = 8;

/**
 * The most held occasions one digest carries, oldest first. The rest stay held and are due by
 * the same rule as any — once the oldest of them is a window old — so a person with more held
 * than this gets several digests rather than one unbounded mail, and a pass reads a bounded
 * number of rows for each person.
 */
export const DIGEST_MAX_ITEMS = 50;

/** The most set-aside rows a pass reads again. Each is a parse and an update, never a send. */
const RELEASE_BATCH = 200;

// ============================================================================
// Manifest and migrations
// ============================================================================

export const notificationsManifest = moduleManifest.parse({
  id: '@substrat-run/engine-notifications',
  // Versions the manifest SHAPE, not the package (#976), and read by `src/model.ts`.
  version: '0.0.2',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'notifications:self', description: 'Set where your own notifications go and which topics reach you' },
    { key: 'notifications:read', description: 'Read what became of every notification in the scope' },
    {
      key: 'notifications:send-digests',
      description: "Send the digests that are due now — the digest schedule's key, held by the engine's system principal and never by a person",
      // A person holding it could send the scope's due digests whenever they liked.
      holder: 'system',
    },
  ],
  events: {
    emits: notificationsEmitDeclarations,
    // The send outcomes, which settle this engine's deliveries — never a vertical's events.
    consumes: Object.keys(EMAIL_OUTCOMES).map((type) => ({ type, schemaVersion: 1 })),
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [],
  lists: listsDeclaredBy(notificationsOperations, notificationsEntities),
  // K-46: derived, so the recipient row's `delete` erasure is in the manifest a host reads.
  erasure: subjectErasureOf(notificationsEntities),
  entitlementKey: 'notifications',
  // Digests (#118), under the engine's system principal. The schedule ticks often and each
  // person is due on their own clock (`sendDigests`), so a backlog drains across passes instead
  // of waiting a day, and nobody's digest is tied to when the scope's schedule happened to run.
  schedules: [
    {
      operation: 'notifications/send-digests',
      cadence: { everyMinutes: DIGEST_TICK_MINUTES },
      permissions: ['notifications:send-digests'],
    },
  ],
});

export const notificationsMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE notifications_topics (
        topic       TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        required    INTEGER NOT NULL CHECK (required IN (0, 1)),
        recorded_at TEXT NOT NULL
      );
      CREATE TABLE notifications_recipients (
        principal  TEXT PRIMARY KEY,
        email      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE notifications_mutes (
        principal  TEXT NOT NULL,
        topic      TEXT NOT NULL,
        channel    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (principal, topic, channel)
      );
      CREATE TABLE notifications_deliveries (
        id          TEXT PRIMARY KEY,
        topic       TEXT NOT NULL,
        dedupe_key  TEXT NOT NULL,
        principal   TEXT NOT NULL,
        channel     TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN
                      ('requested','skipped','sent','refused','dead_lettered')),
        reason      TEXT,
        request_id  TEXT UNIQUE,
        about_type  TEXT,
        about_id    TEXT,
        created_at  TEXT NOT NULL,
        settled_at  TEXT,
        UNIQUE (dedupe_key, topic, principal, channel)
      );
    `,
  },
  {
    // Digests (#118). Two new tables and nothing else: no existing row changes meaning, since a
    // person with no cadence row takes every topic at once, as everyone did before.
    version: '0002-digests',
    sql: `
      CREATE TABLE notifications_cadences (
        principal  TEXT NOT NULL,
        topic      TEXT NOT NULL,
        channel    TEXT NOT NULL,
        cadence    TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (principal, topic, channel)
      );
      CREATE TABLE notifications_digest_items (
        id         TEXT PRIMARY KEY,
        principal  TEXT NOT NULL,
        channel    TEXT NOT NULL,
        topic      TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        subject    TEXT NOT NULL,
        text       TEXT NOT NULL,
        html       TEXT NOT NULL,
        about_type TEXT,
        about_id   TEXT,
        queued_at  TEXT NOT NULL,
        failed_at  TEXT,
        quarantined_at TEXT
      );
      CREATE INDEX notifications_digest_items_by_person
        ON notifications_digest_items (principal, channel, queued_at);
    `,
  },
];

// ============================================================================
// notify — the in-scope function a vertical calls
// ============================================================================

const TOPIC_KEY = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;

export const notifyInput = z.object({
  /** A lowercase slug — the key a person's mute names. */
  topic: z.string().regex(TOPIC_KEY, 'a topic is a lowercase slug'),
  /** What a person reads beside the topic's switch on their preferences screen. */
  description: z.string().min(1),
  /**
   * What makes this occasion one occasion. Called from a consumer, pass the event's `id`:
   * delivery is at least once, and a redelivered event then mails nobody twice. Called from an
   * operation, pass a key unique to what is being announced (the entity's id, plus a version if
   * it can recur). A repeat with the same key, topic and person writes nothing.
   */
  dedupeKey: z.string().min(1),
  /** Who hears about it: principal ids (ULIDs), never addresses. Duplicates are sent once. */
  recipients: z.array(dataSubjectId),
  /** The template's variables. Every placeholder must have one, or the call throws. */
  vars: z.record(z.string(), z.string()).default({}),
  /** What the mail is about; its timeline carries the outcome. */
  about: z.object({ entityType: z.string().min(1), entityId: z.string().min(1) }).nullable().default(null),
  template: z.object({ subject: z.string().min(1), text: z.string().min(1), html: z.string().min(1).optional() }),
  /**
   * A required topic cannot be muted, nor held for a digest — reserve it for mail a person must
   * not be able to miss, or receive late. With `description`, part of the topic's ONE
   * declaration: every call for a topic passes the same pair (see `recordTopic`).
   */
  required: z.boolean().default(false),
});
export type NotifyInput = z.input<typeof notifyInput>;

/** What `notify` did for one recipient. */
export interface NotifyOutcome {
  principal: string;
  status: 'requested' | 'skipped';
  /**
   * On a skip: `muted`, `no_address`, `duplicate` (this key already reached them), or `digest`
   * (held for their next digest rather than mailed on its own). Null when requested.
   */
  reason: string | null;
  /** The send intent's id, when one was written. */
  request: string | null;
  /** The delivery row, or null on a `duplicate`, which writes none. */
  deliveryId: string | null;
}

/**
 * Notify `recipients` about one occasion, inside the caller's transaction.
 *
 * For each person: a delivery this `dedupeKey` already made for them is left alone; a muted
 * topic (unless `required`) or a missing address records a `skipped` delivery; a topic they
 * take as a digest (unless `required`) records a `skipped` delivery with reason `digest` and
 * holds the rendered message for `sendDigests`; otherwise a send intent is written with
 * `requestEmail`, naming the person as its `subjectId`, and a `requested` delivery records it.
 * The platform's outcome event settles that delivery later (the engine's own consumers).
 *
 * **It throws `validation_failed`, writing nothing, when the template cannot be filled** — a
 * placeholder with no variable, or a message every word of which was a blank variable — or a
 * recipient is not a principal id. That is a defect in the caller, and the throw rolls back the
 * caller's whole transaction: from a consumer, the event dead-letters in the kernel's delivery
 * journal with the topic and the reason in its error; from an operation, the operation fails.
 * A blank mail is never the fallback.
 *
 * No permission check: like every by-call engine function, the caller checks first. A consumer
 * calling it runs under the kernel's consumer authority.
 */
export function notify(ctx: OperationContext, rawInput: NotifyInput): NotifyOutcome[] {
  const parsed = notifyInput.safeParse(rawInput);
  if (!parsed.success) {
    throw substratError('validation_failed', `notify: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const input = parsed.data;
  // One message for every recipient: the variables describe the occasion, not the person.
  const rendered = render(input.template, input.vars);
  if (!rendered.ok) {
    throw substratError('validation_failed', `notify: topic '${input.topic}' cannot be rendered: ${rendered.reason}`);
  }
  recordTopic(ctx, input.topic, input.description, input.required);

  return [...new Set(input.recipients)].map((principal): NotifyOutcome => {
    const already = ctx.sql.query(
      'SELECT 1 FROM notifications_deliveries WHERE dedupe_key = ? AND topic = ? AND principal = ? AND channel = ?',
      [input.dedupeKey, input.topic, principal, CHANNEL],
    );
    if (already.length > 0) return { principal, status: 'skipped', reason: 'duplicate', request: null, deliveryId: null };

    const record = (status: NotifyOutcome['status'], reason: string | null, request: string | null) =>
      recordDelivery(ctx, { ...input, principal, status, reason, request });
    if (!input.required && isMuted(ctx, principal, input.topic)) return record('skipped', 'muted', null);
    const to = addressOf(ctx, principal);
    if (to === null) return record('skipped', 'no_address', null);
    if (!input.required && storedCadenceOf(ctx, principal, input.topic) !== null) {
      const held = record('skipped', 'digest', null);
      holdForDigest(ctx, held.deliveryId, { ...input, principal }, rendered.message);
      return held;
    }
    const request = requestEmail(ctx, {
      to,
      ...rendered.message,
      ...(input.about ? { about: input.about } : {}),
      // The intent holds the address: naming the subject is how an erasure cancels it.
      subjectId: principal,
    });
    return record('requested', null, request);
  });
}

/** Every event here is about one principal: pseudonymous, and keyed on them for erasure. */
const aboutPrincipal = (principal: string) =>
  ({ piiClass: 'pseudonymous', subjectId: dataSubjectId.parse(principal) }) as const;

const addressOf = (ctx: OperationContext, principal: string): string | null =>
  ctx.sql.query<{ email: string }>('SELECT email FROM notifications_recipients WHERE principal = ?', [principal])[0]
    ?.email ?? null;

const isMuted = (ctx: OperationContext, principal: string, topic: string): boolean =>
  ctx.sql.query('SELECT 1 FROM notifications_mutes WHERE principal = ? AND topic = ? AND channel = ?', [
    principal,
    topic,
    CHANNEL,
  ]).length > 0;

/** The digest cadence a person chose for a topic, or null: no row is `immediate`. */
const storedCadenceOf = (ctx: OperationContext, principal: string, topic: string): string | null =>
  ctx.sql.query<{ cadence: string }>(
    'SELECT cadence FROM notifications_cadences WHERE principal = ? AND topic = ? AND channel = ?',
    [principal, topic, CHANNEL],
  )[0]?.cadence ?? null;

/**
 * Hold one rendered occasion for the person's next digest, under its own delivery's id.
 *
 * Holding is only half of a digest; sending is the other, and where it does not happen,
 * messages wait and nothing fails. The schedule may not run: a scope provisioned before this
 * engine declared it holds no grant for it until its provision runs again, and a self-hosted
 * server must run schedules at all. Or it runs and cannot send: the scope's sends are not being
 * drained, so every pass finds no room, or this person's digest keeps failing. So a hold that
 * finds this person's oldest message (set-aside rows aside) twice a window old says so in a
 * warning line, whatever the reason.
 */
function holdForDigest(
  ctx: OperationContext,
  deliveryId: string,
  occasion: { principal: string; topic: string; dedupeKey: string; about: EntityRef | null },
  message: RenderedMessage,
): void {
  const [waiting] = ctx.sql.query<{ oldest: string | null }>(
    `SELECT MIN(queued_at) AS oldest FROM notifications_digest_items
      WHERE principal = ? AND channel = ? AND quarantined_at IS NULL`,
    [occasion.principal, CHANNEL],
  );
  const stale = new Date(Date.parse(ctx.now()) - 2 * DIGEST_WINDOW_MS).toISOString();
  if (waiting?.oldest && waiting.oldest < stale) {
    ctx.log.warn(
      'digest messages for {principal} have waited since {oldest}: is the digest schedule running, and are sends being drained?',
      { principal: occasion.principal, oldest: waiting.oldest },
    );
  }
  ctx.sql.exec(
    `INSERT INTO notifications_digest_items
       (id, principal, channel, topic, dedupe_key, subject, text, html, about_type, about_id, queued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      deliveryId,
      occasion.principal,
      CHANNEL,
      occasion.topic,
      occasion.dedupeKey,
      message.subject,
      message.text,
      message.html,
      occasion.about?.entityType ?? null,
      occasion.about?.entityId ?? null,
      ctx.now(),
    ],
  );
}

/**
 * A topic becomes known to the preferences screen the first time it is used, and follows the
 * caller's latest description and `required` from then on, so a deploy that changes them updates
 * the row an older deploy wrote. Written only when it changes, so an ordinary notification adds
 * no topic event.
 *
 * That is only coherent under **one topic, one declaration**: every call site naming a topic
 * passes the same description and `required`. Two that disagree make the row flip with
 * whichever ran last, and a mute be refused or allowed accordingly. Keep a topic's declaration
 * in one constant the call sites spread, and change it there.
 */
function recordTopic(ctx: OperationContext, topic: string, description: string, required: boolean): void {
  const changed = ctx.sql.query(
    `INSERT INTO notifications_topics (topic, description, required, recorded_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (topic) DO UPDATE SET description = excluded.description, required = excluded.required,
       recorded_at = excluded.recorded_at
       WHERE description IS NOT excluded.description OR required IS NOT excluded.required
     RETURNING topic`,
    [topic, description, required ? 1 : 0, ctx.now()],
  );
  if (changed.length === 0) return;
  emitNotificationsEvent(ctx, {
    type: 'notifications.topic-recorded',
    entity: { entityType: 'notification-topic', entityId: topic },
    piiClass: 'none',
    payload: { topic, description, required },
  });
}

function recordDelivery(
  ctx: OperationContext,
  d: {
    topic: string;
    dedupeKey: string;
    principal: string;
    status: NotifyOutcome['status'];
    reason: string | null;
    request: string | null;
    about: EntityRef | null;
  },
): NotifyOutcome & { deliveryId: string } {
  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO notifications_deliveries
       (id, topic, dedupe_key, principal, channel, status, reason, request_id, about_type, about_id,
        created_at, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      d.topic,
      d.dedupeKey,
      d.principal,
      CHANNEL,
      d.status,
      d.reason,
      d.request,
      d.about?.entityType ?? null,
      d.about?.entityId ?? null,
      ctx.now(),
    ],
  );
  emitNotificationsEvent(ctx, {
    type: 'notifications.delivery-recorded',
    entity: { entityType: 'notification-delivery', entityId: id },
    ...aboutPrincipal(d.principal),
    payload: {
      deliveryId: id,
      topic: d.topic,
      principal: d.principal,
      channel: CHANNEL,
      status: d.status,
      reason: d.reason,
      request: d.request,
      dedupeKey: d.dedupeKey,
      about: d.about,
    },
  });
  return { principal: d.principal, status: d.status, reason: d.reason, request: d.request, deliveryId: id };
}

// ============================================================================
// Preferences — a person's own
// ============================================================================

/** The caller's address and every known topic's switch and cadence. */
export function myPreferencesOf(ctx: OperationContext): z.infer<typeof myPreferences> {
  const muted = new Set(
    ctx.sql
      .query<{ topic: string }>('SELECT topic FROM notifications_mutes WHERE principal = ? AND channel = ?', [
        ctx.principal,
        CHANNEL,
      ])
      .map((r) => r.topic),
  );
  const cadences = new Map(
    ctx.sql
      .query<{ topic: string; cadence: string }>(
        'SELECT topic, cadence FROM notifications_cadences WHERE principal = ? AND channel = ?',
        [ctx.principal, CHANNEL],
      )
      .map((r) => [r.topic, r.cadence]),
  );
  const topics = ctx.sql.query<{ topic: string; description: string; required: number }>(
    'SELECT topic, description, required FROM notifications_topics ORDER BY topic',
  );
  return returns(myPreferences, 'notifications/my-preferences', {
    email: addressOf(ctx, ctx.principal),
    topics: topics.map((t) => ({
      topic: t.topic,
      description: t.description,
      channel: CHANNEL,
      required: t.required === 1,
      enabled: t.required === 1 || !muted.has(t.topic),
      // A required topic goes out at once whatever was chosen before it became required.
      cadence: t.required === 1 ? 'immediate' : (cadences.get(t.topic) ?? 'immediate'),
    })),
  });
}

/** Set or clear where the caller's notifications go. */
export function setMyAddress(ctx: OperationContext, input: { email: string | null }): z.infer<typeof myPreferences> {
  if (input.email === null) {
    ctx.sql.exec('DELETE FROM notifications_recipients WHERE principal = ?', [ctx.principal]);
  } else {
    ctx.sql.exec(
      `INSERT INTO notifications_recipients (principal, email, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (principal) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at`,
      [ctx.principal, input.email, ctx.now()],
    );
  }
  emitNotificationsEvent(ctx, {
    type: 'notifications.recipient-updated',
    entity: { entityType: 'notification-recipient', entityId: ctx.principal },
    ...aboutPrincipal(ctx.principal),
    payload: { principal: ctx.principal, hasAddress: input.email !== null },
  });
  return myPreferencesOf(ctx);
}

/**
 * Switch one topic on or off for the caller, and with `cadence`, choose whether it arrives at
 * once or in their daily digest (absent leaves that as it is). The topic must be one this scope
 * has used (`not_found` otherwise). A required topic refuses to be switched off, and refuses a
 * digest: mail a person must not miss does not wait a day either.
 *
 * Switching a topic off withdraws its items still held for the caller's digest — a mute wins
 * over the queue. Each withdrawn occasion's delivery is settled `skipped`/`muted`, as if the mute
 * had come first, and the event names them. Switching a digest back to `immediate` leaves what is
 * already held to go out with the next digest.
 */
export function setMyPreference(
  ctx: OperationContext,
  input: { topic: string; channel: NotificationChannel; enabled: boolean; cadence?: NotificationCadence | undefined },
): z.infer<typeof myPreferences> {
  const topic = ctx.sql.query<{ required: number }>('SELECT required FROM notifications_topics WHERE topic = ?', [
    input.topic,
  ])[0];
  if (!topic) throw substratError('not_found', `no notification topic '${input.topic}'`);
  if (topic.required === 1 && !input.enabled) {
    throw conflict('topic_required', `'${input.topic}' is a required notification and cannot be switched off`);
  }
  if (topic.required === 1 && input.cadence !== undefined && input.cadence !== 'immediate') {
    throw conflict('topic_required', `'${input.topic}' is a required notification and always goes out at once`);
  }
  const mine = [ctx.principal, input.topic, input.channel];
  let withdrawn: string[] = [];
  if (input.enabled) {
    ctx.sql.exec('DELETE FROM notifications_mutes WHERE principal = ? AND topic = ? AND channel = ?', mine);
  } else {
    ctx.sql.exec(
      `INSERT INTO notifications_mutes (principal, topic, channel, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [...mine, ctx.now()],
    );
    withdrawn = ctx.sql
      .query<{ id: string }>(
        `UPDATE notifications_deliveries SET reason = 'muted', settled_at = ?
          WHERE id IN (SELECT id FROM notifications_digest_items
                        WHERE principal = ? AND topic = ? AND channel = ? AND quarantined_at IS NULL)
          RETURNING id`,
        [ctx.now(), ...mine],
      )
      .map((r) => r.id)
      .sort();
    ctx.sql.exec(
      'DELETE FROM notifications_digest_items WHERE principal = ? AND topic = ? AND channel = ? AND quarantined_at IS NULL',
      mine,
    );
  }
  if (input.cadence === 'immediate') {
    ctx.sql.exec('DELETE FROM notifications_cadences WHERE principal = ? AND topic = ? AND channel = ?', mine);
  } else if (input.cadence !== undefined) {
    ctx.sql.exec(
      `INSERT INTO notifications_cadences (principal, topic, channel, cadence, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (principal, topic, channel) DO UPDATE SET cadence = excluded.cadence, updated_at = excluded.updated_at`,
      [...mine, input.cadence, ctx.now()],
    );
  }
  // The cadence the event announces is the one the caller now reads back: one rule, one place.
  const preferences = myPreferencesOf(ctx);
  emitNotificationsEvent(ctx, {
    type: 'notifications.preference-set',
    entity: { entityType: 'notification-recipient', entityId: ctx.principal },
    ...aboutPrincipal(ctx.principal),
    payload: {
      principal: ctx.principal,
      topic: input.topic,
      channel: input.channel,
      enabled: input.enabled,
      cadence: preferences.topics.find((t) => t.topic === input.topic)!.cadence,
      ...(withdrawn.length > 0 ? { withdrawn } : {}),
    },
  });
  return preferences;
}

/** What became of each notification, newest first. */
export function listDeliveries(ctx: OperationContext, page: PageParams): Page<z.infer<typeof deliveryRow>> {
  return mapPage(ctx.page('notification-delivery', page), (row) =>
    returns(deliveryRow, 'notifications/list-deliveries', row),
  );
}

// ============================================================================
// Digests — what was held, sent as one mail per person
// ============================================================================

const DIGEST_ITEM_COLUMNS = columnsOf(digestItemRow);

/** What one pass of `sendDigests` did. */
export interface DigestPass {
  /** People whose digest went out (or was recorded skipped for want of an address). */
  digests: number;
  /** The occasions those digests carried. */
  items: number;
  /** People whose digest could not be composed: theirs stay held, retried a window later. */
  failed: number;
  /** People who were due but left for a later pass, because the scope had no room for more sends. */
  deferred: number;
  /** Held occasions found unreadable and set aside this pass, unsent. */
  quarantined: number;
  /** Set-aside occasions that read again this pass and are held for the digest once more. */
  released: number;
}

/** One held row as stored, with the `rowid` that still names it when nothing else reads. */
type HeldRow = Record<string, unknown> & { row_id: number };

/**
 * Send each person whose digest is due one mail of what is held for them.
 *
 * **Who is due.** A person is due once their oldest held message is a whole window old (a day,
 * for `daily-digest`). So nothing waits much longer than a day, and while no more than
 * `DIGEST_MAX_ITEMS` are held, a person gets one digest a day: everything held after it is
 * younger. Oldest first, so a backlog drains in the order it built up. A person whose last
 * attempt failed waits a window before the next.
 *
 * **How many people.** Each mail is a platform send intent, and a scope may hold only
 * `MAX_PENDING_PLATFORM_REQUESTS` of those waiting for the drain — this transaction's own
 * included. A pass therefore sends to at most the room that is left, less `DIGEST_RESERVE`
 * slots kept for mail that must not wait, and leaves everyone else held for the next pass. It
 * never asks for more room than there is, so it never meets the cap's refusal.
 *
 * **How much each.** One digest carries at most `DIGEST_MAX_ITEMS` occasions, oldest first. The
 * rest stay held, and are due by the same rule: as soon as the oldest of them is a window old —
 * on the very next pass if it already is. That is the one case where a person gets more than one
 * digest a day.
 *
 * **What does not read.** A held row that no longer matches the published shape is set aside
 * (`quarantine`) rather than mailed or allowed to block the rest: the person's readable messages
 * go out, and the set-aside row counts toward nothing — not who is due, not a switch-off's
 * withdrawal, not the stale-hold warning. Its cause may pass (a version that stored a shape this
 * one rejects is rolled forward again), so each set-aside row is read again once a window
 * (`releaseReadable`, at the start of a pass) and held once more when it reads.
 *
 * **One person at a time.** Each person's digest is its own `ctx.atomic`: one mail written with
 * `requestEmail`, one delivery under `DIGEST_TOPIC`, the carried occasions settled and no longer
 * held. If any of that throws, none of it happened for that person — their messages stay held,
 * `notifications.digest-failed` and an error line say so — and everyone else's digest still goes
 * out. A person who cleared their address since gets a `skipped` (`no_address`) digest, as an
 * immediate notification would have.
 *
 * The engine's schedule runs it through `notifications/send-digests` every
 * `DIGEST_TICK_MINUTES`; a vertical may also call it, after its own permission check, like every
 * by-call function here. Either way it is one pass, and it sends only the people who are due.
 */
export async function sendDigests(ctx: OperationContext): Promise<DigestPass> {
  const now = ctx.now();
  const cutoff = new Date(Date.parse(now) - DIGEST_WINDOW_MS).toISOString();
  // First, so a row released now is sent in this very pass if its person is due.
  const released = releaseReadable(ctx, now, cutoff);
  const due = ctx.sql.query<{ principal: string }>(
    `SELECT principal FROM notifications_digest_items WHERE channel = ? AND quarantined_at IS NULL
      GROUP BY principal
     HAVING MIN(queued_at) <= ? AND COALESCE(MAX(failed_at), '') <= ?
      ORDER BY MIN(queued_at), principal`,
    [CHANNEL, cutoff, cutoff],
  );
  const pending = ctx.platformRequests({ status: 'pending', limit: MAX_PENDING_PLATFORM_REQUESTS }).length;
  let room = MAX_PENDING_PLATFORM_REQUESTS - DIGEST_RESERVE - pending;
  const pass: DigestPass = { digests: 0, items: 0, failed: 0, deferred: 0, quarantined: 0, released };
  for (const [i, { principal }] of due.entries()) {
    if (room <= 0) {
      pass.deferred = due.length - i;
      ctx.log.info('{deferred} due digest(s) wait for room: {pending} send(s) are waiting on the platform drain', {
        deferred: pass.deferred,
        pending: MAX_PENDING_PLATFORM_REQUESTS - DIGEST_RESERVE - room,
      });
      break;
    }
    try {
      const rows = ctx.sql.query<HeldRow>(
        `SELECT rowid AS row_id, ${DIGEST_ITEM_COLUMNS} FROM notifications_digest_items
          WHERE principal = ? AND channel = ? AND quarantined_at IS NULL ORDER BY queued_at, id LIMIT ?`,
        [principal, CHANNEL, DIGEST_MAX_ITEMS],
      );
      const held: z.infer<typeof digestItemRow>[] = [];
      const unreadable: { rowId: number; id: unknown; error: string }[] = [];
      for (const { row_id: rowId, ...row } of rows) {
        try {
          held.push(returns(digestItemRow, 'notifications/send-digests', row));
        } catch (err) {
          unreadable.push({ rowId, id: row.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (unreadable.length > 0) {
        await ctx.atomic(() => quarantine(ctx, principal, unreadable, now));
        pass.quarantined += unreadable.length;
      }
      if (held.length === 0) continue;
      const requested = await ctx.atomic(() => sendDigestOf(ctx, principal, held, now));
      pass.digests += 1;
      pass.items += held.length;
      if (requested) room -= 1;
    } catch (err) {
      pass.failed += 1;
      recordDigestFailure(ctx, principal, now, err);
    }
  }
  return pass;
}

/**
 * Read again the set-aside rows whose last reading is a window old, at most `RELEASE_BATCH` a
 * pass, oldest reading first. Each that reads now is held once more — `quarantined_at` cleared,
 * its delivery back to `skipped`/`digest` and unsettled — and announced per person by
 * `notifications.digest-released`. Each that still does not read is marked read now, so it waits
 * another window, and is not announced again. Never throws over a row.
 */
function releaseReadable(ctx: OperationContext, now: string, cutoff: string): number {
  const rows = ctx.sql.query<HeldRow>(
    `SELECT rowid AS row_id, ${DIGEST_ITEM_COLUMNS} FROM notifications_digest_items
      WHERE channel = ? AND quarantined_at IS NOT NULL AND quarantined_at <= ?
      ORDER BY quarantined_at, rowid LIMIT ?`,
    [CHANNEL, cutoff, RELEASE_BATCH],
  );
  const released = new Map<string, string[]>();
  for (const { row_id: rowId, ...row } of rows) {
    let item: z.infer<typeof digestItemRow>;
    try {
      item = returns(digestItemRow, 'notifications/send-digests', row);
    } catch {
      ctx.sql.exec('UPDATE notifications_digest_items SET quarantined_at = ? WHERE rowid = ?', [now, rowId]);
      continue;
    }
    ctx.sql.exec('UPDATE notifications_digest_items SET quarantined_at = NULL WHERE rowid = ?', [rowId]);
    ctx.sql.exec(
      `UPDATE notifications_deliveries SET reason = 'digest', settled_at = NULL
        WHERE id = ? AND status = 'skipped' AND reason = 'quarantined'`,
      [item.id],
    );
    released.set(item.principal, [...(released.get(item.principal) ?? []), item.id]);
  }
  for (const [principal, occasions] of released) {
    emitNotificationsEvent(ctx, {
      type: 'notifications.digest-released',
      entity: { entityType: 'notification-recipient', entityId: principal },
      ...aboutPrincipal(principal),
      payload: { principal, channel: CHANNEL, occasions },
    });
  }
  return [...released.values()].reduce((n, o) => n + o.length, 0);
}

/** One person's digest: the held messages given, as one mail and one delivery. Whether a send was written. */
function sendDigestOf(ctx: OperationContext, principal: string, held: z.infer<typeof digestItemRow>[], now: string): boolean {
  const to = addressOf(ctx, principal);
  const request =
    to === null ? null : requestEmail(ctx, { to, ...digestOf(held), subjectId: dataSubjectId.parse(principal) });
  const outcome = recordDelivery(ctx, {
    topic: DIGEST_TOPIC,
    dedupeKey: ulid(),
    principal,
    about: null,
    status: request === null ? 'skipped' : 'requested',
    reason: request === null ? 'no_address' : null,
    request,
  });
  // The occasions are settled into this digest: still `skipped`/`digest`, now with a time.
  const ids = inList(held.map((h) => h.id));
  ctx.sql.exec(`UPDATE notifications_deliveries SET settled_at = ? WHERE id IN ${ids.sql}`, [now, ...ids.params]);
  ctx.sql.exec(`DELETE FROM notifications_digest_items WHERE id IN ${ids.sql}`, [...ids.params]);
  emitNotificationsEvent(ctx, {
    type: 'notifications.digest-sent',
    entity: { entityType: 'notification-delivery', entityId: outcome.deliveryId },
    ...aboutPrincipal(principal),
    payload: {
      deliveryId: outcome.deliveryId,
      principal,
      channel: CHANNEL,
      cadence: 'daily-digest',
      status: outcome.status,
      reason: outcome.reason,
      request: outcome.request,
      items: held.map((h) => ({
        deliveryId: h.id,
        topic: h.topic,
        dedupeKey: h.dedupe_key,
        about: h.about_type !== null && h.about_id !== null ? { entityType: h.about_type, entityId: h.about_id } : null,
        queuedAt: h.queued_at,
      })),
    },
  });
  return request !== null;
}

/**
 * Set aside held rows found unreadable for the first time. Each is marked `quarantined_at` —
 * not sent, and not counted when deciding who is due — until it reads again (`releaseReadable`)
 * or an erasure of the person deletes it. Each occasion whose id still reads has its delivery
 * settled `skipped` with reason `quarantined`, which is what the delivery log shows.
 * `notifications.digest-quarantined` and an error line name the occasions, never what the rows
 * held.
 */
function quarantine(
  ctx: OperationContext,
  principal: string,
  rows: { rowId: number; id: unknown; error: string }[],
  now: string,
): void {
  const occasions: string[] = [];
  for (const row of rows) {
    ctx.sql.exec('UPDATE notifications_digest_items SET quarantined_at = ? WHERE rowid = ?', [now, row.rowId]);
    if (typeof row.id !== 'string') continue;
    occasions.push(row.id);
    ctx.sql.exec(
      `UPDATE notifications_deliveries SET reason = 'quarantined', settled_at = ?
        WHERE id = ? AND status = 'skipped' AND reason = 'digest'`,
      [now, row.id],
    );
  }
  ctx.log.error('{count} message(s) held for the digest of {principal} no longer read and are set aside: {occasions} ({error})', {
    count: rows.length,
    principal,
    occasions: occasions.join(', '),
    error: rows[0]!.error,
  });
  emitNotificationsEvent(ctx, {
    type: 'notifications.digest-quarantined',
    entity: { entityType: 'notification-recipient', entityId: principal },
    ...aboutPrincipal(principal),
    payload: { principal, channel: CHANNEL, occasions, unidentified: rows.length - occasions.length },
  });
}

/**
 * A person's digest could not be composed. Their messages stay held, marked so the next attempt
 * waits a window rather than failing again on every pass, and the failure is said twice: an
 * event on the spine, naming the person and how many messages wait, and an error line carrying
 * the cause. Not the cause on the event: an error's text is not a frozen payload.
 */
function recordDigestFailure(ctx: OperationContext, principal: string, now: string, err: unknown): void {
  const [held] = ctx.sql.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM notifications_digest_items
      WHERE principal = ? AND channel = ? AND quarantined_at IS NULL`,
    [principal, CHANNEL],
  );
  ctx.sql.exec(
    'UPDATE notifications_digest_items SET failed_at = ? WHERE principal = ? AND channel = ? AND quarantined_at IS NULL',
    [now, principal, CHANNEL],
  );
  const code = isSubstratError(err) ? err.code : 'internal';
  const retryAt = new Date(Date.parse(now) + DIGEST_WINDOW_MS).toISOString();
  ctx.log.error('the digest for {principal} could not be sent; {items} message(s) stay held until {retryAt}: {error}', {
    principal,
    items: held?.n ?? 0,
    retryAt,
    error: err instanceof Error ? err.message : String(err),
  });
  emitNotificationsEvent(ctx, {
    type: 'notifications.digest-failed',
    entity: { entityType: 'notification-recipient', entityId: principal },
    ...aboutPrincipal(principal),
    payload: { principal, channel: CHANNEL, cadence: 'daily-digest', items: held?.n ?? 0, code, retryAt },
  });
}

// ============================================================================
// Settle — the platform says what became of a send
// ============================================================================

// The engine's own view of the outcome payload (#2102) — what it needs, parsed here.
const emailOutcome = z.object({ request: z.string().min(1), code: z.string().min(1).nullable() });

function settleConsumer(status: (typeof EMAIL_OUTCOMES)[EmailOutcomeType]): ConsumerHandler {
  return async (ctx, event) => {
    const { request, code } = emailOutcome.parse(event.payload);
    // Only a delivery still waiting moves: another module's mail has no row here, and a
    // repeated outcome finds its row already settled.
    const [row] = ctx.sql.query<{ id: string; topic: string; principal: string; channel: string }>(
      `UPDATE notifications_deliveries SET status = ?, reason = ?, settled_at = ?
        WHERE request_id = ? AND status = 'requested'
        RETURNING id, topic, principal, channel`,
      [status, code, ctx.now(), request],
    );
    if (!row) return;
    emitNotificationsEvent(ctx, {
      type: 'notifications.delivery-settled',
      entity: { entityType: 'notification-delivery', entityId: row.id },
      ...aboutPrincipal(row.principal),
      payload: { deliveryId: row.id, topic: row.topic, principal: row.principal, channel: row.channel, status, code, request },
    });
  };
}

// ============================================================================
// The registration
// ============================================================================

export const notificationsModule: ModuleRegistration = {
  manifest: notificationsManifest,
  migrations: notificationsMigrations,
  consumers: Object.fromEntries(
    Object.entries(EMAIL_OUTCOMES).map(([type, status]) => [type, settleConsumer(status)]),
  ),
  ...operationsFor(notificationsOperations)({
    'notifications/my-preferences': async (ctx) => {
      assertAllowed(await ctx.check(NOTIFICATIONS_PERM.self));
      return myPreferencesOf(ctx);
    },
    'notifications/set-my-address': async (ctx, input) => {
      assertAllowed(await ctx.check(NOTIFICATIONS_PERM.self));
      return setMyAddress(ctx, input);
    },
    'notifications/set-my-preference': async (ctx, input) => {
      assertAllowed(await ctx.check(NOTIFICATIONS_PERM.self));
      return setMyPreference(ctx, input);
    },
    'notifications/list-deliveries': async (ctx, input) => {
      assertAllowed(await ctx.check(NOTIFICATIONS_PERM.read));
      // `input` is absent when invoked with no body at all (`inputOptional`).
      return listDeliveries(ctx, {
        ...input,
        filters: { status: input?.status, topic: input?.topic, principal: input?.principal },
      });
    },
    'notifications/send-digests': async (ctx) => {
      assertAllowed(await ctx.check(NOTIFICATIONS_PERM.sendDigests));
      return sendDigests(ctx);
    },
  }),
};
