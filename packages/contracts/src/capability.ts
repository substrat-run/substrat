import { z } from 'zod';
import { entityRef } from './events.js';
import { capabilityId, instant, permissionKey, platformActorId, principalId, scopeId } from './ids.js';
import { coverage } from './permission.js';

/**
 * Capabilities (#1672) — authority carried by a SECRET rather than held by a principal.
 *
 * The permission checker reasons about principals, and a link share is authority held by
 * whoever has the URL: nobody the checker knows. #97 solved the neighbouring case for
 * connectors by letting the connection BE an actor; this does the same for a secret. A
 * capability is a directory row, the row names what it may do, and the holder of its
 * secret acts as `{ capability: <id> }` — resolved by the checker, recorded on the event,
 * refused into the denial log, like any other actor.
 *
 * It is a building block rather than a link-share feature. The repo carried three
 * hand-built "authority carried by a secret" mechanisms (owner claim links, member
 * invites, the dashboard's signed tokens), each with its own table and a code path outside
 * the checker, none of them on the spine as authority. So the shape here has what those
 * need even where a link share does not: a use limit beside the expiry, and a `become`
 * mode for "exercising this binds that principal".
 *
 * **Directory-backed, never self-contained.** The checker reads the row on every check, so
 * revoking one is the next read, and every exchange is a counted, recorded use. Only the
 * secret's SHA-256 is ever stored; the secret itself leaves the kernel once, in the mint's
 * return value.
 *
 * **A use is an exchange, not an invocation.** The secret is presented once, traded for a
 * session cookie (so it does not live in history or `Referer`), and the session then acts
 * until the capability expires or is revoked. A read-only share makes dozens of calls per
 * page load, and a single-use invite would otherwise be spent by its own redemption — so
 * `maxUses` bounds how many browsers may hold a capability, not how many reads they make.
 */

/** What every minted secret starts with — so a secret scanner can recognise a leaked one. */
export const CAPABILITY_SECRET_PREFIX = 'sbcap_';
/** What every session token an exchange hands out starts with. */
export const CAPABILITY_SESSION_PREFIX = 'sbses_';
/** How long a session outlives its exchange, at most — never past the capability itself. */
export const CAPABILITY_SESSION_TTL_MS = 24 * 60 * 60_000;
/** The most keys one capability may carry. A link that needs more is a role. */
export const CAPABILITY_PERMISSIONS_MAX = 16;
/** The most operations one capability's allowlist may name. */
export const CAPABILITY_OPERATIONS_MAX = 32;

/** An optional operator-facing name for a capability ("client review link"). Never a secret. */
export const capabilityLabel = z.string().trim().min(1).max(200);

/**
 * (Not `capabilityGrant` — that older name in `permission.ts` is an entity-narrowed grant
 * to a PRINCIPAL, and predates this module.)
 *
 * What an `act` capability may do: ONE entity and everything beneath it through declared
 * parent edges, specific keys on that subtree, and optionally an allowlist of operations.
 *
 * The keys are the authority — each is checked against the entity exactly as an
 * entity-narrowed grant would be, which is how grants already travel. `operations`
 * narrows on top of them and never widens: an operation outside the list is refused at
 * the door before its handler runs, however much the keys would have allowed. A
 * capability never holds node-level authority, so an operation whose only check is a
 * node-level one refuses it.
 */
export const capabilityAuthority = z.object({
  entity: entityRef,
  permissions: z.array(permissionKey).min(1).max(CAPABILITY_PERMISSIONS_MAX),
  operations: z.array(z.string().min(1)).min(1).max(CAPABILITY_OPERATIONS_MAX).optional(),
  /** Explicitly allow attachment reads; this never widens permissions or operations. */
  attachments: z.literal('read').optional(),
});
export type CapabilityAuthority = z.infer<typeof capabilityAuthority>;

/**
 * What a MODULE may mint (`ctx.capabilities.mint`) — always an `act` capability.
 *
 * `expiresAt` absent means no expiry; `maxUses` absent means unlimited exchanges. Both are
 * a vertical's call: "anyone with the link" is how most sharing works, and a link share
 * that must die on Friday says so. Neither widens authority — the minter's own is
 * re-checked on every use.
 */
export const capabilityMintInput = capabilityAuthority.extend({
  expiresAt: instant.optional(),
  maxUses: z.number().int().positive().optional(),
  label: capabilityLabel.optional(),
});
export type CapabilityMintInput = z.infer<typeof capabilityMintInput>;

/**
 * What the PLATFORM may mint (`HostAdmin.mintCapability`) — a `become` capability:
 * exchanging it yields a principal instead of a session, the shape an owner claim link and
 * a member invite are ("whoever opens this becomes that seat").
 *
 * `become` is impersonation by another name — the holder acquires everything the principal
 * holds — so module code never mints one. The platform mints this shape (an owner claim link);
 * a PRINCIPAL mints one only through a host's bounded verb (a member invite,
 * `principalBecomeCapabilityInput`, #1686). Expiry and a use limit are REQUIRED here: an
 * unbounded platform `become` is a standing credential for a person.
 */
export const becomeCapabilityInput = z.object({
  principal: principalId,
  expiresAt: instant,
  maxUses: z.number().int().positive(),
  label: capabilityLabel.optional(),
});
export type BecomeCapabilityInput = z.infer<typeof becomeCapabilityInput>;

/**
 * What a PRINCIPAL may mint through a host's bounded verb (#1686) — a `become` capability
 * whose minter is a person rather than the platform: the shape a member invite is.
 *
 * The bound is the host's, checked in the same scope task as the write: the minter must hold,
 * at this node, every permission the target principal holds there, and every entity-narrowed
 * grant the target holds must be one the minter can exercise on that entity too. Otherwise
 * minting a `become` would hand someone more than the minter has — impersonation upward.
 *
 * `expiresAt` absent means no expiry, because a member invite has never had one; the use
 * limit is still required, as on every `become`. The minter is not re-checked when the secret
 * is exchanged: the target's authority was bounded when it was conferred and when this was
 * minted, and withdrawing the invite (revoking this) is the lever.
 */
export const principalBecomeCapabilityInput = z.object({
  principal: principalId,
  expiresAt: instant.optional(),
  maxUses: z.number().int().positive(),
  label: capabilityLabel.optional(),
});
export type PrincipalBecomeCapabilityInput = z.infer<typeof principalBecomeCapabilityInput>;

/**
 * Who minted or revoked a capability: the principal whose operation did it, or a platform
 * actor through `HostAdmin`. Two members rather than a principal with a flag, because an
 * `act` capability's authority is re-checked against its minter on every use and only a
 * principal CAN be re-checked — a platform actor holds no tuples.
 */
export const capabilityAuthor = z.union([principalId, z.object({ platform: platformActorId })]);
export type CapabilityAuthor = z.infer<typeof capabilityAuthor>;

const capabilityRecordCommon = {
  id: capabilityId,
  label: capabilityLabel.nullable(),
  mintedBy: capabilityAuthor,
  mintedAt: instant,
  /** Null = never expires. */
  expiresAt: instant.nullable(),
  /** Null = unlimited exchanges. */
  maxUses: z.number().int().positive().nullable(),
  /** Exchanges so far. Never above `maxUses`. */
  uses: z.number().int().nonnegative(),
  lastUsedAt: instant.nullable(),
  revokedAt: instant.nullable(),
  revokedBy: capabilityAuthor.nullable(),
  /**
   * Why the kernel itself revoked it, when it did (#1686): `holdings-changed` — a principal-minted
   * `become` whose principal's holdings changed between mint and exchange. Null for a revoke a
   * person or the platform made, and for a live capability. Absent from a host that predates it.
   */
  revokedReason: z.enum(['holdings-changed']).nullable().optional(),
};

/**
 * A capability as the directory holds it — what `ctx.capabilities.list` returns. Carries
 * neither the secret nor its hash: the one is never stored, and the other is nothing a
 * caller has a use for.
 */
export const capabilityRecord = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('act'),
    ...capabilityRecordCommon,
    entity: entityRef,
    permissions: z.array(permissionKey).min(1),
    /** Null = any operation the keys allow. */
    operations: z.array(z.string().min(1)).nullable(),
    /** Absent/null = attachment readers remain refused when `operations` is narrowed. */
    attachments: z.literal('read').nullable().optional(),
  }),
  z.object({
    mode: z.literal('become'),
    ...capabilityRecordCommon,
    principal: principalId,
  }),
]);
export type CapabilityRecord = z.infer<typeof capabilityRecord>;

/**
 * What a mint hands back — the ONLY time the secret exists outside the caller's hands.
 * The kernel keeps its hash; a vertical builds the link from it and returns it once.
 */
export const mintedCapability = z.object({
  id: capabilityId,
  secret: z.string().startsWith(CAPABILITY_SECRET_PREFIX),
  expiresAt: instant.nullable(),
});
export type MintedCapability = z.infer<typeof mintedCapability>;

/**
 * Why a host's bounded `become` mint refused (#1686), with nothing written:
 * - `coverage` — what the minter lacks of what the target holds;
 * - `target-holds-nothing` — the target holds nothing at the node. Its own answer because a
 *   `Coverage` refusal must name a missing key and there is none: an empty set would cover
 *   trivially, and the link would yield whatever that principal is granted later;
 * - `target-already-claimed` — some `become` capability for the target has already been
 *   exchanged in this scope: somebody already is that principal, and a second link would let a
 *   second person become them too. A principal-minted `become` is for a seat nobody has taken.
 */
export const becomeMintRefusal = z.union([
  z.object({ ok: z.literal(false), coverage }),
  z.object({ ok: z.literal(false), refused: z.enum(['target-holds-nothing', 'target-already-claimed']) }),
]);
export type BecomeMintRefusal = z.infer<typeof becomeMintRefusal>;

/** What a host's bounded `become` mint answers (#1686): the minted capability, or the refusal. */
export const boundedBecomeMint = z.union([z.object({ ok: z.literal(true), minted: mintedCapability }), becomeMintRefusal]);
export type BoundedBecomeMint = z.infer<typeof boundedBecomeMint>;

/**
 * What a host's bounded `become` revoke answers (#1686): whether this call revoked it, or the
 * coverage that refused the revoker — who must be the link's minter, or hold everything its
 * principal holds now (whoever could have minted it). A refusal writes nothing.
 */
export const boundedBecomeRevoke = z.union([
  z.object({ ok: z.literal(true), revoked: z.boolean() }),
  z.object({ ok: z.literal(false), coverage }),
]);
export type BoundedBecomeRevoke = z.infer<typeof boundedBecomeRevoke>;

/**
 * Where a `become` link stands (#1686) — what a pending-invite list shows beside each invite, so
 * a link the kernel revoked is never shown as open. `used`: exchanged up to its limit. A
 * capability the scope does not hold reads as `revoked`.
 */
export const becomeLinkState = z.object({
  state: z.enum(['open', 'used', 'revoked', 'expired']),
  /** Why the kernel revoked it, when it did; null otherwise. */
  reason: z.enum(['holdings-changed']).nullable(),
});
export type BecomeLinkState = z.infer<typeof becomeLinkState>;

/**
 * The most links one `becomeLinkStates` call may name — the cap other id-list reads take
 * (`CONNECT_LINK_LIST_MAX_IDS`, a grant-scoped read's maximum). Over it the read refuses rather
 * than truncate; a list longer than this asks in pages of it.
 */
export const BECOME_LINK_STATES_MAX_IDS = 100;

/**
 * What an exchange yields: a session to act as the capability (`act`), or the principal
 * the holder becomes (`become`). A refused exchange — an unknown, expired, revoked or
 * used-up secret — is `null`, one answer for all four, so a probe learns nothing.
 */
export const capabilityExchange = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session'),
    capabilityId,
    sessionToken: z.string().startsWith(CAPABILITY_SESSION_PREFIX),
    expiresAt: instant,
    entity: entityRef,
  }),
  z.object({
    kind: z.literal('principal'),
    capabilityId,
    principal: principalId,
  }),
]);
export type CapabilityExchange = z.infer<typeof capabilityExchange>;

/**
 * What narrows `ctx.capabilities.list` and `HostAdmin.listCapabilities`. Live capabilities
 * only unless `includeRevoked`.
 *
 * `cursor` is the platform's keyset cursor (`pagination.ts`): the `id` of the last record of
 * the previous page, EXCLUSIVE, walking newest to oldest. A capability id is a ULID, so a
 * cursor that is not one is refused rather than read as "from the start" — a walk that
 * silently restarted would loop forever.
 */
export const capabilityFilter = z.object({
  entity: entityRef.optional(),
  includeRevoked: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: capabilityId.optional(),
});
export type CapabilityFilter = z.infer<typeof capabilityFilter>;

/**
 * One page of the operator's capability read: records newest first, and `nextCursor` — the
 * last entry's id — ONLY when at least one more record follows. The adapters read one row
 * past the page to know, so a full last page ends the walk instead of costing an empty fetch.
 * Parsing a vertical's answer through this drops any field a record does not declare.
 */
export const capabilityPage = z.object({
  entries: z.array(capabilityRecord),
  nextCursor: capabilityId.nullable(),
});
export type CapabilityPage = z.infer<typeof capabilityPage>;

/**
 * The operator's revoke on its way to the deployment serving a scope (#1686,
 * `/internal/capabilities/revoke`): which capability, and the platform actor its record names
 * as the revoker. The control plane made the tenant check and keeps the admin log; the scope is
 * all the far end needs to find the row.
 */
export const capabilityRevokeRequest = z
  .object({ scopeId, capabilityId, actor: platformActorId })
  .strict();
export type CapabilityRevokeRequest = z.infer<typeof capabilityRevokeRequest>;

/**
 * Its answer: the record as it stood before the revoke (revoked now, or already), or `null` when
 * the scope holds no such capability. An answer, never a 404, because a 404 is how a deployment
 * built before the route says it does not have it.
 */
export const capabilityRevokeAnswer = z.object({ before: capabilityRecord.nullable() }).strict();
export type CapabilityRevokeAnswer = z.infer<typeof capabilityRevokeAnswer>;

/**
 * Where a capability stands NOW, read off its record — for a surface that shows many at once
 * (the operator's console, #1686). `revoked` and `expired` mean no session it handed out acts
 * any more; `used-up` means its secret cannot be exchanged again but sessions it already
 * handed out keep acting until the expiry or a revoke. The record-side twin of the kernel's
 * `capabilityLive` / `capabilityExchangeable` (which read the stored row): the kernel's tests
 * pin that the two agree on every case, so a console cannot call live what the checker refuses.
 */
export type CapabilityStatus = 'live' | 'used-up' | 'expired' | 'revoked';

export function capabilityStatus(
  record: Pick<CapabilityRecord, 'revokedAt' | 'expiresAt' | 'maxUses' | 'uses'>,
  now: string,
): CapabilityStatus {
  if (record.revokedAt !== null) return 'revoked';
  if (record.expiresAt !== null && record.expiresAt <= now) return 'expired';
  if (record.maxUses !== null && record.uses >= record.maxUses) return 'used-up';
  return 'live';
}

/**
 * `capabilityFilter` as a query string — the ENCODER half of the operator's capability read
 * (#1686), for the platform's client of a vertical and the staff client. One definition, so
 * the two never disagree on a name; `capabilityFilterQuery` below is the decoder.
 *
 * The entity travels as two params, `entityType` and `entityId`, and only together.
 */
export function capabilityFilterParams(filter?: CapabilityFilter): URLSearchParams {
  const q = new URLSearchParams();
  if (filter?.entity) {
    q.set('entityType', filter.entity.entityType);
    q.set('entityId', filter.entity.entityId);
  }
  if (filter?.includeRevoked) q.set('includeRevoked', 'true');
  if (filter?.limit) q.set('limit', String(filter.limit));
  if (filter?.cursor) q.set('cursor', filter.cursor);
  return q;
}

/** `capabilityFilterParams` as a URL suffix: `?`-prefixed, or `''` when nothing is narrowed. */
export function capabilityQuery(filter?: CapabilityFilter): string {
  const qs = capabilityFilterParams(filter).toString();
  return qs ? `?${qs}` : '';
}

/**
 * The DECODER half: a query string's params back into a `CapabilityFilter`, for both HTTP
 * surfaces that read capabilities (the control plane's staff route and a vertical's
 * `/internal/capabilities`). Strings are coerced here; the rules (a limit of 1..200, an
 * entity) stay `capabilityFilter`'s, which the result is parsed by. A half-named entity is
 * refused, not ignored: a narrowing that silently widened would list every capability.
 */
export const capabilityFilterQuery = z
  .object({
    entityType: z.string().min(1).optional(),
    entityId: z.string().min(1).optional(),
    includeRevoked: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().optional(),
    cursor: z.string().min(1).optional(),
  })
  .superRefine((q, ctx) => {
    if ((q.entityType === undefined) !== (q.entityId === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'entityType and entityId are given together or not at all' });
    }
  })
  .transform((q, ctx) => {
    const parsed = capabilityFilter.safeParse({
      ...(q.entityType !== undefined && q.entityId !== undefined
        ? { entity: { entityType: q.entityType, entityId: q.entityId } }
        : {}),
      ...(q.includeRevoked !== undefined ? { includeRevoked: q.includeRevoked === 'true' } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    });
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    return z.NEVER;
  });

// ---------------------------------------------------------------------------
// The spine events the kernel emits about capabilities — kernel-authored, like
// `attachment.added`, so module code can neither forge nor suppress them. Fat, per
// the event rule: a consumer never has to read the directory to know what happened.
// Never the secret, never its hash.
// ---------------------------------------------------------------------------

/** A module minted an `act` capability. Entity: the shared entity; actor: the minter. */
export const CAPABILITY_MINTED = 'capability.minted';
/** A module revoked one. Entity: the shared entity; actor: the revoker. */
export const CAPABILITY_REVOKED = 'capability.revoked';
/**
 * A secret was exchanged — one counted use. Entity: the shared entity for `act`, the
 * capability itself (`capability:<id>`) for `become`; actor: `{ capability }`.
 */
export const CAPABILITY_EXERCISED = 'capability.exercised';
/**
 * A principal minted a `become` capability through a host's bounded verb (#1686) — a member
 * invite. Entity: the capability itself (`capability:<id>`), as on a `become`'s
 * `capability.exercised`; actor: the minter. Its own type rather than `capability.minted`,
 * whose payload is an `act` capability's (an entity and its keys) and is frozen.
 */
export const CAPABILITY_BECOME_MINTED = 'capability.become-minted';

export const capabilityMintedPayload = z.object({
  capabilityId,
  entity: entityRef,
  permissions: z.array(permissionKey).min(1),
  operations: z.array(z.string().min(1)).nullable(),
  expiresAt: instant.nullable(),
  maxUses: z.number().int().positive().nullable(),
  label: capabilityLabel.nullable(),
  mintedBy: principalId,
});
export type CapabilityMintedPayload = z.infer<typeof capabilityMintedPayload>;

export const capabilityBecomeMintedPayload = z.object({
  capabilityId,
  /** The principal whoever exchanges the secret becomes. */
  principal: principalId,
  expiresAt: instant.nullable(),
  maxUses: z.number().int().positive(),
  label: capabilityLabel.nullable(),
  mintedBy: principalId,
});
export type CapabilityBecomeMintedPayload = z.infer<typeof capabilityBecomeMintedPayload>;

export const capabilityRevokedPayload = z.object({
  capabilityId,
  entity: entityRef,
  revokedBy: principalId,
});
export type CapabilityRevokedPayload = z.infer<typeof capabilityRevokedPayload>;

export const capabilityExercisedPayload = z.object({
  capabilityId,
  mode: z.enum(['act', 'become']),
  /** The count AFTER this exchange. */
  uses: z.number().int().positive(),
  maxUses: z.number().int().positive().nullable(),
  /** `act`: when the session this exchange handed out stops working. Null for `become`. */
  sessionExpiresAt: instant.nullable(),
  /** `become`: the principal the holder became. Null for `act`. */
  principal: principalId.nullable(),
});
export type CapabilityExercisedPayload = z.infer<typeof capabilityExercisedPayload>;
