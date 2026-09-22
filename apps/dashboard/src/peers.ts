import type { PeerGrantsStatusEntry, Scope, TenantId } from '@substrat-run/contracts';
import { resolveVerticalInstanceFrom, type VerticalInstanceCandidate } from '@substrat-run/kernel';

/**
 * The install disclosure (#1706) — what a tenant is told about one app's reach into its
 * OTHER apps, on the app's own page and at install.
 *
 * The question a tenant actually has is "what can this app reach, and can I stop it", and
 * answering it needs two facts that live apart: what the app's running version DECLARES it
 * calls (`substrat.calls`, the caller's half) and where the peer switch stands in the
 * TARGET's scope (the target's half, which is the only one that decides anything). This
 * module joins them, purely, so the rule is testable without a control plane.
 *
 * The rule that matters most is the quiet one: **a target the tenant has not installed is
 * not an error.** Declaring a call on an app you do not run is the ordinary state of a
 * freshly-installed vertical, and rendering it as a failure would teach tenants to ignore
 * this panel — which is the panel that also has to be believed when it says "switched off".
 */

/** Where ONE declared target stands, from the tenant's point of view. */
export type DeclaredCallState =
  /** The tenant runs no instance of that vertical. Nothing is wrong; nothing can be called. */
  | { state: 'not-installed'; vertical: string }
  | { state: 'ambiguous'; vertical: string; count: number }
  /** Installed, and this app is admitted at its door right now. */
  | { state: 'allowed'; vertical: string; scopeId: string }
  /** Installed, and this app is switched off there — by someone, for a reason, at a time. */
  | {
      state: 'switched-off';
      vertical: string;
      scopeId: string;
      switchedOff: PeerGrantsStatusEntry['switchedOff'];
    }
  /** Installed, but the target's scope holds no grant for this app at all. */
  | { state: 'no-grant'; vertical: string; scopeId: string }
  /**
   * Installed, and the target's position could not be READ — a deployment predating the
   * route, or a scope whose grants the platform could not reach. Its own state, never
   * folded into `allowed`: a tenant told "allowed" believes a thing nobody checked.
   */
  | { state: 'unreadable'; vertical: string; scopeId: string; message: string };

/**
 * The tenant's one instance of `vertical`, by the kernel's own rule — the SAME
 * `resolveVerticalInstanceFrom` a peer call resolves with, so the panel cannot claim a
 * target a call would not reach, or vice versa. A tenant running two live instances is
 * `ambiguous`, which a call refuses and the panel names explicitly.
 */
export function targetScopeOf(
  scopes: readonly Scope[],
  tenantId: TenantId,
  vertical: string,
): { scopeId: string } | { ambiguous: true; count: number } | null {
  const resolution = resolveVerticalInstanceFrom(scopes as unknown as VerticalInstanceCandidate[], tenantId, vertical);
  if (resolution.outcome === 'resolved') return { scopeId: resolution.instance.scopeId };
  if (resolution.outcome === 'ambiguous') return { ambiguous: true, count: resolution.count };
  return null;
}

/**
 * One declared target's state, given the target's own peer read.
 *
 * `entries` is what `GET .../peer-grants` answered for the TARGET's scope, and `caller` is
 * the app doing the declaring. A target that resolved but whose read failed carries its
 * message rather than a position.
 */
export function declaredCallState(input: {
  vertical: string;
  caller: string;
  target: { scopeId: string } | { ambiguous: true; count: number } | null;
  entries: PeerGrantsStatusEntry[] | null;
  readError?: string | null;
}): DeclaredCallState {
  const { vertical, caller, target } = input;
  if (target === null) return { state: 'not-installed', vertical };
  if ('ambiguous' in target) return { state: 'ambiguous', vertical, count: target.count };
  const { scopeId } = target;
  if (input.readError) return { state: 'unreadable', vertical, scopeId, message: input.readError };
  if (input.entries === null) return { state: 'unreadable', vertical, scopeId, message: 'not read' };
  const entry = input.entries.find((e) => e.vertical === caller);
  // Installed, but the target's scope holds nothing for this caller. Not an error either:
  // the target's manifest may not declare this peer, or its scope may predate the version
  // that does. Distinct from `switched-off`, which somebody did on purpose.
  if (!entry || entry.calls === 'ungranted') return { state: 'no-grant', vertical, scopeId };
  if (entry.calls === 'off') return { state: 'switched-off', vertical, scopeId, switchedOff: entry.switchedOff };
  return { state: 'allowed', vertical, scopeId };
}

/** The one-line sentence each state is shown as — a tenant's words, never the tuple store's. */
export function declaredCallLine(entry: DeclaredCallState): string {
  switch (entry.state) {
    case 'not-installed':
      return `Not installed here — this app declares it calls ${entry.vertical}, and you do not run one.`;
    case 'ambiguous':
      return `${entry.count} active instances of ${entry.vertical} — calls are refused until one target can be resolved.`;
    case 'allowed':
      return `May call ${entry.vertical}, with the permissions that app's own manifest grants it.`;
    case 'switched-off':
      return `Switched off — ${entry.vertical} refuses this app's calls until you let it back in.`;
    case 'no-grant':
      return `${entry.vertical} grants this app nothing — its calls are refused at the door.`;
    case 'unreadable':
      return `Could not read where this stands at ${entry.vertical}: ${entry.message}`;
  }
}

/**
 * Ambiguous targets, missing grants and unreadable positions need attention. An absent
 * target is an ordinary install state and does not — see the module comment.
 */
export function declaredCallNeedsAttention(entry: DeclaredCallState): boolean {
  return entry.state === 'ambiguous' || entry.state === 'no-grant' || entry.state === 'unreadable';
}
