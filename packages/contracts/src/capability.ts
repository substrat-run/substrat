import { z } from 'zod';
import { entityRef } from './events.js';
import { capabilityId, instant, permissionKey, platformActorId, principalId } from './ids.js';

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
 * Platform-only in this first cut, deliberately. `become` is impersonation by another name
 * — the holder acquires everything the principal holds — so the bound on who may mint one
 * from module code is designed with the invite and claim migrations, not guessed here.
 * Expiry and a use limit are REQUIRED for the same reason: an unbounded `become` is a
 * standing credential for a person.
 */
export const becomeCapabilityInput = z.object({
  principal: principalId,
  expiresAt: instant,
  maxUses: z.number().int().positive(),
  label: capabilityLabel.optional(),
});
export type BecomeCapabilityInput = z.infer<typeof becomeCapabilityInput>;

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

/** What narrows `ctx.capabilities.list`. Live capabilities only unless `includeRevoked`. */
export const capabilityFilter = z.object({
  entity: entityRef.optional(),
  includeRevoked: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type CapabilityFilter = z.infer<typeof capabilityFilter>;

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
