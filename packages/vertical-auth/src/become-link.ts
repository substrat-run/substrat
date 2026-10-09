/**
 * Redeeming a `become` link (#1686) — the one order an owner claim link and a member invite share,
 * so the rule that keeps a stale secret's use unspent is written once:
 *   1. the directory says the secret's hash is a live link of its kind, BEFORE the scope is asked —
 *      a withdrawn, consumed or unrelated secret is refused here without spending its use;
 *   2. the scope exchanges it as a `become` capability — expiry, revocation and the single use
 *      judged atomically in its own storage, the exchange on the spine;
 *   3. the directory binds, only while the link still names that capability and principal.
 * Null for every refusal, so a probe learns nothing about which step said no.
 */
import type { CapabilityExchange, CapabilityId, PrincipalId } from '@substrat-run/contracts';
import { capabilityTokenHash, plausibleCapabilitySecret } from '@substrat-run/kernel';

export async function redeemBecomeLink(
  steps: {
    matches: (tokenHash: string) => Promise<boolean>;
    exchange: (secret: string) => Promise<CapabilityExchange | null>;
    bind: (capabilityId: CapabilityId, principal: PrincipalId) => Promise<string | null>;
  },
  secret: string,
): Promise<string | null> {
  if (!plausibleCapabilitySecret(secret)) return null;
  if (!(await steps.matches(await capabilityTokenHash(secret)))) return null;
  const exchanged = await steps.exchange(secret);
  if (exchanged?.kind !== 'principal') return null;
  return steps.bind(exchanged.capabilityId, exchanged.principal);
}
