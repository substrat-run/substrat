import { z } from 'zod';
import { actor, eventType } from './events.js';
import { eventId, instant, principalId, scopeId } from './ids.js';

/**
 * The Tier-2 lake's query gateway (#1334): what a caller may ASK of `kernel.events`, and
 * what comes back. The gateway that answers it lives in `@substrat-run/control-plane-api`.
 *
 * **No tenant field, on purpose.** The tenant a lake read is about is the route's
 * authenticated path segment and nothing else. The schema is `.strict()`, so a request
 * naming a `tenantId` (or anything else this list does not name) is refused rather than
 * ignored — a caller cannot express a second tenant, which is the whole contract.
 *
 * **No payload, subject, authorization or impersonation detail comes back.** Erasure
 * reaches only the lake rows the drain sealed (#3464, `lakeSealedPayload` below): rows
 * shipped before sealing was switched on still hold their payload in the clear, so the
 * gateway answers with the envelope only. `impersonated` says whether a staff session was
 * behind the event, which is the question an audit asks, without the session's own details.
 */

/**
 * A lake row's `payload` once the drain has sealed it (#3464, K-37 limit 6): the payload's JSON
 * text sealed under its subject's own key, in the shape a sealed backup cell already has
 * (`seal.ts` in `@substrat-run/control-plane-api`). The key lives in the directory, and a shred
 * tombstones it, so after an erasure this cell opens to nothing. `keyId` names the subject
 * (`subject:<id>`), so the cell needs nothing beside it to find its key.
 *
 * It fits the stream's existing nullable `json` column, so sealing needs no new stream. A
 * tombstoned subject's payload ships as `null`, the same absence a live redaction leaves.
 */
export const lakeSealedPayload = z
  .object({ __sealed: z.object({ keyId: z.string().min(1), ciphertext: z.string().min(1) }).strict() })
  .strict();
export type LakeSealedPayload = z.infer<typeof lakeSealedPayload>;

/**
 * The characters a free-text filter may carry. Every value the gateway writes into SQL is
 * a literal, and this alphabet holds no quote, backslash, whitespace or comment marker, so
 * no value in it can end the literal it sits in. Anything outside it is refused, never
 * escaped: a refusal is checkable, an escape is a dialect question. Entity types, entity
 * ids, operation names (`todo/create-list`) and version ids all fit.
 */
export const LAKE_LITERAL = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const lakeLiteral = z.string().regex(LAKE_LITERAL);

export const LAKE_EVENTS_LIMIT_MAX = 200;
export const LAKE_EVENTS_LIMIT_DEFAULT = 50;

/**
 * One page of a tenant's lake events, newest first. Every filter narrows; none widens.
 * Arrives as a query string, so the number and the flag are coerced from text, and the
 * flag accepts `true` only: "not impersonated" is not a question this read answers.
 */
const lakeEventsFilters = z.object({
    scopeId: scopeId.optional(),
    type: eventType.optional(),
    entityType: lakeLiteral.optional(),
    entityId: lakeLiteral.optional(),
    /** A principal. A system, connector, capability or vertical actor is not filterable yet. */
    actor: principalId.optional(),
    operation: lakeLiteral.optional(),
    version: lakeLiteral.optional(),
    impersonated: z.literal('true').transform(() => true as const).optional(),
    /** `occurred_at` window, inclusive start and exclusive end. */
    since: instant.optional(),
    until: instant.optional(),
    /** The last event id of the previous page. */
    cursor: eventId.optional(),
    limit: z.coerce.number().int().min(1).max(LAKE_EVENTS_LIMIT_MAX).default(LAKE_EVENTS_LIMIT_DEFAULT),
  });

const entityIdNeedsType = { message: 'entityId needs entityType: an id alone names no record', path: ['entityId'] };
const namesARecord = (i: { entityId?: string; entityType?: string }) => i.entityId === undefined || i.entityType !== undefined;

export const lakeEventsInput = lakeEventsFilters.strict().refine(namesARecord, entityIdNeedsType);
export type LakeEventsInput = z.infer<typeof lakeEventsInput>;

/** The widest window a team's own credential may read in one query (#1334). */
export const LAKE_TEAM_WINDOW_DAYS = 31;

/**
 * A team's read of its own lake events: the same filters, with `since` required. The control
 * plane also holds the span to `LAKE_TEAM_WINDOW_DAYS`, measured from `since` to `until` or to
 * its own clock, whichever is earlier, so a read without `until` should ask for a little less.
 */
export const teamLakeEventsInput = lakeEventsFilters
  .extend({ since: instant })
  .strict()
  .refine(namesARecord, entityIdNeedsType);

/** One event as the lake holds it, envelope only. */
export const lakeEvent = z.object({
  id: eventId,
  type: z.string(),
  schemaVersion: z.number().int(),
  occurredAt: instant,
  scopeId,
  actor,
  entityType: z.string(),
  entityId: z.string(),
  piiClass: z.string(),
  operation: z.string().nullable(),
  version: z.string().nullable(),
  causedBy: z.string().nullable(),
  invocationId: z.string().nullable(),
  impersonated: z.boolean(),
});
export type LakeEvent = z.infer<typeof lakeEvent>;

/**
 * A page of lake events. `consistency` is always `eventual`: the lake trails the scope by
 * the drain's cadence plus the sink's file roll (minutes, `concepts/reads.md`), so an
 * event missing here may simply not have arrived — the scope's own history is the live one.
 */
export const lakeEventsPage = z.object({
  events: z.array(lakeEvent),
  nextCursor: eventId.nullable(),
  consistency: z.literal('eventual'),
});
export type LakeEventsPage = z.infer<typeof lakeEventsPage>;
