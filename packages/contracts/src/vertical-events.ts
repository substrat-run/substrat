import { z } from 'zod';
import { eventId, instant, permissionKey, scopeId, verticalSlug } from './ids.js';
import { entityRef, eventType } from './events.js';

// Cross-vertical event delivery (#1705): the three messages the platform carries between a
// producer vertical's scope and a consumer vertical's scope in the same tenant.
//
// The shape of the whole thing, so the schemas below read in context. An export is a
// declaration over the producer's OWN outbox, which is retained, so nothing new is written
// when an exported event commits. The platform sweep asks the consumer where it got to
// (`importState`), reads the producer's outbox after that watermark (`exportRead`), and
// hands the batch to the consumer (`importBatch`). The consumer runs its handlers and moves
// its watermark in the same store as their writes. Because the consumer holds the cursor,
// a restore of the consumer rewinds the cursor and the data together, and a consumer
// installed after the producer starts from the beginning of the exported history.

/**
 * One exported event as it crosses (#1705): the domain fact, and not the producer's
 * record of who was allowed to cause it.
 *
 * Deliberately NOT the envelope (`domainEvent`). `actor`, `authorization` and
 * `impersonation` describe authority inside the producer's scope: a principal id that
 * means nothing to another vertical and identifies a person to anyone who can join it
 * back, the K-34 chain, and a staff session. None of that is the consumer's to hold. So is
 * `piiClass`: only `none` crosses, so the field would carry one value. `subjectId` crosses
 * neither, because a `none` event has none.
 *
 * `hops` is how many vertical boundaries this event's cause chain has crossed, counting
 * this one. It is what breaks a P ↔ C loop. The in-scope cascade cap only defers a round
 * to the next call, so it would let two verticals feed each other forever at sweep pace.
 */
export const exportedEvent = z.object({
  id: eventId,
  type: eventType,
  schemaVersion: z.number().int().positive(),
  occurredAt: instant,
  entity: entityRef,
  payload: z.unknown(),
  hops: z.number().int().positive(),
});
export type ExportedEvent = z.infer<typeof exportedEvent>;

/**
 * Why an event of a type the consumer asked for was not released to it (#1705).
 *
 * Each is PERMANENT for that event, which is what licenses stepping the watermark
 * past it: the classification, the version and the cause chain are all fixed once
 * the row is written, so asking again cannot change the answer. Authority is
 * deliberately NOT a reason here. It can change, so a missing key pauses the whole
 * edge (`paused`) instead of dropping what arrived while it was missing.
 *
 * - `pii`: the row is classified other than `none`. Only textless events cross.
 * - `version`: the row's schemaVersion is not the one the consumer declares (K-39:
 *   a strict parse on the other side would reject it, so it is never handed over).
 * - `cascade`: the cause chain has already crossed the maximum number of vertical
 *   boundaries.
 * - `undecodable`: the stored row does not decode (#1636). The decode is pure, of text
 *   already written, so a retry cannot succeed. The in-scope consumers dead-letter the same
 *   row for the same reason.
 */
export const withheldReason = z.enum(['pii', 'version', 'cascade', 'undecodable']);
export type WithheldReason = z.infer<typeof withheldReason>;

/**
 * A withheld row, named but not carried: no payload crosses. The fields are the stored
 * columns, read leniently, because an `undecodable` row is the one whose columns may be
 * exactly what failed. The consumer journals this as a dead letter, so its operator sees
 * that something was sent and not delivered.
 */
export const withheldEvent = z.object({
  id: eventId,
  type: z.string().min(1),
  schemaVersion: z.number().int(),
  occurredAt: z.string().min(1),
  entity: z.object({ entityType: z.string().min(1), entityId: z.string().min(1) }),
  reason: withheldReason,
});
export type WithheldEvent = z.infer<typeof withheldEvent>;

/** One (type, version) a consumer declares it receives from a given producer. */
export const wantedEvent = z.object({
  type: eventType,
  schemaVersion: z.number().int().positive(),
});
export type WantedEvent = z.infer<typeof wantedEvent>;

/**
 * The producer-side read (#1705): what the platform asks a producer scope for.
 *
 * `consumer` is the receiving vertical's slug, asserted by the platform from its directory
 * and never taken from either vertical. `wants` is what the consumer declares, and it is a
 * request, not an authority: the producer answers from its own running `exports`, so a type
 * it does not export is never released however it is asked for.
 */
export const exportReadInput = z.object({
  consumer: verticalSlug,
  /** The consumer's watermark: the last event id it has taken from this producer, or null. */
  after: eventId.nullable(),
  wants: z.array(wantedEvent).min(1),
  limit: z.number().int().min(1).max(1000),
});
export type ExportReadInput = z.infer<typeof exportReadInput>;

/**
 * The producer's answer (#1705).
 *
 * `next` is the watermark the consumer should hold once it has taken this batch: the id of
 * the last row the read WALKED, released or withheld. A withheld row is stepped over
 * because its reason is permanent. A paused edge answers with `next === after` and no
 * events: the read walked nothing, so the producer's outbox keeps the backlog.
 *
 * `paused` lists the keys the consumer's principal does not hold here. `unexported`
 * lists what the consumer wants and this producer does not export at all. That is
 * reported rather than paused, because a consumer may declare an import its producer has
 * not shipped yet.
 */
export const exportedBatch = z.object({
  events: z.array(exportedEvent),
  withheld: z.array(withheldEvent),
  unexported: z.array(wantedEvent),
  paused: z.object({ missing: z.array(permissionKey).min(1) }).nullable(),
  next: eventId.nullable(),
  /** The read stopped at `limit`, so more rows may be waiting. */
  more: z.boolean(),
});
export type ExportedBatch = z.infer<typeof exportedBatch>;

/** One producer a consumer scope has taken events from, and how far (#1705). */
export const importCursor = z.object({
  source: scopeId,
  vertical: verticalSlug,
  cursor: eventId.nullable(),
  updatedAt: instant.nullable(),
});
export type ImportCursor = z.infer<typeof importCursor>;

/**
 * What a consumer scope says about itself before a pass (#1705): what its RUNNING code
 * imports, and its watermark per producer. Both come from the consumer, not the registry,
 * because the version serving the scope is the one whose handlers will run.
 */
export const importState = z.object({
  consumes: z.array(z.object({ from: verticalSlug, type: eventType, schemaVersion: z.number().int().positive() })),
  cursors: z.array(importCursor),
});
export type ImportState = z.infer<typeof importState>;

/**
 * The batch handed to the consumer (#1705).
 *
 * `after` is a compare-and-set: the consumer applies the batch only if its watermark for
 * this source is still `after`. Two overlapping passes (a sweep that outruns its interval)
 * would otherwise each apply what they read, and the one that read less would move the
 * watermark BACKWARDS. The redelivery that caused would be absorbed by the delivery
 * journal, but it is still work nobody asked for.
 */
export const importBatch = z.object({
  source: z.object({ vertical: verticalSlug, scopeId }),
  after: eventId.nullable(),
  next: eventId,
  events: z.array(exportedEvent),
  withheld: z.array(withheldEvent),
});
export type ImportBatch = z.infer<typeof importBatch>;

/**
 * What applying one batch did (#1705).
 *
 * `stale`: the compare-and-set refused the batch, and nothing ran. `paused`: this scope
 * refused the producer at its door. The producer is not a declared peer here, or its kill
 * switch is off, so nothing ran, the watermark did not move, and the producer's outbox keeps
 * the backlog until the peer is admitted again. It is the consumer side's twin of
 * `ExportedBatch.paused`.
 */
export const importResult = z.object({
  delivered: z.number().int().nonnegative(),
  deadLettered: z.number().int().nonnegative(),
  /** Events already journaled here, from an earlier pass, and skipped. */
  duplicates: z.number().int().nonnegative(),
  withheld: z.number().int().nonnegative(),
  cursor: eventId.nullable(),
  stale: z.boolean(),
  paused: z.object({ reason: z.string().min(1) }).nullable(),
});
export type ImportResult = z.infer<typeof importResult>;

/**
 * The event an import handler is handed (#1705): the crossed fact plus where it came from.
 *
 * `source` is platform-asserted, from the directory: the producer's vertical and the scope
 * that emitted it. It is DATA, never authority. What the handler may do in its own scope is
 * decided by its own checks, against the grants its scope gave the producer's principal.
 */
export type ImportedEvent = Omit<ExportedEvent, 'hops'> & {
  source: { vertical: string; scopeId: z.infer<typeof scopeId> };
};

/** How many vertical boundaries a cause chain may cross before its next export is withheld. */
export const EXPORT_HOP_CAP = 8;
