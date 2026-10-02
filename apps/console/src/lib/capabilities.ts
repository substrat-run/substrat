import { capabilityStatus, type CapabilityRecord, type CapabilityStatus } from '@substrat-run/contracts';
import { switchCardState, type SwitchCardState } from './schedules';

/**
 * The Capabilities card's state (#1686): the staff read of a scope's link-share directory,
 * through the switches' three-outcome fetch, so a control plane that predates the route (501)
 * is its own state and never "no capabilities".
 */
export type CapabilitiesCardState = SwitchCardState<CapabilityRecord>;

export function capabilitiesCardState(
  entries: CapabilityRecord[] | null,
  error: unknown,
): CapabilitiesCardState {
  return switchCardState(entries, error);
}

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
export function statusTone(status: CapabilityStatus): 'success' | 'warning' | 'neutral' | 'danger' {
  if (status === 'live') return 'success';
  if (status === 'used-up') return 'warning';
  if (status === 'revoked') return 'danger';
  return 'neutral';
}

export const standingOf = (r: CapabilityRecord, now: string): CapabilityStatus => capabilityStatus(r, now);

/** What the capability lets its holder do, in one line: the entity and keys, or who they become. */
export function grantLine(r: CapabilityRecord): string {
  if (r.mode === 'become') return `becomes ${r.principal}`;
  const keys = r.permissions.length === 1 ? r.permissions[0] : `${r.permissions.length} keys`;
  return `${keys} on ${r.entity.entityType}:${r.entity.entityId}`;
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
