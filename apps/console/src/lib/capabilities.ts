import type { CapabilityRecord, CapabilityStatus } from '@substrat-run/contracts';
import type { BadgeTone } from './fleet';

/** The words for a capability's standing — contracts' `capabilityStatus`, in an operator's terms. */
export const STATUS_LABEL: Record<CapabilityStatus, string> = {
  live: 'Live',
  'used-up': 'Used up',
  expired: 'Expired',
  revoked: 'Revoked',
};

/**
 * Badge tone per standing. `used-up` is a warning rather than neutral: its secret cannot be
 * exchanged again, but sessions it already handed out keep acting until it expires or is
 * revoked — an operator hunting a leaked link should not read it as finished.
 */
export function capabilityTone(status: CapabilityStatus): BadgeTone {
  if (status === 'live') return 'success';
  if (status === 'used-up') return 'warning';
  if (status === 'revoked') return 'danger';
  return 'neutral';
}

/**
 * What the capability lets its holder do, in one line: the entity and EVERY key, or who they
 * become. Never a count — two links with different key sets on one entity must read
 * differently, because the keys are the whole of what a link grants.
 */
export function grantLine(r: CapabilityRecord): string {
  if (r.mode === 'become') return `becomes ${r.principal}`;
  return `${r.permissions.join(', ')} on ${r.entity.entityType}:${r.entity.entityId}`;
}

/** The operation allowlist, or the words for its absence. Only an `act` capability has one. */
export function operationsLine(r: CapabilityRecord): string {
  if (r.mode === 'become') return '—';
  return r.operations === null ? 'any the keys allow' : r.operations.join(', ');
}

/** Who minted or revoked it: a principal's id, or the platform actor behind `HostAdmin`. */
export function authorLine(a: CapabilityRecord['mintedBy']): string {
  return typeof a === 'string' ? a : `platform:${a.platform}`;
}

/** `n` or `n / max`. */
export function usesLine(r: CapabilityRecord): string {
  return r.maxUses === null ? String(r.uses) : `${r.uses} / ${r.maxUses}`;
}

/**
 * How much of the directory the card holds, in words — so a page that is not the whole walk
 * says so, and a card never reads as complete when it is not.
 */
export function coverageLine(shown: number, more: boolean): string {
  const noun = shown === 1 ? 'capability' : 'capabilities';
  return more ? `Showing the newest ${shown} ${noun}; older ones follow.` : `${shown} ${noun}.`;
}

/**
 * Append the next page to what the card already holds. A page can overlap the rows shown
 * only if the server repeats one, which keyset paging does not — but a duplicate row in an
 * operator's table reads as two links, so the append is by id rather than by trust.
 */
export function appendPage(held: CapabilityRecord[], next: CapabilityRecord[]): CapabilityRecord[] {
  const have = new Set(held.map((r) => r.id));
  return [...held, ...next.filter((r) => !have.has(r.id))];
}
