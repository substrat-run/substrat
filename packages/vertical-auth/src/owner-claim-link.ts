/**
 * The claim-link half of the owner seat (#925), from the worker's side: mint the link, tell the
 * identity directory which link is current, and return the URL the installer opens. Written once
 * here so each vertical's `mintOwnerClaim` hook is a one-liner, and so the link's shape and the
 * URL convention (`/?claim=<secret>`, the SPA's counterpart to `?invite=`) are one fact rather
 * than four copies. Since #1686 the link is a `become` capability (see `mintOwnerClaimLink`).
 */

import {
  capabilityId,
  instant,
  platformActorId,
  principalId,
  type BecomeCapabilityInput,
  type CapabilityId,
  type MintedCapability,
  type PlatformActorId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { capabilityTokenHash } from '@substrat-run/kernel';
import type { IdentityStub } from './identity-do.js';
import { OWNER_CLAIM_TTL_MS } from './owner-seat.js';

/** SHA-256 hex (Web Crypto — the same call in workerd, node and browsers). */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A long, URL-safe token: two UUIDs = 256 bits of entropy. Only its hash is ever stored. */
export function claimToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
}

/** The path a claim token rides on — what the SPA reads back as `?claim=`. */
export function ownerClaimPath(token: string): string {
  return `/?claim=${encodeURIComponent(token)}`;
}

/** Its counterpart for a member invite — what the SPA reads back as `?invite=`. */
export function invitePath(token: string): string {
  return `/?invite=${encodeURIComponent(token)}`;
}

/** The label every owner claim link's capability carries — what an operator's capability read shows. */
export const OWNER_CLAIM_LABEL = 'owner claim link';

/**
 * The minter recorded when the platform names none — a control plane from before #1686 sends no
 * `actor`. The zero ULID: a platform actor id that is no one, rather than one made up per call.
 * The control plane's admin log, not this record, is where who-asked is kept either way.
 */
export const UNATTRIBUTED_PLATFORM_ACTOR: PlatformActorId = platformActorId.parse('00000000000000000000000000');

/**
 * What minting a claim link needs of the scope host: the platform's `become` mint and revoke on
 * the CP-less path, in the deployment that serves the scope (`@substrat-run/adapter-cloudflare`'s
 * `CloudflareScopeHost` has both). Neither is a module verb.
 */
export interface OwnerClaimMintHost {
  mintCapabilityLocal(
    tenantId: TenantId,
    scopeId: ScopeId,
    input: BecomeCapabilityInput,
    actor: PlatformActorId,
  ): Promise<MintedCapability>;
  revokeCapabilityLocal(scopeId: ScopeId, capabilityId: CapabilityId, actor: PlatformActorId): Promise<boolean>;
}

/** The slice of the identity directory a mint touches. */
export type OwnerClaimMintDirectory = Pick<IdentityStub, 'ownerClaimTarget' | 'recordOwnerClaim'>;

/**
 * Mint a claim link for a scope's unclaimed owner seat (#925) — since #1686 a `become` capability:
 * whoever exchanges its secret becomes the pending owner, once (`maxUses: 1`), until
 * `OWNER_CLAIM_TTL_MS` from now. `origin` is the instance's public origin — supplied by the
 * platform, which owns the hostname directory; a `/internal` call reaches the worker through the
 * dispatcher and carries no usable host of its own. Null ⇒ the seat is already claimed (or
 * unknown), and there is nothing to mint for.
 *
 * Three writes in two Durable Objects, ordered so every partial failure fails closed:
 *   1. the scope mints the capability — on its own it redeems nothing, because a redemption
 *      must name the capability the identity directory records;
 *   2. the directory records it as THE link, which retires the previous one there (and deletes a
 *      legacy hash link outright). A seat claimed in the meantime records nothing, and the
 *      capability just minted is revoked;
 *   3. the scope revokes the previous capability, so it is dead in the scope's own directory too
 *      — and shows as revoked to an operator. Step 2 already refuses it if this does not land.
 */
export async function mintOwnerClaimLink(
  deps: { directory: OwnerClaimMintDirectory; host: OwnerClaimMintHost },
  ref: { tenantId: TenantId; scopeId: ScopeId },
  origin: string,
  actor: PlatformActorId = UNATTRIBUTED_PLATFORM_ACTOR,
): Promise<{ claimUrl: string; expiresAt: string } | null> {
  const principal = await deps.directory.ownerClaimTarget(ref.scopeId);
  if (principal === null) return null;
  const minted = await deps.host.mintCapabilityLocal(
    ref.tenantId,
    ref.scopeId,
    {
      principal: principalId.parse(principal),
      expiresAt: instant.parse(new Date(Date.now() + OWNER_CLAIM_TTL_MS).toISOString()),
      maxUses: 1,
      label: OWNER_CLAIM_LABEL,
    },
    actor,
  );
  if (minted.expiresAt === null) throw new Error('a become capability always expires — the host answered none');
  const recorded = await deps.directory.recordOwnerClaim(ref.scopeId, principal, {
    capabilityId: minted.id,
    tokenHash: await capabilityTokenHash(minted.secret),
    expiresAt: Date.parse(minted.expiresAt),
  });
  if (!recorded) {
    await deps.host.revokeCapabilityLocal(ref.scopeId, minted.id, actor);
    return null;
  }
  if (recorded.previous !== null) {
    await deps.host.revokeCapabilityLocal(ref.scopeId, capabilityId.parse(recorded.previous), actor);
  }
  return { claimUrl: `${origin.replace(/\/$/, '')}${ownerClaimPath(minted.secret)}`, expiresAt: minted.expiresAt };
}
