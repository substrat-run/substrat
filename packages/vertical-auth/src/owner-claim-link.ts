/**
 * The claim-link half of the owner seat (#925), from the worker's side: mint a token,
 * hand its HASH to the identity directory, and return the URL the installer opens. Written
 * once here so each vertical's `mintOwnerClaim` hook is a one-liner, and so the token shape,
 * the hash and the URL convention (`/?claim=<token>`, the SPA's counterpart to `?invite=`)
 * are one fact rather than four copies.
 */

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

/**
 * Mint a claim link for a scope's unclaimed owner seat. `origin` is the instance's public
 * origin — supplied by the platform, which owns the hostname directory; a `/internal` call
 * reaches the worker through the dispatcher and carries no usable host of its own. Null ⇒
 * the seat is already claimed (or unknown), and there is nothing to mint for.
 */
export async function mintOwnerClaimLink(
  directory: { mintOwnerClaim(scopeId: string, tokenHash: string): Promise<{ expiresAt: string } | null> },
  scopeId: string,
  origin: string,
): Promise<{ claimUrl: string; expiresAt: string } | null> {
  const token = claimToken();
  const minted = await directory.mintOwnerClaim(scopeId, await sha256Hex(token));
  if (!minted) return null;
  return { claimUrl: `${origin.replace(/\/$/, '')}${ownerClaimPath(token)}`, expiresAt: minted.expiresAt };
}
