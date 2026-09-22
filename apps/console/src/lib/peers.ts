import type { PeerGrantsStatusEntry } from '@substrat-run/contracts';
import { switchCardState, type SwitchCardState } from './schedules';

/**
 * The Peers card's state (#1706), derived from the status read
 * (`GET .../peer-grants`) — which of a tenant's OTHER apps may call into this scope, and
 * where each stands.
 *
 * Deliberately the schedule switch's state machine (`switchCardState`) rather than a
 * lookalike: both reads normalize a deployment that predates their route to a **501**, and
 * both must render that as its own state rather than as an error and never as `on`. Two
 * copies of that rule would be two chances to get it wrong on the card that matters more —
 * a peer wrongly shown as switched off is a support ticket, a peer wrongly shown as on is a
 * tenant believing it cut off access it did not cut off.
 */
export type PeersCardState = SwitchCardState<PeerGrantsStatusEntry>;

export function peersCardState(entries: PeerGrantsStatusEntry[] | null, error: unknown): PeersCardState {
  return switchCardState(entries, error);
}

/**
 * Badge tone for one peer's position — the same three-way split the kernel's
 * `subjectGrantState` enumerates, and the same tones the schedules card uses, so an
 * operator reading a scope does not learn two colour languages.
 */
export function peerBadgeStatus(calls: PeerGrantsStatusEntry['calls']): 'success' | 'danger' | 'neutral' {
  if (calls === 'on') return 'success';
  if (calls === 'off') return 'danger';
  return 'neutral';
}

/**
 * What the card says one position MEANS, in a tenant's words rather than the tuple store's.
 * `ungranted` is the one that needs saying out loud: it is not "switched off" and not an
 * error — the scope holds a row for the peer but nothing live, which happens when a scope
 * predates the manifest version declaring it. Left unexplained it reads as a fault.
 */
export function peerStateLabel(calls: PeerGrantsStatusEntry['calls']): string {
  if (calls === 'on') return 'Grants active';
  if (calls === 'off') return 'Switched off';
  return 'Holds nothing here';
}

/**
 * A peer that is off, rendered as the one sentence an operator needs: who, when, why.
 * `null` when the peer is not off, or when it is off with no explanation still in force —
 * which is a real state (a switch applied before the log recorded a reason, or a grant
 * removed by something other than the switch), and must not be rendered as an empty quote.
 */
export function switchedOffLine(entry: PeerGrantsStatusEntry): string | null {
  if (entry.calls !== 'off' || !entry.switchedOff) return null;
  const { actor, reason, at } = entry.switchedOff;
  return `Switched off by ${actor} on ${at} — ${reason}`;
}
