/**
 * The principal a signed-in subject is in a scope, for a vertical that resolves its own callers
 * rather than through vertical-host's `workerDoor` (which runs the same two steps, then a member
 * invite by address, in its `admit`).
 */
import type { IdentityStub } from './identity-do.js';
import { verifiedEmailOf } from './oidc-rp-provider.js';
import type { AuthSubject } from './provider.js';

/**
 * `subject`'s principal in `scopeId`: the one it is bound to (claiming an open first-sign-in
 * window, as `resolvePrincipal` does), else the owner seat a manager reserved for the address the
 * subject's issuer verified (#3202, `claimOwnerByAddress`). Null when neither binds it. A seat
 * reserved for no address is untouched by the second step, so a vertical that never passes
 * `ownerEmail` behaves exactly as it did with `resolvePrincipal` alone.
 */
export async function resolveSignedIn(
  directory: Pick<IdentityStub, 'resolvePrincipal' | 'claimOwnerByAddress'>,
  scopeId: string,
  subject: AuthSubject,
): Promise<string | null> {
  const principal = await directory.resolvePrincipal(scopeId, subject.sub);
  if (principal !== null) return principal;
  const email = verifiedEmailOf(subject);
  return email === null ? null : directory.claimOwnerByAddress(scopeId, subject.sub, email);
}
